import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject, abortAllDurableObjects} from "cloudflare:test";
import {beginReplicaTurn, pauseReplicaTurn} from "./replica-fixtures";
import {decodePackStream} from "../src/git-codec";
import {diffFiles, type CodeChange} from "@gadgets/workshop-shared/code-change";
import type {OverseerDurableObject} from "./test-worker";
import type {TestReplicaTransfer} from "./replica-transfer-worker";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_REPLICA_TRANSFER: DurableObjectNamespace<TestReplicaTransfer>;
};
type Impl = OverseerDurableObject["impl"];
const author = {type: "agent" as const, id: "test", name: "Test"};
async function setup(impl: Impl) {
  impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
  impl.storage.chatMeta.put({id: 1, title: "Single worktree", started: Date.now(), lastActive: Date.now()});
  const commit = await impl.gitStore.writeFilesAsCommit(new Map([
    ["a.txt", "one\ntwo\n"], ["untouched.txt", "never read by file tools"], ["binary.dat", "\0binary\xff"],
  ]), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
  const tree = await impl.createWorktree("Repo", 1, commit);
  const other = await impl.createWorktree("Other", 1, commit);
  impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id, OTHER: other.id}});
  impl.storage.gatekeepers.put({id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
    overseerId: impl.ctx.id.toString(), config: {displayName: "Test", modelId: null, env: {}},
  }}), creationSpec: {type: "ambient", vendorId: "container"}});
  await beginReplicaTurn(impl, 1);
  const context = () => impl.agentContext(31, impl.captureIntegrationOrigin({from: "agent", chatId: 1}, 31)!)!;
  const step = (change: CodeChange) => impl.commitAgentStep(1, author, [], {
    changes: [{change}], createdGadgets: [], createdWorktrees: [], addedBindings: [],
    worktreeCommits: [], blueprintMerges: [],
  });
  return {tree, other, commit, context, step};
}
async function within(test: (impl: Impl, fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await runInDurableObject(testEnv.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance["impl"];
    try { await test(impl, await setup(impl)); }
    finally { pauseReplicaTurn(impl, 1); delete impl.env.AGENT_INTEGRATION_GRANTS; }
  });
}
function bindGit(impl: Impl) {
  impl.storage.gatekeepers.put({id: 40, class: impl.ctx.exports.ReplicaGitSource({}),
    creationSpec: {type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/*/*", resourceUrl: "https://github.com/fixture/repo"}});
  const context = impl.storage.chatContext.get(1)!;
  impl.storage.chatContext.put({...context, bindings: {...context.bindings, GIT: 40}});
  return context;
}
const gitRequest = (binding = "GIT", stream = false) => new Request("https://git.invalid/info/refs?service=git-upload-pack", {
  headers: {"git-protocol": "version=2", "x-workshop-git-binding": binding,
    ...(stream ? {"x-test-open-stream": "1"} : {})},
});

describe("single-worktree command mount and writeback", () => {
  it("captures Git bindings, observes runtime reads, and expires Git with final writeback", () => within(async (impl, f) => {
    const context = bindGit(impl);
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    expect(mount.gitRepositories).toEqual([{binding: "GIT", url: "https://github.com/fixture/repo.git", source: false}]);
    const response = await mount.git!.fetch(gitRequest());
    expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("authentication-info")).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0, 255, 128, 13));
    expect([...impl.storage.actions.list()].filter(action => action.type === "observation" &&
      action.description.title === "Fetch Git repository")).toHaveLength(1);
    await expect(mount.git!.fetch(gitRequest("OTHER"))).rejects.toThrow(/binding is unavailable/);
    // A connection added after capture is not borrowed by the original command.
    impl.storage.chatContext.put({...context, bindings: {...context.bindings, GIT: 40, LATER: 40}});
    await expect(mount.git!.fetch(gitRequest("LATER"))).rejects.toThrow(/binding is unavailable/);
    await mount.writeback.submitChanges("final", [], true);
    await expect(mount.git!.fetch(gitRequest())).rejects.toThrow(/access ended/);
  }));
  it("cancels an unfinished Git stream when final writeback closes the command", () => within(async (impl, f) => {
    bindGit(impl);
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    const reader = (await mount.git!.fetch(gitRequest("GIT", true))).body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(0, 255, 128, 13));
    // Native HTTP may report cancellation as EOF rather than an RPC stream error. Either
    // must promptly terminate the read without delivering further repository bytes.
    const next = reader.read().then(result => result.done, () => true);
    await mount.writeback.submitChanges("final", [], true);
    expect(await next).toBe(true);
  }));
  it.each(["integration", "repository", "binding", "turn"])("fences Git after %s revocation", edge => within(async (impl, f) => {
    bindGit(impl);
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    if (edge === "integration") impl.env.AGENT_INTEGRATION_GRANTS = "{}";
    if (edge === "repository") impl.storage.gatekeepers.delete(40);
    if (edge === "binding") {
      const context = impl.storage.chatContext.get(1)!;
      impl.storage.chatContext.put({...context, bindings: {...context.bindings, GIT: 31}});
    }
    if (edge === "turn") impl.storage.activeAgents.delete(1);
    await expect(mount.git!.fetch(gitRequest())).rejects.toThrow();
  }));
  it("deduplicates overlapping retries of the same batch", () => within(async (impl, f) => {
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    const changes = [{path: "a.txt", change: {edit: [[3, "ONE"], 5]}}];
    await Promise.all([mount.writeback.submitChanges("same", changes, false),
      mount.writeback.submitChanges("same", changes, false)]);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(1);
    await mount.writeback.submitChanges("final", [], true);
    expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!))
      .get(f.tree.id)?.get("a.txt")).toBe("ONE\ntwo\n");
  }));
  it("recaptures a lost mount reply only before any writeback starts", () => within(async (impl, f) => {
    const first = await f.context().mountWorktree("REPO");
    for (const pack of first.packs) await pack.cancel();
    const second = await f.context().mountWorktree("REPO");
    for (const pack of second.packs) await pack.cancel();
    expect([...impl.storage.worktreeReplicaLeases.list()]).toHaveLength(1);
    await second.writeback.submitChanges("one", [{path: "once.txt", change: {set: "once"}}], false);
    await expect(f.context().mountWorktree("REPO")).rejects.toThrow(/already active/);
    await second.writeback.submitChanges("final", [], true);
  }));
  it("captures pending OTs once, exports raw binary packs, and leaves unrelated files lazy", () => within(async (impl, f) => {
    const change = diffFiles(new Map([[f.tree.id, new Map([["a.txt", "one\ntwo\n"]])]]),
      new Map([[f.tree.id, new Map([["a.txt", "ONE\ntwo\n"]])]]));
    await f.step(change);
    const mount = await f.context().mountWorktree("REPO");
    expect(mount.head).toBe(f.commit);
    expect(mount.pendingChanges).toEqual(change[f.tree.id].map(([path, change]) => ({path, change})));
    const objects = [];
    for (const pack of mount.packs) for await (const object of decodePackStream(pack, {
      maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024,
    })) objects.push(object);
    expect(objects.some(object => object.oid === f.commit && object.type === "commit")).toBe(true);
    expect(objects.some(object => object.type === "blob" && object.payload.includes(0))).toBe(true);
    const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    expect(content.get(f.tree.id)?.has("untouched.txt")).toBe(false);
    await mount.writeback.submitChanges("final", [], true);
  }));

  it("streams multiple small OTs, deduplicates lost replies and closes atomically with the final batch", () => within(async (impl, f) => {
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    const a = [{path: "a.txt", change: {edit: [[3, "ONE"], 5]}}];
    await mount.writeback.submitChanges("one", a, false);
    await mount.writeback.submitChanges("one", a, false);
    await expect((async () => { await mount.writeback.submitChanges("one", [], false); })()).rejects.toThrow(/different payload/);
    await mount.writeback.submitChanges("two", [{path: "new.txt", change: {set: "created"}}], false);
    await mount.writeback.submitChanges("final", [{path: "a.txt", change: {edit: [4, [3, "TWO"], 1]}}], true);
    await mount.writeback.submitChanges("final", [{path: "a.txt", change: {edit: [4, [3, "TWO"], 1]}}], true);
    await expect((async () => { await mount.writeback.submitChanges("late", [], false); })()).rejects.toThrow(/access ended/);
    const files = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(f.tree.id)!;
    expect(files.get("a.txt")).toBe("ONE\nTWO\n");
    expect(files.get("new.txt")).toBe("created");
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(3);
    const next = await f.context().mountWorktree("REPO");
    expect(next.pendingChanges).toHaveLength(2);
    for (const pack of next.packs) await pack.cancel();
    await next.writeback.submitChanges("done", [], true);
  }));

  it("rejects concurrent DO edits rather than reconciling or polling", () => within(async (_impl, f) => {
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    await f.step({[f.tree.id]: [["a.txt", {set: "DO changed"}]]});
    await expect((async () => { await mount.writeback.submitChanges("stale", [{path: "a.txt", change: {set: "container"}}], false); })())
      .rejects.toThrow(/concurrent writers/);
    const next = await f.context().mountWorktree("REPO");
    for (const pack of next.packs) await pack.cancel();
    await expect((async () => {await mount.writeback.submitChanges("late", [], false);})())
      .rejects.toThrow(/access ended/);
    await next.writeback.submitChanges("final", [], true);
  }));

  it("fails closed on revoked integration access and keeps the final receipt retryable", () => within(async (impl, f) => {
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    await mount.writeback.submitChanges("authority", [], false);
    impl.env.AGENT_INTEGRATION_GRANTS = "{}";
    await expect((async () => { await mount.writeback.submitChanges("authority", [], false); })()).rejects.toThrow(/access ended/);
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    await mount.writeback.submitChanges("final", [], true);
    impl.env.AGENT_INTEGRATION_GRANTS = "{}";
    await mount.writeback.submitChanges("final", [], true);
  }));

  it.each(["../escape", ".git/config", "a//b", "/root", "a\\b"])("rejects unsafe write path %s", path => within(async (_impl, f) => {
    const mount = await f.context().mountWorktree("REPO");
    for (const pack of mount.packs) await pack.cancel();
    await expect((async () => { await mount.writeback.submitChanges("bad", [{path, change: {set: "bad"}}], false); })())
      .rejects.toThrow(/path|file|Path/);
    await mount.writeback.submitChanges("final", [], true);
  }));

  it("rejects an unknown binding and scopes writes to only the selected worktree", () => within(async (impl, f) => {
    await expect(f.context().mountWorktree("UNKNOWN")).rejects.toThrow(/binding/);
    const mount = await f.context().mountWorktree("OTHER");
    for (const pack of mount.packs) await pack.cancel();
    await mount.writeback.submitChanges("done", [{path: "new.txt", change: {set: "other"}}], true);
    const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    expect(content.get(f.tree.id)?.has("new.txt") ?? false).toBe(false);
    expect(content.get(f.other.id)?.get("new.txt")).toBe("other");
  }));

  it("returns a final acceptance receipt after actual DO eviction without repeating effects", async () => {
    const name = crypto.randomUUID();
    const leaseId = await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name), async instance => {
      const impl = instance["impl"], f = await setup(impl);
      const mount = await f.context().mountWorktree("REPO");
      for (const pack of mount.packs) await pack.cancel();
      await mount.writeback.submitChanges("final", [{path: "once.txt", change: {set: "once"}}], true);
      pauseReplicaTurn(impl, 1);
      delete impl.env.AGENT_INTEGRATION_GRANTS;
      return [...impl.storage.worktreeReplicaLeases.list()][0].id;
    });
    await abortAllDurableObjects();
    const endpoint = await testEnv.TEST_OVERSEER.getByName(name).testReplicaEndpoint(leaseId);
    await endpoint.submitChanges("final", [{path: "once.txt", change: {set: "once"}}], true);
    await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name), instance => {
      expect([...instance["impl"].storage.worktreeReplicaCommits.list()]).toHaveLength(1);
    });
  });
});
