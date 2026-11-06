import {env} from "cloudflare:workers";
import {runInDurableObject, abortAllDurableObjects} from "cloudflare:test";
import {expect, it} from "vitest";
import type {OverseerDurableObject} from "./test-worker";
import type {TestReplicaTransfer} from "./replica-transfer-worker";
const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_REPLICA_TRANSFER: DurableObjectNamespace<TestReplicaTransfer>;
};
it.each(["text", "binary"] as const)("restores a stored sync capability after DO eviction without replaying an accepted %s edit", async kind => {
  const owner = testEnv.TEST_OVERSEER.getByName(crypto.randomUUID());
  const guestName = crypto.randomUUID();
  const guest = testEnv.TEST_REPLICA_TRANSFER.getByName(guestName);
  const fixture = await runInDurableObject(owner, async instance => {
    const impl = instance.impl;
    impl.storage.chatMeta.put({id: 1, title: "Transfer", started: new Date(), lastActive: new Date()});
    const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "abc"]]),
      {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
    const tree = await impl.createWorktree("Repo", 1, commit);
    const session = await impl.openWorktreeSync(1, tree.id, {type: "agent", id: "test", name: "Test"});
    const facade = await impl.ctx.restore({type: "worktree", chatId: 1, worktreeId: tree.id,
      executionId: "unused", author: {type: "agent", id: "test", name: "Test"}});
    expect(await (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(guestName).mount(facade))
      .toHaveLength(2);
    // Persist in another DO through real RPC while still in the owning DO invocation.
    await (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(guestName).save(session);
    return {id: tree.id, revision: impl.replicaHistoryRevision(1)};
  });
  const bytes = Uint8Array.of(0, 255, 13, 10);
  const blob = kind === "binary" ? await guest.putBlob(bytes) : undefined;
  const edits = [{path: "a.txt", change: blob ? {setBytes: blob} : {set: "persisted"}}];
  const first = await guest.submit("retry", fixture.revision, edits);
  await abortAllDurableObjects();
  // The pool lazily constructs its wrapped class on a string RPC; initialize its restore
  // bridge before asking a separately persisted native capability to resolve through it.
  await runInDurableObject(testEnv.TEST_OVERSEER.get(owner.id), instance => instance.impl.storage.chatMeta.get(1));
  if (blob) expect(await testEnv.TEST_REPLICA_TRANSFER.getByName(guestName).putBlob(bytes)).toEqual(blob);
  expect(await testEnv.TEST_REPLICA_TRANSFER.getByName(guestName).submit("retry", fixture.revision, edits)).toEqual(first);
  await runInDurableObject(testEnv.TEST_OVERSEER.get(owner.id), async instance => {
    expect((await instance.impl.getCurrentChatContent(1, instance.impl.storage.chatMeta.get(1)!))
      .get(fixture.id)?.get("a.txt")).toEqual(blob ?? "persisted");
    if (blob) expect(instance.impl.gitStore.readBlob(blob.oid, blob.byteLength)).toEqual(bytes);
    expect([...instance.impl.storage.worktreeSyncCommits.list()]).toHaveLength(1);
  });
});


it("redelivers an applied but unacknowledged callback after both Durable Objects reset", async () => {
  const owner = testEnv.TEST_OVERSEER.getByName(crypto.randomUUID());
  const guestName = crypto.randomUUID();
  const guest = () => testEnv.TEST_REPLICA_TRANSFER.getByName(guestName);
  const fixture = await runInDurableObject(owner, async instance => {
    const impl = instance.impl;
    impl.storage.chatMeta.put({id: 1, title: "Callback reset", started: new Date(), lastActive: new Date()});
    const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "abc"]]),
      {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
    const tree = await impl.createWorktree("Repo", 1, commit);
    using session = await impl.openWorktreeSync(1, tree.id, {type: "agent", id: "test", name: "Test"});
    const receiver = (impl.env as typeof testEnv).TEST_REPLICA_TRANSFER.getByName(guestName);
    await receiver.listen(session);
    await receiver.loseAck();
    await session.submitChanges("edit", impl.replicaHistoryRevision(1), [{path: "a.txt", change: {set: "changed"}}]);
    const sessionId = [...impl.storage.worktreeSyncSessions.list()][0].id;
    await impl.drainWorktreeSubscription(sessionId).catch(() => {});
    return {sessionId, revision: impl.replicaHistoryRevision(1)};
  });
  expect(await guest().events()).toHaveLength(3);
  await abortAllDurableObjects();
  await runInDurableObject(testEnv.TEST_OVERSEER.get(owner.id), async instance => {
    await instance.impl.drainWorktreeSubscription(fixture.sessionId);
    expect(instance.impl.storage.worktreeSyncSubscriptions.get(fixture.sessionId)?.revision).toBe(fixture.revision);
  });
  // Receiver application was persisted before its lost ACK, so replay acknowledges the same
  // event rather than applying it again. The original callback capability also survived reset.
  expect(await guest().events()).toHaveLength(3);
  expect(await guest().attempts()).toBeGreaterThanOrEqual(4);
  await guest().stop();
});
