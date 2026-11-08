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

// A connection with provenance for the worktree's base commit. Deliberately not one of the
// chat's bindings: mounting the worktree is what permits fetching its history.
async function connectGitSource(impl: Impl, commit: string, ids = [40]) {
  for (const id of ids) impl.storage.gatekeepers.put({id, class: impl.ctx.exports.ReplicaGitSource({}),
    creationSpec: {type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/*/*",
      resourceUrl: "https://github.com/fixture/repo"}});
  impl.storage.gitObjectMetadata.put({oid: commit, type: "commit", onRemote: ids, pullableFrom: [], pendingPush: []});
  const facets = await Promise.all(ids.map(id => impl.getGatekeeperFacet(id)));
  return facets as unknown as Fetcher<import("./test-worker").ReplicaGitSource>[];
}
const ANCESTOR = "ab".repeat(20);
const fetchRequest = (want: string, extra = ["deepen 1"]) => new Request("https://git.invalid/git-upload-pack", {
  method: "POST", headers: {"git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request"},
  body: new Blob([encodePktLine("command=fetch"), DELIM_PKT, encodePktLine(`want ${want}`),
    ...extra.map(encodePktLine), encodePktLine("done"), FLUSH_PKT]),
});
// Read a response up to the start of its pack.
async function preamble(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  while (!text.includes("packfile\n")) text += new TextDecoder().decode((await reader.read()).value);
  return text;
}
// Commit `files` on top of the worktree's head, as the agent's commit() does.
async function commitOnHead(impl: Impl, id: number, files: [string, string][]) {
  const previousHead = impl.getWorktreeRecord(id).headCommit;
  const commit = await impl.gitStore.writeChangedFilesAsCommit(new Map(files), {
    treeBase: previousHead, parents: [previousHead], author: {name: "Test", email: "test@example.com"},
    message: "Explicit worktree commit", timestamp: new Date(),
  });
  await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], createdWorktrees: [],
    addedBindings: [], worktreeCommits: [{worktreeId: id, commit, previousHead}], blueprintMerges: []});
  return commit;
}

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

  it("accepts changes without a container binding or a live agent turn", () => within(async (impl, f) => {
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
      expect(events[0]).toMatchObject({kind: "base", base: f.commit, head: f.commit});
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
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "committed"]]);
    await step(impl, f.tree.id, "a.txt", diffFiles("committed", "committed + pending"));
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    expect((await receiver.events())[0]).toMatchObject({kind: "base", base: f.commit, head});
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

  it("tells the subscriber when the head moves, and sends only what a fetch of it lacks", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    await impl.drainWorktreeSubscription([...impl.storage.worktreeSyncSessions.list()][0].id);
    expect((await receiver.events()).at(-1)).toMatchObject({kind: "base", base: f.commit, head});
    using facade = await impl.ctx.restore({type: "worktree", chatId: 1, worktreeId: f.tree.id,
      executionId: "unused", author});
    const objects = await receiver.transfer(facade, head, [f.commit]);
    expect(objects.map(object => object.type).sort()).toEqual(["blob", "commit", "tree"]);
    expect(objects).toContainEqual({oid: head, type: "commit", binary: false});
    await subscription.unsubscribe();
  }));

  it("delivers a head that moves while the previous head is being applied", () => within(async (impl, f) => {
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const subscription = await f.session.subscribe(await receiver.subscriber());
    await receiver.hold("base");
    await commitOnHead(impl, f.tree.id, [["a.txt", "first"]]);
    const id = [...impl.storage.worktreeSyncSessions.list()][0].id;
    const draining = impl.drainWorktreeSubscription(id);
    await until(() => receiver.blocked());
    const second = await commitOnHead(impl, f.tree.id, [["a.txt", "second"]]);
    await receiver.hold(null);
    // The second commit's wake joined the running drain, which must not go idle on the first.
    await draining;
    expect((await receiver.events()).at(-1)).toMatchObject({kind: "base", head: second});
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
      base: impl.getWorktreeRecord(f.tree.id).pinBase});
    expect(await impl.readFileAtCommit(impl.getWorktreeRecord(f.tree.id).pinBase, "a.txt")).toBe("abcd");
    await subscription.unsubscribe();
  }));

  it("proxies a fetch of an ancestor once its connection confirms it, until the connection is removed", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR));
    const reader = response.body!.getReader();
    expect(await preamble(reader)).toContain(`shallow ${ANCESTOR}\n`);
    const [check, forwarded] = await source.requests();
    expect(check).toContain(`want ${ANCESTOR}\n`);
    expect(check).toContain(`have ${f.commit}\n`);
    expect(forwarded).toContain(`want ${ANCESTOR}\n`);
    expect(forwarded).toContain("deepen 1\n");
    const next = reader.read().then(result => result.done, () => true);
    impl.removeGatekeeper(40);
    expect(await next).toBe(true);
    await reader.cancel().catch(() => {});
  }));

  it("refuses a commit outside the worktree's history without forwarding the fetch", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await source.setUnrelated(ANCESTOR);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR)))
      .rejects.toThrow("Only commits in the worktree's history can be fetched.");
    expect(await source.requests()).toHaveLength(1);
  }));

  it("asks the next connection when one doesn't find the commit in the history it knows", () => within(async (impl, f) => {
    const [first, second] = await connectGitSource(impl, f.commit, [40, 41]);
    await first.setUnrelated(ANCESTOR);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR));
    await response.body!.cancel();
    expect(await first.requests()).toHaveLength(1);
    expect(await second.requests()).toHaveLength(2);
  }));

  it("refuses fetch arguments it doesn't understand, such as fetching by ref name", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR, ["want-ref refs/heads/main"])))
      .rejects.toThrow("Unsupported Git fetch argument: want-ref");
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR, ["deepen-not main"])))
      .rejects.toThrow("Unsupported Git fetch argument: deepen-not");
    expect(await source.requests()).toHaveLength(0);
  }));

  it("proxies a deepen of the head the client already has, without a history check", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit,
      [`have ${f.commit}`, `shallow ${f.commit}`, "deepen 3", "deepen-relative"]));
    const reader = response.body!.getReader();
    await preamble(reader);
    await reader.cancel();
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    for (const line of [`want ${f.commit}`, `shallow ${f.commit}`, "deepen 3", "deepen-relative", `have ${f.commit}`])
      expect(forwarded).toContain(`${line}\n`);
  }));

  it("proxies a deeper clone of a worktree still at its remote base", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit, ["deepen 2"]));
    await preamble(response.body!.getReader());
    const [forwarded, ...rest] = await source.requests();
    expect(rest).toEqual([]);
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain("deepen 2\n");
  }));

  it("proxies a fresh fetch of the base together with an ancestor", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(f.commit, [`want ${ANCESTOR}`, "deepen 1"]));
    await preamble(response.body!.getReader());
    const forwarded = (await source.requests()).at(-1)!;
    expect(forwarded).toContain(`want ${f.commit}\n`);
    expect(forwarded).toContain(`want ${ANCESTOR}\n`);
  }));

  it("deepens past the base after a descendant was pushed", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "pushed"]]);
    impl.storage.gitObjectMetadata.put({oid: head, type: "commit", onRemote: [40], pullableFrom: [], pendingPush: []});
    const response = await impl.worktreeGitPull(1, f.tree.id, fetchRequest(head,
      [`have ${head}`, `shallow ${f.commit}`, "deepen 1", "deepen-relative"]));
    await preamble(response.body!.getReader());
    expect((await source.requests()).at(-1)).toContain(`want ${f.commit}\n`);
  }));

  it("cancels a pull stalled before its pack when the worktree is deleted", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    await source.setStalled();
    const fetching = impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR));
    fetching.catch(() => {});
    await until(async () => (await source.requests()).length === 2);
    await scheduler.wait(20);
    impl.storage.gadgets.delete(f.tree.id);
    const error = await fetching.then(() => undefined, (error: Error) => error);
    expect((error?.cause as Error | undefined)?.message).toMatch(/No such worktree/);
  }));

  it("refuses a fetch needing both new workspace commits and remote history", () => within(async (impl, f) => {
    const [source] = await connectGitSource(impl, f.commit);
    const head = await commitOnHead(impl, f.tree.id, [["a.txt", "moved"]]);
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(head, [`have ${f.commit}`, `shallow ${f.commit}`, "deepen 5"])))
      .rejects.toThrow("Fetch the worktree's head first, then fetch again.");
    expect(await source.requests()).toHaveLength(0);
  }));

  it("refuses commits the workspace doesn't have when no connection serves the history", () => within(async (impl, f) => {
    await expect(impl.worktreeGitPull(1, f.tree.id, fetchRequest(ANCESTOR)))
      .rejects.toThrow("No connected repository could serve these commits.");
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
