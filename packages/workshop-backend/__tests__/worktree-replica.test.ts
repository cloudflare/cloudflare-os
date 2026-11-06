import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "./test-worker";
import type {TestReplicaTransfer} from "./replica-transfer-worker";
import {encodePktLine, FLUSH_PKT, DELIM_PKT} from "@gadgets/gatekeeper-kit/git-transport";
import {diffFiles as diffContent} from "@gadgets/workshop-shared/code-change";

import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import {runAgent, type WorktreeTurnAccess} from "../src/agent";

const diffFiles = (before: string, after: string) => diffContent(
  new Map([[0, new Map([["file", before]])]]), new Map([[0, new Map([["file", after]])]]))[0][0][1];

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_REPLICA_TRANSFER: DurableObjectNamespace<TestReplicaTransfer>;
};
type Impl = OverseerDurableObject["impl"];
const author = {type: "agent" as const, id: "test", name: "Test"};
async function setup(impl: Impl) {
  impl.storage.chatMeta.put({id: 1, title: "Live worktree", started: new Date(), lastActive: new Date()});
  const commit = await impl.gitStore.writeFilesAsCommit(new Map([
    ["a.txt", "abc"], ["untouched.txt", "base"], ["raw.bin", "\0binary\xff"],
  ]), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
  const tree = await impl.createWorktree("Repo", 1, commit);
  await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [],
    createdWorktrees: [{worktreeId: tree.id, title: "Repo", bindingName: "REPO"}],
    addedBindings: [], worktreeCommits: [], blueprintMerges: []});
  impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}});
  await impl.openWorktreeSync(1, tree.id, author);
  const sessionId = [...impl.storage.worktreeSyncSessions.list()][0].id;
  // Pure ingestion tests avoid the pool's loopback wrapper; transfer tests below exercise
  // native persistence and RPC serialization through a separate Worker.
  const session = {
    putBlob: (bytes: Uint8Array) => impl.putWorktreeBlob(sessionId, bytes),
    submitChanges: (batchId: string, revision: string, changes: Parameters<Impl["submitWorktreeChanges"]>[3]) =>
      impl.submitWorktreeChanges(sessionId, batchId, revision, changes),
    subscribe: (subscriber: Parameters<Impl["subscribeWorktree"]>[1], after?: string) =>
      impl.subscribeWorktree(sessionId, subscriber, after),
  };
  return {tree, commit, session};
}
async function within(test: (impl: Impl, f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await runInDurableObject(testEnv.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    await test(instance.impl, await setup(instance.impl));
  });
}
const text = async (impl: Impl, id: number, path = "a.txt") =>
  (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(id)?.get(path);
const step = (impl: Impl, id: number, path: string, change: ReturnType<typeof diffFiles>) =>
  impl.commitAgentStep(1, author, [], {changes: [{change: {[id]: [[path, change]]}}], createdGadgets: [],
    createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});

function bindGit(impl: Impl) {
  impl.storage.gatekeepers.put({id: 40, class: impl.ctx.exports.ReplicaGitSource({}),
    creationSpec: {type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/*/*",
      resourceUrl: "https://github.com/fixture/repo"}});
  impl.storage.chatContext.put({chatId: 1, bindings: {GIT: 40}});
}
const gitRequest = (stream = false) => new Request("https://git.invalid/info/refs?service=git-upload-pack", {
  headers: {"git-protocol": "version=2", ...(stream ? {"x-test-open-stream": "1"} : {})},
});

async function until(predicate: () => Promise<boolean>) {
  for (let n = 0; n < 1000; ++n) {
    if (await predicate()) return;
    await scheduler.wait(1);
  }
  throw new Error("Test barrier did not arrive");
}

describe("mounted worktree canonical synchronization", () => {
  it.each(["writeFile", "editFile"] as const)("replays the original %s result after an early replica flush", toolName => within(async (impl, f) => {
    const user = {type: "user" as const, id: "test-user", name: "Test"};
    impl.addChatMessages(1, user, [{type: "message", message: "Edit the files."}]);
    let access!: WorktreeTurnAccess;
    const register = impl.registerWorktreeReplicaTurn.bind(impl);
    const registration = vi.spyOn(impl, "registerWorktreeReplicaTurn").mockImplementation((...args) => {
      access = args[1]; return register(...args);
    });
    const writable = impl.gitCache.assertWorktreePathWritable.bind(impl.gitCache);
    const paths = vi.spyOn(impl.gitCache, "assertWorktreePathWritable").mockImplementation(async (...args) => {
      // Flush the first tool's edit before this step's assistant transcript is persisted.
      if (args[1] === "trigger.txt") expect(await access.flushReplica!({}, access.getRevision!())).toBe(true);
      return writable(...args);
    });
    const mutation = fauxToolCall(toolName, {workpiece: "REPO", filename: "a.txt", ...(toolName === "writeFile"
      ? {content: "Xabc"} : {textToReplace: "abc", replacement: "Xabc"})});
    let liveResult: unknown, replayResult: unknown;
    const faux = createFauxCore({models: [{id: "test"}]});
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("readFile", {workpiece: "REPO", filename: "a.txt"}), mutation,
        fauxToolCall("writeFile", {workpiece: "REPO", filename: "trigger.txt", content: "next"}),
      ], {stopReason: "toolUse"}),
      context => {
        const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === mutation.id);
        if (result?.role === "toolResult") liveResult = result.content;
        return fauxAssistantMessage(fauxText("Done."));
      },
      context => {
        const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === mutation.id);
        if (result?.role === "toolResult") replayResult = result.content;
        return fauxAssistantMessage(fauxText("Continued."));
      },
    ]);
    const run = () => runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, author,
      new AbortController().signal, user, {provider: "cloudflare", model: "test", apiToken: ""});
    try {
      await run();
      const changeCount = [...impl.storage.chatChanges.list()].length;
      impl.addChatMessages(1, user, [{type: "message", message: "Continue."}]);
      await run();
      expect(faux.getPendingResponseCount()).toBe(0);
      expect(liveResult).toEqual([{type: "text", text: JSON.stringify({success: true, changeId: 1})}]);
      expect(replayResult).toEqual(liveResult);
      expect([...impl.storage.chatChanges.list()]).toHaveLength(changeCount);
      const files = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(f.tree.id)!;
      expect(files.get("a.txt")).toBe("Xabc");
      expect(files.get("trigger.txt")).toBe("next");
    } finally { registration.mockRestore(); paths.mockRestore(); }
  }));

  it("does not require a container binding, turn identity, or integration deployment grant", () => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1);
    await f.session.submitChanges("one", revision, [{path: "new.txt", change: {set: "from replica"}}]);
    expect(await text(impl, f.tree.id, "new.txt")).toBe("from replica");
  }));

  it("transforms stale-base text edits over a concurrent DO edit without full-file replacement", () => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1);
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "Xabc"));
    const ack = await f.session.submitChanges("guest", revision,
      [{path: "a.txt", change: diffFiles("abc", "abcY")}]);
    expect(await text(impl, f.tree.id)).toBe("XabcY");
    const rows = [...impl.storage.chatChanges.list()];
    expect(rows.at(-1)?.change[f.tree.id][0][1]).toHaveProperty("edit");
    expect(ack.revision).toBe(impl.replicaHistoryRevision(1));
  }));

  it("canonically orders two replicas editing the same base", () => within(async (impl, f) => {
    const second = await impl.openWorktreeSync(1, f.tree.id, author);
    const revision = impl.replicaHistoryRevision(1);
    await Promise.all([
      f.session.submitChanges("a", revision, [{path: "a.txt", change: diffFiles("abc", "abcA")}]),
      second.submitChanges("b", revision, [{path: "a.txt", change: diffFiles("abc", "Babc")}]),
    ]);
    expect(await text(impl, f.tree.id)).toBe("BabcA");
  }));

  it("returns the original receipt after intervening changes and rejects different-payload retries", () => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1);
    const changes = [{path: "a.txt", change: diffFiles("abc", "aXbc")}];
    const ack = await f.session.submitChanges("retry", revision, changes);
    await step(impl, f.tree.id, "a.txt", diffFiles("aXbc", "aXbcZ"));
    expect(await f.session.submitChanges("retry", revision, changes)).toEqual(ack);
    expect(await text(impl, f.tree.id)).toBe("aXbcZ");
    await expect(f.session.submitChanges("retry", revision, [{path: "x", change: {set: "different"}}]))
      .rejects.toThrow("different content");
  }));

  it("bootstraps and streams own echoes under their original batch IDs", async () => {
    await within(async (impl, f) => {
      const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
      const callback = await receiver.subscriber();
      const revision = impl.replicaHistoryRevision(1);
      const subscription = await f.session.subscribe(callback);
      const ack = await f.session.submitChanges("echo", revision, [{path: "new.txt", change: {set: "new"}}]);
      const sessions = Array.from(impl.storage.worktreeSyncSessions.list());
      for (const session of sessions) await impl.drainWorktreeSubscription(session.id);
      const events = await receiver.events();
      expect(events[0]).toMatchObject({kind: "base", head: f.commit});
      expect(events[1]).toMatchObject({kind: "change", revision, changes: []});
      expect(events[2]).toMatchObject({kind: "change", revision: ack.revision, batchId: "echo"});
      await subscription.unsubscribe();
    });
  });

  it("catches edits made while initial base hydration is pending", async () => {
    await within(async (impl, f) => {
      const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
      const callback = await receiver.subscriber();
      await receiver.hold("base");
      let ready = false;
      const opening = f.session.subscribe(callback).then(value => { ready = true; return value; });
      await until(() => receiver.blocked());
      await step(impl, f.tree.id, "a.txt", diffFiles("abc", "abcd"));
      expect(ready).toBe(false);
      await receiver.hold(null);
      const subscription = await opening;
      expect((await receiver.events()).at(-1)).toMatchObject({kind: "change", changes: [{path: "a.txt"}]});
      await subscription.unsubscribe();
    });
  });

  it("applies backpressure while DO edits continue, without concurrent callbacks", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    await receiver.hold("change");
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "abcd"));
    await until(() => receiver.blocked());
    const attempts = await receiver.attempts();
    await step(impl, f.tree.id, "untouched.txt", {set: "concurrent"});
    expect(await receiver.attempts()).toBe(attempts);
    await receiver.hold(null);
    await impl.drainWorktreeSubscription([...impl.storage.worktreeSyncSessions.list()][0].id);
    expect((await receiver.events()).slice(-2)).toMatchObject([
      {changes: [{path: "a.txt"}]}, {changes: [{path: "untouched.txt"}]},
    ]);
    await subscription.unsubscribe();
  }));

  it("replays a lost callback ACK without duplicating the receiver's applied event", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    await receiver.loseAck();
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "abcd"));
    const id = [...impl.storage.worktreeSyncSessions.list()][0].id;
    await impl.drainWorktreeSubscription(id).catch(() => {});
    await impl.drainWorktreeSubscription(id);
    expect(await receiver.events()).toHaveLength(3);
    expect(await receiver.attempts()).toBe(4);
    expect(impl.storage.worktreeSyncSubscriptions.get(id)?.revision).toBe(impl.replicaHistoryRevision(1));
    await subscription.unsubscribe();
  }));

  it("does not let an old subscription handle stop its replacement", () => within(async (impl, f) => {
    const first = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const second = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const old = await f.session.subscribe(await first.subscriber());
    const current = await f.session.subscribe(await second.subscriber());
    await old.unsubscribe();
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "abcd"));
    await impl.drainWorktreeSubscription([...impl.storage.worktreeSyncSessions.list()][0].id);
    expect(await first.events()).toHaveLength(2);
    expect(await second.events()).toHaveLength(3);
    await current.unsubscribe();
  }));

  it("accepts a whole binary blob replacement and streams its OID, rejecting absent blobs", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    const blob = await impl.gitStore.writeBlob(Uint8Array.from([0, 255, 42, 0]));
    const ack = await f.session.submitChanges("binary", impl.replicaHistoryRevision(1),
      [{path: "image.bin", change: {setBytes: {oid: blob.oid, byteLength: 4}}}]);
    await impl.drainWorktreeSubscription([...impl.storage.worktreeSyncSessions.list()][0].id);
    expect((await receiver.events()).at(-1)).toMatchObject({revision: ack.revision,
      changes: [{path: "image.bin", change: {setBytes: {oid: blob.oid, byteLength: 4}}}]});
    await expect(f.session.submitChanges("missing", ack.revision,
      [{path: "missing.bin", change: {setBytes: {oid: "0".repeat(40), byteLength: 4}}}])).rejects.toThrow();
    await subscription.unsubscribe();
  }));

  it("stages whole raw Git blobs idempotently without changing files or the OT revision", () => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1), bytes = Uint8Array.of(0, 255, 13, 10);
    const before = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    const blob = await f.session.putBlob(bytes);
    expect(blob.byteLength).toBe(4);
    expect(await f.session.putBlob(bytes)).toEqual(blob);
    expect(impl.gitStore.readBlob(blob.oid, blob.byteLength)).toEqual(bytes);
    expect(impl.replicaHistoryRevision(1)).toBe(revision);
    expect(await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).toEqual(before);
    for (const invalid of [new ArrayBuffer(4), [0, 255], {byteLength: 0, length: 8_000_001}])
      await expect(Reflect.apply(f.session.putBlob, undefined, [invalid])).rejects.toThrow(/raw Git blob bytes/);
    await expect(f.session.putBlob(new Uint8Array(8_000_001))).rejects.toThrow(/too large/);
    impl.storage.gadgets.delete(f.tree.id);
    await expect(f.session.putBlob(bytes)).rejects.toThrow();
  }));

  it.each(["replace", "remove"] as const)("orders binary %s after a concurrent canonical text edit", operation => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1);
    const blob = await f.session.putBlob(Uint8Array.of(0, 255, 42));
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "DO abc"));
    const change = operation === "replace" ? {setBytes: {oid: blob.oid, byteLength: 3}} : {remove: true as const};
    const receipt = await f.session.submitChanges("binary-race", revision, [{path: "a.txt", change}]);
    expect(await text(impl, f.tree.id)).toEqual(operation === "replace" ? change.setBytes : undefined);
    // Retry after another edit returns the first receipt and never overwrites newer work.
    await step(impl, f.tree.id, "a.txt", {set: "later"});
    expect(await f.session.submitChanges("binary-race", revision, [{path: "a.txt", change}])).toEqual(receipt);
    expect(await text(impl, f.tree.id)).toBe("later");
  }));

  it("rejects an invalid binary batch atomically without discarding other edits", () => within(async (impl, f) => {
    await step(impl, f.tree.id, "a.txt", {set: "ordinary edit"});
    const revision = impl.replicaHistoryRevision(1);
    await expect(f.session.submitChanges("bad-binary", revision, [
      {path: "a.txt", change: {set: "must not land"}},
      {path: "b.bin", change: {setBytes: {oid: "0".repeat(40), byteLength: 3}}},
    ])).rejects.toThrow();
    expect(await text(impl, f.tree.id)).toBe("ordinary edit");
    await step(impl, f.tree.id, "a.txt", {set: "still usable"});
    expect(await text(impl, f.tree.id)).toBe("still usable");
  }));

  it("keeps an unacknowledged binary event fetchable after the same path changes again", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    const first = await impl.gitCache.putFromGatekeeper(40, "blob", Uint8Array.of(0, 1, 255));
    const second = await impl.gitCache.putFromGatekeeper(40, "blob", Uint8Array.of(0, 2, 255));
    await receiver.hold("change");
    await f.session.submitChanges("first", impl.replicaHistoryRevision(1), [
      {path: "raw.bin", change: {setBytes: {oid: first, byteLength: 3}}},
    ]);
    await until(() => receiver.blocked());
    await f.session.submitChanges("second", impl.replicaHistoryRevision(1), [
      {path: "raw.bin", change: {setBytes: {oid: second, byteLength: 3}}},
    ]);
    const facade = await impl.ctx.restore({type: "worktree", chatId: 1, worktreeId: f.tree.id,
      executionId: "unused", author});
    try {
      expect(await receiver.transfer(facade, first)).toEqual([{oid: first, type: "blob", binary: true}]);
    } finally {
      await receiver.hold(null);
      await subscription.unsubscribe();
    }
  }));

  it("serves explicit Git HEAD and the canonical file base through one endpoint before acceptance", () => within(async (impl, f) => {
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "committed"));
    const head = await impl.gitStore.writeChangedFilesAsCommit(new Map([["a.txt", "committed"]]), {
      treeBase: f.commit, parents: [f.commit], author: {name: "Test", email: "test@example.com"},
      message: "Explicit worktree commit", timestamp: new Date(),
    });
    await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], createdWorktrees: [],
      addedBindings: [], worktreeCommits: [{worktreeId: f.tree.id, commit: head, previousHead: f.commit}], blueprintMerges: []});
    await step(impl, f.tree.id, "a.txt", diffFiles("committed", "committed + pending"));
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    expect((await receiver.events())[0]).toMatchObject({kind: "base", head: f.commit});
    const refs = await impl.worktreeGitPull(1, f.tree.id, new Request("https://git.invalid/git-upload-pack", {
      method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"}, body: new Blob([
        encodePktLine("command=ls-refs"), DELIM_PKT, encodePktLine("symrefs"), FLUSH_PKT,
      ]),
    }));
    expect(new TextDecoder().decode(await refs.arrayBuffer())).toContain(`${head} HEAD`);
    using facade = await impl.ctx.restore({type: "worktree", chatId: 1, worktreeId: f.tree.id,
      executionId: "unused", author});
    expect(await receiver.transfer(facade, head)).toContainEqual({oid: head, type: "commit", binary: false});
    expect(await receiver.transfer(facade, f.commit)).toContainEqual({oid: f.commit, type: "commit", binary: false});
    expect(await text(impl, f.tree.id)).toBe("committed + pending");
    await subscription.unsubscribe();
  }));

  it("checkpoints an accepted commit after delivering its edits, without replaying file changes", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    await step(impl, f.tree.id, "a.txt", diffFiles("abc", "abcd"));
    await impl.drainWorktreeSubscription([...impl.storage.worktreeSyncSessions.list()][0].id);
    const user = {type: "user" as const, id: "test-user", name: "Test"};
    await impl.mergeChanges(1, {profile: user}, "client-user");
    await impl.drainWorktreeSubscription([...impl.storage.worktreeSyncSessions.list()][0].id);
    const events = await receiver.events();
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({kind: "base", revision: impl.replicaHistoryRevision(1),
      head: impl.getWorktreeRecord(f.tree.id).pinBase});
    expect(await impl.readFileAtCommit(impl.getWorktreeRecord(f.tree.id).pinBase, "a.txt")).toBe("abcd");
    await subscription.unsubscribe();
  }));

  it("routes an already-connected Git URL as raw bytes with an observation and no provider headers", () => within(async (impl) => {
    bindGit(impl);
    const response = await impl.pullConnectedRepository("https://github.com/fixture/repo", gitRequest(),
      {from: "agent", chatId: 1}, () => {});
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0, 255, 128, 13));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authentication-info")).toBeNull();
    expect([...impl.storage.actions.list()].some(action => action.type === "observation")).toBe(true);
    await expect(impl.pullConnectedRepository("https://github.com/other/unconnected", gitRequest(),
      {from: "agent", chatId: 1}, () => {})).rejects.toThrow("No authorized repository connection");
  }));

  it("cancels a stalled Git stream when its source is removed", () => within(async (impl) => {
    bindGit(impl);
    const response = await impl.pullConnectedRepository("https://github.com/fixture/repo.git", gitRequest(true),
      {from: "agent", chatId: 1}, () => {});
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(0, 255, 128, 13));
    const next = reader.read().then(result => result.done, () => true);
    impl.removeGatekeeper(40);
    expect(await next).toBe(true);
    await reader.cancel().catch(() => {});
  }));

  it("rejects path aliases and unsupported revisions without partial effects", () => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1);
    for (const path of ["../escape", ".git/config", "a//b", "a\\b", "/absolute"])
      await expect(f.session.submitChanges("bad", revision, [{path, change: {set: "bad"}}])).rejects.toThrow();
    await expect(f.session.submitChanges("future", "0:999999", [{path: "a.txt", change: {set: "bad"}}])).rejects.toThrow();
    expect(impl.replicaHistoryRevision(1)).toBe(revision);
  }));

  it("fails closed after worktree deletion", () => within(async (impl, f) => {
    const revision = impl.replicaHistoryRevision(1);
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    using _subscription = await f.session.subscribe(await receiver.subscriber());
    impl.storage.gadgets.delete(f.tree.id);
    await expect(f.session.submitChanges("deleted", revision, [{path: "a", change: {set: "bad"}}])).rejects.toThrow();
    await until(async () => [...impl.storage.worktreeSyncSubscriptions.list()].length === 0);
  }));
});
