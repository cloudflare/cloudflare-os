import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";
import { applyCodeChange, diffFiles, type CodeContent, type CodeChange } from "@gadgets/workshop-shared/code-change";
import type { WorktreeChangeEvent, WorktreeReplicaBatch } from "@gadgets/workshop-shared/agent-integration";
import { WorktreeReplicaSession, type WorktreeReplicaHost, type WorktreeReplicaLease,
  type WorktreeReplicaCommit } from "../src/worktree-replica";
import { workspaceCollisionCases } from "./workspace-collision-cases";
import { replicaTextHash } from "../src/workspace-replica";
import type { IntegrationTestActionGatekeeper } from "./test-worker";
import { foldCompactedCode } from "../src/agent-compaction";
import { decodePackStream } from "../src/git-codec";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}

describe("kernel replica capability over native RPC", () => {
  it.each([[false, false], [true, false], [true, true]])(
    "keeps the remote base across accepts, with pending edits %s and compaction %s", async (pending, compact) => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance["impl"];
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
      try {
        impl.storage.chatMeta.put({ id: 1, title: "Accepted replica", started: Date.now(), lastActive: Date.now() });
        const commit = await impl.gitStore.writeFilesAsCommit(new Map([
          ["a.txt", "base\n"], ["gone.txt", "delete me\n"], ["untouched.txt", "unchanged\n"],
        ]), { parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0) });
        const exports = impl.ctx.exports as typeof impl.ctx.exports & {
          IntegrationTestActionGatekeeper(options: {props: Record<string, never>}): DurableObjectClass<IntegrationTestActionGatekeeper>;
        };
        const cls = exports.IntegrationTestActionGatekeeper({props: {}});
        impl.storage.gatekeepers.put({id: 31, class: cls, creationSpec: {type: "ambient", vendorId: "container"}});
        const source = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("gatekeeper31", () => ({class: cls}));
        await source.allowGitCommit(commit);
        impl.storage.gitObjectMetadata.put({oid: commit, type: "commit", onRemote: [31], pullableFrom: [], pendingPush: []});
        const tree = await impl.createWorktree("Repo", 1, commit);
        impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}});
        const step = async (change: CodeChange, created = false) => impl.commitAgentStep(1,
          {type: "agent", id: "test", name: "Test"}, [], {
            changes: [{change}], createdGadgets: [], addedBindings: [], worktreeCommits: [], blueprintMerges: [],
            createdWorktrees: created ? [{worktreeId: tree.id, title: tree.title, bindingName: "REPO"}] : [],
          });
        await step({[tree.id]: [["a.txt", {set: "accepted\n"}], ["new.txt", {set: "accepted new\n"}],
          ["gone.txt", {remove: true}]]}, true);
        expect(await impl.mergeChanges(1, {profile: {type: "user", id: "test", name: "Test"}}, "test-user"))
          .toEqual({outcome: "merged"});
        const accepted = impl.storage.gadgets.get(tree.id)!;
        if (accepted.type !== "worktree") throw new Error("Expected a worktree");
        expect(accepted.pinBase).not.toBe(commit);
        expect(accepted.headCommit).toBe(commit);
        expect(impl.storage.gitObjectMetadata.get(accepted.pinBase)?.onRemote ?? []).toEqual([]);
        let explicitHead = commit;
        if (compact) {
          explicitHead = await impl.gitStore.writeCommitForTree(await impl.gitStore.commitTree(accepted.pinBase), {
            parents: [commit], author: {name: "Test", email: "test@example.com"}, message: "Explicit commit", timestamp: new Date(1),
          });
          impl.storage.gadgets.put({...accepted, headCommit: explicitHead});
        }
        if (pending) await step(diffFiles(new Map([[tree.id, new Map([["a.txt", "accepted\n"]])]]),
          new Map([[tree.id, new Map([["a.txt", "accepted\npending\n"]])]])));
        if (compact) {
          const history = impl.loadChatHistory(1);
          const compactedTo = Math.max(...history.chatMessages.map(message => message.sequence)) + 1;
          impl.commitChatCompaction(1, {
            chatId: 1, compactedTo, summary: "Retain the pending edit", chatBindings: [],
            nextChangeId: 1, ...foldCompactedCode(history.chatMessages, compactedTo, undefined),
          });
          expect(impl.loadChatHistory(1).chatMessages).toEqual([]);
        }
        await impl.beginAgentIntegrationTurn(1);
        const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1})!;
        const replica = await impl.getIntegrationContext(31, origin)!.openWorktreeReplica();
        const checkpoint = await replica.checkpoint();
        expect(checkpoint.worktrees[0].baseCommit).toBe(commit);
        expect(checkpoint.worktrees[0].acceptedCommit).toBe(accepted.pinBase);
        expect(checkpoint.worktrees[0].headCommit).toBe(explicitHead);
        expect(await new Response(await replica.readGitPack(checkpoint.checkpointId, tree.id, Uint8Array.of(1, 255))).arrayBuffer())
          .toEqual(Uint8Array.of(1, 255).buffer);
        expect(await new Response(await replica.readBaseFile(checkpoint.checkpointId, tree.id, "a.txt")).text()).toBe("base\n");
        const cursor = await replica.readOverlay(checkpoint.checkpointId);
        const expected = pending ? "accepted\npending\n" : "accepted\n";
        const overlay = await cursor.next();
        expect(overlay ?? []).toHaveLength(pending ? 1 : 0);
        const imported = [];
        for await (const object of decodePackStream(await replica.readCommitPack(checkpoint.checkpointId, tree.id), {
          maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024,
          resolveBase: oid => impl.gitCache.readLocalObject(oid),
        })) imported.push(object);
        expect(imported.some(object => object.oid === accepted.pinBase)).toBe(true);
        expect(imported.some(object => object.oid === commit)).toBe(true);
        if (compact) expect(imported.some(object => object.oid === explicitHead)).toBe(true);
        // The native clone already contains unchanged upstream blobs; never retransmit them.
        const untouched = await impl.gitCache.pathEntryAtCommit(commit, "untouched.txt");
        expect(imported.some(object => object.oid === untouched!.oid)).toBe(false);
        await expect((async () => { await replica.readCommitPack(checkpoint.checkpointId, tree.id + 100); })())
          .rejects.toThrow(/outside/);
        expect(await cursor.next()).toBeNull();
        const receipt = await replica.submitBatch({batchId: "after-accept", baseCursor: checkpoint.cursor, files: [
          {checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash(expected),
            change: {edit: [expected.length, [0, "container", ""]]}},
          {checkoutId: tree.id, path: "new.txt", baseHash: await replicaTextHash("accepted new\n"),
            change: {set: "container new\n"}},
          {checkoutId: tree.id, path: "gone.txt", baseHash: null, change: {set: "recreated\n"}},
        ]});
        expect(receipt.accepted).toEqual([
          {checkoutId: tree.id, path: "a.txt", hash: await replicaTextHash(expected + "container\n")},
          {checkoutId: tree.id, path: "new.txt", hash: await replicaTextHash("container new\n")},
          {checkoutId: tree.id, path: "gone.txt", hash: await replicaTextHash("recreated\n")},
        ]);
        // Capturing and reconciling never materializes unrelated base blobs in the chat map.
        const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
        expect(content.get(tree.id)?.has("untouched.txt")).toBe(false);
        await replica.closeGitBootstrap(checkpoint.checkpointId);
        await expect((async () => { await replica.readCommitPack(checkpoint.checkpointId, tree.id); })())
          .rejects.toThrow(/closed/);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("exports only the selected base and atomically accepts a revocable, idempotent batch", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance["impl"];
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"contextualActions":true,"worktreeReplica":true}}';
      try {
        impl.storage.chatMeta.put({ id: 1, title: "Replica", started: Date.now(), lastActive: Date.now() });
        const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "one\ntwo\n"]]), {
          parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0),
        });
        const tree = await impl.createWorktree("Repo", 1, commit);
        impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}});
        impl.storage.gatekeepers.put({id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
          overseerId: impl.ctx.id.toString(), config: {displayName: "Replica fixture", modelId: null, env: {}},
        }}), creationSpec: {type: "ambient", vendorId: "container"}});
        await impl.beginAgentIntegrationTurn(1);
        const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1})!;
        const context = impl.getIntegrationContext(31, origin)!;
        const replica = await context.openWorktreeReplica();
        const checkpoint = await replica.checkpoint();
        expect(checkpoint.worktrees).toHaveLength(1);
        expect(checkpoint.worktrees[0].baseTree).toMatch(/^[a-f0-9]{40}$/);
        expect(await new Response(await replica.readBaseFile(checkpoint.checkpointId, tree.id, "a.txt")).text()).toBe("one\ntwo\n");
        const batch = {batchId: "native", baseCursor: checkpoint.cursor,
          files: [{checkoutId: tree.id, path: "a.txt", baseHash: await replicaTextHash("one\ntwo\n"),
            change: {edit: [4, [4, "THREE😀", ""]]}}]};
        const receipt = await replica.submitBatch(batch);
        expect(await replica.submitBatch(batch)).toEqual(receipt);
        const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
        expect(content.get(tree.id)?.get("a.txt")).toBe("one\nTHREE😀\n");
        expect(receipt.accepted).toEqual([{checkoutId: tree.id, path: "a.txt",
          hash: await replicaTextHash("one\nTHREE😀\n")}]);
        const page = await replica.changesSince(checkpoint.cursor, 128);
        expect(page.events.at(-1)?.sourceBatchId).toBe("native");
        expect(page.cursor).toBe(receipt.committedAt);
        const reopened = await context.openWorktreeReplica();
        expect((await reopened.checkpoint()).checkpointId).toBe(checkpoint.checkpointId);
        impl.env.AGENT_INTEGRATION_GRANTS = '{}';
        // Consume native RPC promises ourselves: assertion-library Promise probing can
        // create an additional, unobserved pipelined call on a Workers RpcPromise.
        await expect((async () => { await replica.renew(); })()).rejects.toThrow(/revoked/);
        await expect((async () => { await replica.readBaseFile(checkpoint.checkpointId, tree.id, "a.txt"); })()).rejects.toThrow(/revoked/);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });
});

function fixture(before: string | null = "one\ntwo\n") {
  let lease: WorktreeReplicaLease = { id: "lease", gatekeeperId: 1, chatId: 2, turnId: "turn",
    expiresAt: Date.now() + 60_000, worktrees: [{ checkoutId: 7, binding: "REPO",
      baseCommit: "commit", baseTree: "tree", source: "repository" }] };
  const initial = new Map<string, string>(before === null ? [] : [["a.txt", before]]);
  let content: CodeContent = new Map([[7, new Map(initial)]]);
  const events: WorktreeChangeEvent[] = [], commits = new Map<string, WorktreeReplicaCommit>();
  let revision = 0, commitFailures = 0;
  let beforeRead: (() => void | Promise<void>) | undefined;
  const cursor = () => `cursor-${revision}`;
  const append = (change: CodeChange, sourceBatchId?: string) => {
    content = applyCodeChange(content, change);
    events.push({ cursor: `cursor-${++revision}`, sourceBatchId,
      changes: Object.entries(change).flatMap(([id, changes]) => changes.map(([path, change]) =>
        ({ checkoutId: Number(id), path, change }))) });
  };
  const requireLive = () => {
    if (lease.released || lease.expiresAt <= Date.now()) throw new Error("lease expired");
    return lease;
  };
  const host: WorktreeReplicaHost = {
    requireLease: requireLive, saveLease: value => { lease = value; },
    capture: async () => ({ cursor: "cursor-0", overlay: [] }),
    assertPathWritable: async () => {},
    entries: async () => [...initial].map(([path]) => ({ path, mode: "100644", oid: "blob" })),
    baseFile: async (_lease, id, path) => {
      if (id !== 7 || !initial.has(path)) throw new Error("missing file");
      if (beforeRead) { const fn = beforeRead; beforeRead = undefined; await fn(); }
      return new TextEncoder().encode(initial.get(path)!);
    },
    events: (_lease, from, limit) => {
      const start = from === "cursor-0" ? 0 : events.findIndex(event => event.cursor === from) + 1;
      if (!start && from !== "cursor-0") throw new Error("unknown cursor");
      const page = events.slice(start, start + limit);
      return { events: page, cursor: page.at(-1)?.cursor ?? from, hasMore: start + page.length < events.length };
    },
    flush: async () => true,
    version: cursor, getCommit: id => commits.get(id),
    commit: async (_lease, expected, change, commit) => {
      requireLive();
      if (commitFailures > 0) { --commitFailures; return false; }
      if (cursor() !== expected) return false;
      append(change, commit.receipt.batchId);
      commit.receipt.committedAt = cursor();
      commits.set(commit.id, commit);
      return true;
    },
  };
  return { session: new WorktreeReplicaSession(host, "lease"), host, commits, events,
    get content() { return content; },
    remoteChange(change: CodeChange) { append(change); },
    remote(text: string | null) {
      append(diffFiles(content, new Map([[7, new Map(text === null ? [] : [["a.txt", text]])]])));
    },
    revoke() { lease = { ...lease, released: true }; },
    onRead(fn: () => void | Promise<void>) { beforeRead = fn; },
    failCommits(count: number) { commitFailures = count; },
  };
}

async function batch(before: string | null = "one\ntwo\n", after: string | null = "ONE\ntwo\n"): Promise<WorktreeReplicaBatch> {
  return {...await compactBatch(before, after), batchId: "batch"};
}
async function compactBatch(before: string | null, after: string | null): Promise<WorktreeReplicaBatch> {
  const code = (text: string | null): CodeContent => new Map([[7, new Map(text === null ? [] : [["a.txt", text]])]]);
  return {batchId: "compact", baseCursor: "cursor-0", files: [{checkoutId: 7, path: "a.txt",
    baseHash: await replicaTextHash(before), change: diffFiles(code(before), code(after))[7]?.[0]?.[1] ?? null}]};
}

describe("scoped native worktree replica protocol", () => {
  it.each(["journal", "checkpoint"])("reconstructs removed/replaced binary anchors from the %s without decoding the old base", async source => {
    const f = fixture("\0binary");
    const removed: WorktreeChangeEvent["changes"][number] = {checkoutId: 7, path: "a.txt", change: {remove: true}};
    if (source === "checkpoint") {
      f.remoteChange({7: [["a.txt", removed.change]]});
      f.host.capture = async () => ({cursor: "cursor-1", overlay: [removed]});
      await f.session.checkpoint();
    } else {
      await f.session.checkpoint();
      f.remoteChange({7: [["a.txt", removed.change]]});
    }
    const readBase = vi.fn(async () => {throw new Error("must not read superseded binary base");});
    f.host.baseFile = readBase;
    f.host.baseBytes = readBase;
    expect(await f.session.readByteAnchor(7, "a.txt", "cursor-1")).toEqual({value: null, version: null});
    const unchanged = await f.session.submitBatch({batchId: "absent", baseCursor: "cursor-1", files: [
      {checkoutId: 7, path: "a.txt", baseHash: null, change: null},
    ]});
    expect(unchanged.accepted[0].hash).toBeNull();
    const created = await f.session.submitBatch({batchId: "recreate", baseCursor: unchanged.committedAt, files: [
      {checkoutId: 7, path: "a.txt", baseHash: null, change: {set: "hello"}},
    ]});
    await f.session.submitBatch({batchId: "edit-text", baseCursor: created.committedAt, files: [
      {checkoutId: 7, path: "a.txt", baseHash: await replicaTextHash("hello"), change: {edit: [5, [0, "!"]]}},
    ]});
    expect(f.content.get(7)?.get("a.txt")).toBe("hello!");
    expect(readBase).not.toHaveBeenCalled();
  });

  it("rejects oversized canonical correction receipts before the barrier and permits a bounded retry", async () => {
    const f = fixture(null);
    await f.session.checkpoint();
    const paths = Array.from({length: 5}, (_, i) => `file-${i}.txt`);
    for (const path of paths) f.remoteChange({7: [[path, {set: "漢".repeat(220_000)}]]});
    const input: WorktreeReplicaBatch = {batchId: "large-receipt", baseCursor: "cursor-0",
      files: paths.map(path => ({checkoutId: 7, path, baseHash: null, change: null}))};
    expect(JSON.stringify(input).length).toBeLessThan(1000);
    const commit = vi.spyOn(f.host, "commit");
    await expect(f.session.submitBatch(input)).rejects.toThrow(/receipt exceeds its budget/);
    expect(commit).not.toHaveBeenCalled();
    expect(f.commits.size).toBe(0);
    // Rejected IDs were not consumed, and smaller receipts remain writable/idempotent.
    const retry = {...input, files: input.files.slice(0, 1)};
    const receipt = await f.session.submitBatch(retry);
    expect(receipt.accepted).toEqual([{checkoutId: 7, path: paths[0], hash: await replicaTextHash("漢".repeat(220_000))}]);
    expect(await f.session.submitBatch(retry)).toEqual(receipt);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each(workspaceCollisionCases)("keeps compact OTs on the existing collision policy for $name", async collision => {
    const f = fixture(collision.before); await f.session.checkpoint();
    f.remote(collision.doText);
    const input = await compactBatch(collision.before, collision.shellText);
    const receipt = await f.session.submitBatch(input);
    expect(receipt.accepted).toEqual([{checkoutId: 7, path: "a.txt", hash: await replicaTextHash(collision.expected)}]);
    expect(f.content.get(7)?.get("a.txt") ?? null).toBe(collision.expected);
    expect(await f.session.submitBatch(input)).toEqual(receipt);
    expect(f.commits.size).toBe(1);
  });
  it("does not round-trip full text for a tiny edit to a large file, even with concurrent DO edits", async () => {
    const before = "x".repeat(300_000), f = fixture(before);
    await f.session.checkpoint();
    const input = await compactBatch(before, "y" + before.slice(1));
    f.remote(before.slice(0, -1) + "z");
    const receipt = await f.session.submitBatch(input);
    expect(JSON.stringify(input).length).toBeLessThan(1000);
    expect(JSON.stringify(receipt).length).toBeLessThan(1000);
    expect(f.content.get(7)?.get("a.txt")).toBe("y" + before.slice(1, -1) + "z");
  });
  it("replays the actual canonical operations when equal bytes admit a different diff", async () => {
    const f = fixture("aaa"); await f.session.checkpoint();
    f.remoteChange({7: [["a.txt", {edit: [[0, "a"], 3]}]]});
    const receipt = await f.session.submitBatch({batchId: "position", baseCursor: "cursor-0", files: [
      {checkoutId: 7, path: "a.txt", baseHash: await replicaTextHash("aaa"),
        change: {edit: [[0, "X"], 3]}},
    ]});
    expect(f.content.get(7)?.get("a.txt")).toBe("aXaaa");
    expect(receipt.accepted[0].hash).toBe(await replicaTextHash("aXaaa"));
  });
  it("rejects forged compact anchors and invalid transforms without committing", async () => {
    const f = fixture(); await f.session.checkpoint();
    const input = await compactBatch("one\ntwo\n", "ONE\ntwo\n");
    await expect(f.session.submitBatch({...input, files: [{checkoutId: 7, path: "a.txt", baseHash: null,
      change: {edit: [8]}}]})).rejects.toThrow(/anchor/);
    await expect(f.session.submitBatch({...input, files: [{...input.files[0], change: {edit: [99]}}]}))
      .rejects.toThrow(/length/);
    expect(f.commits.size).toBe(0);
  });
  it("distinguishes missing and empty anchors and preserves unchanged absent paths", async () => {
    const f = fixture(null); await f.session.checkpoint();
    const input = await compactBatch(null, null);
    f.remote("DO creation");
    expect((await f.session.submitBatch(input)).accepted).toEqual([
      {checkoutId: 7, path: "a.txt", hash: await replicaTextHash("DO creation")}]);
    const g = fixture(""); await g.session.checkpoint();
    await expect(g.session.submitBatch(input)).rejects.toThrow(/anchor/);
    const h = fixture("\ufeff😀\r\n"); await h.session.checkpoint();
    await h.session.submitBatch(await compactBatch("\ufeff😀\r\n", "\ufeff😁\r\n"));
    expect(h.content.get(7)?.get("a.txt")).toBe("\ufeff😁\r\n");
  });
  it("closes Git bootstrap independently of ongoing OT replication", async () => {
    const f = fixture();
    let calls = 0;
    f.host.gitPack = async (_lease, checkoutId, request) => {
      expect(checkoutId).toBe(7); ++calls;
      return new Response(request).body!;
    };
    const checkpoint = await f.session.checkpoint();
    const bytes = Uint8Array.of(0, 255, 128);
    expect(new Uint8Array(await new Response(await f.session.readGitPack(checkpoint.checkpointId, 7, bytes)).arrayBuffer())).toEqual(bytes);
    await expect(f.session.readGitPack(checkpoint.checkpointId, 99, bytes)).rejects.toThrow();
    await expect(f.session.readGitPack(checkpoint.checkpointId, 7, new Uint8Array(65537))).rejects.toThrow();
    await f.session.closeGitBootstrap(checkpoint.checkpointId);
    await expect(f.session.readGitPack(checkpoint.checkpointId, 7, bytes)).rejects.toThrow(/closed|revoked/);
    await f.session.submitBatch(await batch());
    expect(calls).toBe(1);
  });

  it.each(["closed", "expired"])("cancels an in-flight Git pack if authority becomes %s", async kind => {
    const f = fixture(), checkpoint = await f.session.checkpoint();
    let canceled = false;
    f.host.gitPack = async () => {
      if (kind === "closed") await f.session.closeGitBootstrap(checkpoint.checkpointId);
      else f.revoke();
      return new ReadableStream({cancel() {canceled = true;}});
    };
    await expect(f.session.readGitPack(checkpoint.checkpointId, 7, Uint8Array.of(1))).rejects.toThrow();
    expect(canceled).toBe(true);
  });
  it("exports the immutable base and checkpoint overlay separately", async () => {
    const f = fixture();
    const checkpoint = await f.session.checkpoint();
    const entries = await f.session.listBaseEntries(checkpoint.checkpointId, 7);
    expect(await entries.next()).toEqual([{ path: "a.txt", mode: "100644", oid: "blob" }]);
    expect(await entries.next()).toBeNull();
    const overlay = await f.session.readOverlay(checkpoint.checkpointId);
    expect(await overlay.next()).toBeNull();
    expect(await new Response(await f.session.readBaseFile(checkpoint.checkpointId, 7, "a.txt")).text()).toBe("one\ntwo\n");
    await expect(f.session.readBaseFile(checkpoint.checkpointId, 99, "a.txt")).rejects.toThrow(/outside/);
    await expect(f.session.readBaseFile("forged", 7, "a.txt")).rejects.toThrow(/checkpoint/);
  });
  it.each(workspaceCollisionCases)("preserves the existing OT outcome for $name", async collision => {
    const f = fixture(collision.before);
    await f.session.checkpoint();
    f.remote(collision.doText);
    const receipt = await f.session.submitBatch(await batch(collision.before, collision.shellText));
    expect(receipt.accepted[0]).toMatchObject({hash: await replicaTextHash(collision.expected)});
    expect(f.content.get(7)?.get("a.txt") ?? null).toBe(collision.expected);
    expect(f.commits.get("lease:batch")?.receipt).toEqual(receipt);
    // A receipt does not skip unrelated canonical events preceding the acceptance.
    const page = await f.session.changesSince("cursor-0", 1);
    expect(page.events[0].sourceBatchId).toBeUndefined();
    expect(page.hasMore).toBe(true);
    expect((await f.session.changesSince(page.cursor, 1)).events[0].sourceBatchId).toBe("batch");
  });
  it("binds an idempotency key to its exact payload and commits only once", async () => {
    const f = fixture(); await f.session.checkpoint();
    const receipt = await f.session.submitBatch(await batch());
    expect(await f.session.submitBatch(await batch())).toEqual(receipt);
    expect(f.commits.size).toBe(1); expect(f.events).toHaveLength(1);
    await expect(f.session.submitBatch(await batch("one\ntwo\n", "other"))).rejects.toThrow(/different payload/);
  });
  it("rejects forged anchors and duplicate paths without durable effects", async () => {
    const f = fixture(); await f.session.checkpoint();
    await expect(f.session.submitBatch(await batch("forged"))).rejects.toThrow(/anchor/);
    const input = await batch();
    await expect(f.session.submitBatch({...input, files: [input.files[0], input.files[0]]})).rejects.toThrow(/Duplicate/);
    await expect(f.session.submitBatch({...input, files: [{...input.files[0], checkoutId: 99}]})).rejects.toThrow(/ungranted/);
    expect(f.commits.size).toBe(0); expect(f.events).toEqual([]);
  });
  it("checks revocation after an awaited source read and on an already returned cursor", async () => {
    const f = fixture(), checkpoint = await f.session.checkpoint();
    const cursor = await f.session.listBaseEntries(checkpoint.checkpointId, 7);
    f.onRead(() => f.revoke());
    await expect(f.session.readBaseFile(checkpoint.checkpointId, 7, "a.txt")).rejects.toThrow(/expired/);
    await expect(cursor.next()).rejects.toThrow(/expired/);
    await expect(f.session.renew()).rejects.toThrow(/expired/);
  });
  it("retries a compare-and-swap race without changing batch identity", async () => {
    const f = fixture(); await f.session.checkpoint();
    f.failCommits(2);
    f.onRead(() => f.remote("one\nTWO\n"));
    const receipt = await f.session.submitBatch(await batch());
    expect(receipt.accepted[0]).toMatchObject({hash: await replicaTextHash("ONE\nTWO\n")});
    expect(f.commits.size).toBe(1);
  });
  it("requires a reachable consumed cursor, not a receipt marker or client timestamp", async () => {
    const f = fixture(); await f.session.checkpoint();
    await expect(f.session.submitBatch({...await batch(), baseCursor: "future"})).rejects.toThrow(/cursor/);
    f.remote("one\nTWO\n");
    await expect(f.session.submitBatch({...await batch(), baseCursor: "cursor-1"})).rejects.toThrow(/anchor/);
    await expect(f.session.submitBatch({...await batch("one\nTWO\n", "ONE\nTWO\n"), baseCursor: "cursor-1"})).resolves.toBeDefined();
  });
  it.each(["../private", ".git/config", "a//b", "a/./b", "a\\b"])("rejects filesystem alias %s", async path => {
    const f = fixture(); await f.session.checkpoint();
    await expect(f.session.submitBatch({...await batch(null, "x"), files: [
      {...(await batch(null, "x")).files[0], path}]})).rejects.toThrow(/path/);
  });
  it("preserves UTF-8 BOMs rather than silently stripping immutable bytes", async () => {
    const f = fixture("\ufefftext"); await f.session.checkpoint();
    expect((await f.session.submitBatch(await batch("\ufefftext", "\ufeffedited"))).accepted[0])
      .toMatchObject({hash: await replicaTextHash("\ufeffedited")});
  });
  it("rejects binary and symlink mutations explicitly", async () => {
    const f = fixture("\0binary"); await f.session.checkpoint();
    await expect(f.session.submitBatch(await batch("\0binary", "text"))).rejects.toThrow(/binary/);
    const g = fixture();
    g.host.assertPathWritable = async () => { throw new Error("Replica mutations of symlinks are unsupported."); };
    await g.session.checkpoint();
    await expect(g.session.submitBatch(await batch())).rejects.toThrow(/symlinks/);
  });
});
