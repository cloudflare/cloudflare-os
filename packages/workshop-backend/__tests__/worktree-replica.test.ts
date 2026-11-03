import {describe, expect, it, vi} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import {env} from "cloudflare:workers";
import {runInDurableObject, abortAllDurableObjects} from "cloudflare:test";
import {beginReplicaTurn, pauseReplicaTurn} from "./replica-fixtures";
import {decodePackStream} from "../src/git-codec";
import {diffFiles, type CodeChange} from "@gadgets/workshop-shared/code-change";
import type {OverseerDurableObject} from "./test-worker";
import type {TestReplicaTransfer} from "./replica-transfer-worker";
import {runAgent, type WorktreeTurnAccess} from "../src/agent";
import {UserDurableObject} from "../src/user";
import {WorktreeSessionImpl} from "../src/worktree-session";

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
  const context = () => {
    const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1}, 31)!;
    return {export: (binding: string) => impl.exportWorktree(31, origin, binding),
      check: () => impl.checkWorktreeExportOrigin(31, origin)};
  };
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
  it.each(["writeFile", "editFile"] as const)("replays the original %s result after an early replica flush", toolName => within(async (impl, f) => {
    const user = {type: "user" as const, id: "test-user", name: "Test"};
    impl.addChatMessages(1, author, [{type: "changes", change: {}, createdWorktrees: [
      {worktreeId: f.tree.id, title: "Repo", bindingName: "REPO"},
    ]}]);
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
      ? {content: "ONE\ntwo\n"} : {textToReplace: "one", replacement: "ONE"})});
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
      expect(files.get("a.txt")).toBe("ONE\ntwo\n");
      expect(files.get("trigger.txt")).toBe("next");
    } finally { registration.mockRestore(); paths.mockRestore(); }
  }));

  it("opens raw pack readers lazily and revokes them with final writeback", () => within(async (impl, f) => {
    const blobs = vi.spyOn(impl.gitStore, "readBlob");
    const input = await f.context().export("REPO");
    expect(blobs).not.toHaveBeenCalled();
    expect(input.shallowCommit).toBeNull();
    const response = await input.packs[0].fetch("https://export.invalid/");
    expect(response.headers.get("content-type")).toBe("application/x-git-packed-objects");
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("PACK"));
    await input.writeback.submitChanges("final", [], true);
    await expect((async () => await input.packs[0].fetch("https://export.invalid/"))()).rejects.toThrow("access ended");
    blobs.mockRestore();
  }));

  it("keeps the frozen pack plan if Git provenance is learned while approval is pending", () => within(async (impl, f) => {
    const input = await f.context().export("REPO");
    expect(input.packs).toHaveLength(1);
    expect(input.shallowCommit).toBeNull();
    bindGit(impl);
    impl.storage.gitObjectMetadata.put({oid: f.commit, type: "commit", onRemote: [40], pullableFrom: [], pendingPush: []});
    const response = await input.packs[0].fetch("https://export.invalid/");
    const objects = [];
    for await (const object of decodePackStream(response.body!, {maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024})) objects.push(object.oid);
    expect(objects).toContain(f.commit);
    await input.writeback.submitChanges("final", [], true);
  }));

  it("keeps the remote shallow boundary below a DO-only accepted commit", () => within(async (impl, f) => {
    bindGit(impl);
    impl.storage.gitObjectMetadata.put({oid: f.commit, type: "commit", onRemote: [40], pullableFrom: [], pendingPush: []});
    const accepted = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "accepted in the DO"]]), {
      parents: [f.commit], author: {name: "Test", email: "test@example.com"}, message: "DO accepted", timestamp: new Date(1),
    });
    const piece = impl.storage.gadgets.get(f.tree.id)!;
    if (piece.type !== "worktree") throw new Error("Expected a worktree");
    impl.storage.gadgets.put({...piece, pinBase: accepted, headCommit: accepted});
    const input = await f.context().export("REPO");
    expect(input.head).toBe(accepted);
    expect(input.shallowCommit).toBe(f.commit);
    expect(input.shallowCommit).not.toBe(input.head);
    expect(input.packs).toHaveLength(2);
    await input.writeback.submitChanges("final", [], true);
  }));

  it("revokes writeback when the worktree source is removed, but still recognizes its final receipt", () => within(async (impl, f) => {
    bindGit(impl);
    const piece = impl.storage.gadgets.get(f.tree.id)!;
    if (piece.type !== "worktree") throw new Error("Expected a worktree");
    impl.storage.gadgets.put({...piece, sourceGatekeeperId: 40});
    const mount = await f.context().export("REPO");
    impl.removeGatekeeper(40);
    await expect((async () => { await mount.writeback.submitChanges("removed", [{path: "bad.txt", change: {set: "bad"}}], true); })())
      .rejects.toThrow(/connection|access ended/i);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(0);
    bindGit(impl);
    await mount.writeback.submitChanges("final", [], true);
    impl.removeGatekeeper(40);
    await mount.writeback.submitChanges("final", [], true);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(1);
  }));

  it.each(["none", "canonical", "buffered", "validation"] as const)("documents best-effort conflict checks across a %s writeback race", conflict => within(async (impl, f) => {
    const accepted = conflict === "none" || conflict === "validation";
    impl.addChatMessages(1, author, [{type: "changes", change: {}, createdWorktrees: [
      {worktreeId: f.tree.id, title: "Repo", bindingName: "REPO"},
    ]}]);
    impl.addChatMessages(1, {type: "user", id: "test-user", name: "Test"}, [{type: "message", message: "Run the command."}]);
    let access!: WorktreeTurnAccess;
    const register = impl.registerWorktreeReplicaTurn.bind(impl);
    const registration = vi.spyOn(impl, "registerWorktreeReplicaTurn").mockImplementation((...args) => {
      access = args[1];
      return register(...args);
    });
    const commit = impl.commitAgentStep.bind(impl);
    let armed = false;
    const commits = vi.spyOn(impl, "commitAgentStep").mockImplementation((...args) => {
      if (args[3].replicaCommit) armed = true;
      return commit(...args);
    });
    const content = impl.getCurrentChatContent.bind(impl);
    const reads = vi.spyOn(impl, "getCurrentChatContent").mockImplementation(async (...args) => {
      const result = await content(...args);
      if (armed) {
        armed = false;
        if (conflict === "canonical") await f.step({[f.tree.id]: [["external.txt", {set: "canonical"}]]});
        if (conflict === "buffered") access.appendChange(f.tree.id, "later.txt", {set: "later"});
      }
      return result;
    });
    const writable = impl.gitCache.assertWorktreePathWritable.bind(impl.gitCache);
    const paths = vi.spyOn(impl.gitCache, "assertWorktreePathWritable").mockImplementation(async (...args) => {
      // The initial ordinary-buffer flush has finished. This edit joins the replica's commit.
      access.appendChange(f.tree.id, "ordinary.txt", {set: "ordinary"});
      if (conflict === "validation") access.appendChange(f.tree.id, "a.txt", {set: "Xne\ntwo\n"});
      await writable(...args);
    });
    const faux = createFauxCore({models: [{id: "test"}]});
    faux.setResponses([async () => {
      const mount = await f.context().export("REPO");
      const result = (async () => { await mount.writeback.submitChanges("batch", [
        {path: "container.txt", change: {set: "container"}},
        ...(conflict === "validation" ? [{path: "a.txt", change: {edit: [[1, "O"], 7]}}] : []),
      ], false); })();
      if (accepted) await result;
      else await expect(result).rejects.toThrow(/concurrent writers/);
      expect(access.getOverlayFiles(f.tree.id).get("container.txt"))
        .toBe(accepted ? "container" : undefined);
      expect(await access.flushReplica!({}, access.getRevision!())).toBe(true);
      return fauxAssistantMessage(fauxText("Done."));
    }]);
    try {
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, author,
        new AbortController().signal, {type: "user", id: "test-user", name: "Test"},
        {provider: "cloudflare", model: "test", apiToken: ""});
      const files = (await content(1, impl.storage.chatMeta.get(1)!)).get(f.tree.id)!;
      expect(files.get("ordinary.txt")).toBe("ordinary");
      expect(files.get("container.txt")).toBe(accepted ? "container" : undefined);
      if (conflict === "validation") expect(files.get("a.txt")).toBe("One\ntwo\n");
      if (conflict === "canonical") expect(files.get("external.txt")).toBe("canonical");
      if (conflict === "buffered") expect(files.get("later.txt")).toBe("later");
    } finally { registration.mockRestore(); commits.mockRestore(); reads.mockRestore(); paths.mockRestore(); }
  }));

  it("cancels Git on durable final acceptance even when a later edit changes the live revision", () => within(async (impl, f) => {
    impl.addChatMessages(1, author, [{type: "changes", change: {}, createdWorktrees: [
      {worktreeId: f.tree.id, title: "Repo", bindingName: "REPO"},
    ]}]);
    impl.addChatMessages(1, {type: "user", id: "test-user", name: "Test"}, [{type: "message", message: "Run the command."}]);
    bindGit(impl);
    let access!: WorktreeTurnAccess;
    const register = impl.registerWorktreeReplicaTurn.bind(impl);
    const registration = vi.spyOn(impl, "registerWorktreeReplicaTurn").mockImplementation((...args) => {
      access = args[1]; return register(...args);
    });
    const commit = impl.commitAgentStep.bind(impl);
    const commits = vi.spyOn(impl, "commitAgentStep").mockImplementation(async (...args) => {
      const result = await commit(...args);
      if (args[3].replicaCommit?.final) access.appendChange(f.tree.id, "later.txt", {set: "later"});
      return result;
    });
    const faux = createFauxCore({models: [{id: "test"}]});
    faux.setResponses([async () => {
      const mount = await f.context().export("REPO");
      const reader = (await mount.git!.fetch(gitRequest("GIT", true))).body!.getReader();
      expect((await reader.read()).value).toEqual(Uint8Array.of(0, 255, 128, 13));
      const next = reader.read().then(result => result.done, () => true);
      const cancel = vi.fn();
      void next.then(cancel);
      try {
        await mount.writeback.submitChanges("final", [], true);
        expect([...impl.storage.worktreeReplicaLeases.list()][0].released).toBe(true);
        await vi.waitFor(() => expect(cancel).toHaveBeenCalled(), {timeout: 1000});
        expect(await next).toBe(true);
      } finally {
        // An already-errored stream repeats its expected revocation error during cleanup.
        await reader.cancel().catch(() => {});
      }
      return fauxAssistantMessage(fauxText("Done."));
    }]);
    try {
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, author,
        new AbortController().signal, {type: "user", id: "test-user", name: "Test"},
        {provider: "cloudflare", model: "test", apiToken: ""});
    } finally { registration.mockRestore(); commits.mockRestore(); }
  }));

  it("captures Git bindings, observes runtime reads, and expires Git with final writeback", () => within(async (impl, f) => {
    const context = bindGit(impl);
    const mount = await f.context().export("REPO");
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
    const mount = await f.context().export("REPO");
    const reader = (await mount.git!.fetch(gitRequest("GIT", true))).body!.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(0, 255, 128, 13));
    // Native HTTP may report cancellation as EOF rather than an RPC stream error. Either
    // must promptly terminate the read without delivering further repository bytes.
    const next = reader.read().then(result => result.done, () => true);
    await mount.writeback.submitChanges("final", [], true);
    expect(await next).toBe(true);
  }));
  it.each([false, true])("rechecks the Git connection before delivering an open response (removed=%s)", removed => within(async (impl, f) => {
    bindGit(impl);
    const mount = await f.context().export("REPO");
    const reader = (await mount.git!.fetch(gitRequest())).body!.getReader();
    try {
      if (removed) {
        impl.removeGatekeeper(40);
        expect(impl.storage.gatekeepers.get(40)).toBeUndefined();
        // Native response transport may expose revocation as EOF instead of a stream error.
        expect(await reader.read().then(result => result.done, () => true)).toBe(true);
      } else {
        expect((await reader.read()).value).toEqual(Uint8Array.of(0, 255, 128, 13));
        expect((await reader.read()).done).toBe(true);
      }
    } finally { await reader.cancel().catch(() => {}); }
  }));
  it.each(["integration", "repository", "binding", "turn"])("fences Git after %s revocation", edge => within(async (impl, f) => {
    bindGit(impl);
    const mount = await f.context().export("REPO");
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
    const mount = await f.context().export("REPO");
    const changes = [{path: "a.txt", change: {edit: [[3, "ONE"], 5]}}];
    await Promise.all([mount.writeback.submitChanges("same", changes, false),
      mount.writeback.submitChanges("same", changes, false)]);
    expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(1);
    await mount.writeback.submitChanges("final", [], true);
    expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!))
      .get(f.tree.id)?.get("a.txt")).toBe("ONE\ntwo\n");
  }));
  it("recaptures a lost mount reply only before any writeback starts", () => within(async (impl, f) => {
    await f.context().export("REPO");
    const second = await f.context().export("REPO");
    expect([...impl.storage.worktreeReplicaLeases.list()]).toHaveLength(1);
    await second.writeback.submitChanges("one", [{path: "once.txt", change: {set: "once"}}], false);
    await expect(f.context().export("REPO")).rejects.toThrow(/already active/);
    await second.writeback.submitChanges("final", [], true);
  }));

  it("exports matching packs after an in-turn commit and binary edit replace an untouched capture", () => within(async (impl, f) => {
    impl.addChatMessages(1, author, [{type: "changes", change: {}, createdWorktrees: [
      {worktreeId: f.tree.id, title: "Repo", bindingName: "REPO"},
    ]}]);
    impl.addChatMessages(1, {type: "user", id: "test-user", name: "Test"}, [{type: "message", message: "Run the command."}]);
    let access!: WorktreeTurnAccess;
    const register = impl.registerWorktreeReplicaTurn.bind(impl);
    const registration = vi.spyOn(impl, "registerWorktreeReplicaTurn").mockImplementation((...args) => {
      access = args[1]; return register(...args);
    });
    const faux = createFauxCore({models: [{id: "test"}]});
    faux.setResponses([async () => {
      const first = await f.context().export("REPO");
      const version = impl.replicaHistoryRevision(1);
      const repo = new WorktreeSessionImpl(impl, f.tree.id, access, async () => author);
      const commit = await repo.commit("In-turn commit");
      const second = await f.context().export("REPO");
      expect(impl.replicaHistoryRevision(1)).toBe(version);
      const objects = [];
      for (const pack of second.packs) for await (const object of decodePackStream(
        (await pack.fetch("https://export.invalid/")).body!,
        {maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024},
      )) objects.push(object.oid);
      expect(objects).toContain(commit);
      expect(second.id).not.toBe(first.id);
      await expect(first.packs[0].fetch("https://export.invalid/")).rejects.toThrow(/access ended/);
      await repo.writeBytes("pending.bin", Uint8Array.of(0, 255, 128));
      const third = await f.context().export("REPO");
      const pending = third.pendingChanges.find(entry => entry.path === "pending.bin")!.change;
      if (!("setBytes" in pending)) throw new Error("Expected a pending binary edit");
      const blobs = [];
      for await (const object of decodePackStream((await third.packs[0].fetch("https://export.invalid/")).body!,
        {maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024})) blobs.push(object.oid);
      expect(blobs).toContain(pending.setBytes.oid);
      const retry = await f.context().export("REPO");
      expect(retry.id).toBe(third.id);
      expect(retry.pendingChanges).toEqual(third.pendingChanges);
      await retry.writeback.submitChanges("final", [], true);
      return fauxAssistantMessage(fauxText("Done."));
    }]);
    try {
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, author,
        new AbortController().signal, {type: "user", id: "test-user", name: "Test"},
        {provider: "cloudflare", model: "test", apiToken: ""});
    } finally { registration.mockRestore(); }
  }));

  it("preserves a successful recapture when an older overlapping export fails", () => within(async (impl, f) => {
    bindGit(impl);
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const getFacet = impl.getGatekeeperFacet.bind(impl);
    const lookup = vi.spyOn(impl, "getGatekeeperFacet").mockImplementationOnce(async id => {
      entered.resolve();
      await resume.promise;
      return getFacet(id);
    });
    const first = f.context().export("REPO");
    const failure = expect(first).rejects.toThrow("Workspace changed during worktree capture");
    try {
      await entered.promise;
      const second = await f.context().export("REPO");
      await second.writeback.submitChanges("streamed", [{path: "new.txt", change: {set: "retained"}}], false);
      resume.resolve();
      await failure;
      await second.writeback.submitChanges("final", [], true);
      expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!))
        .get(f.tree.id)?.get("new.txt")).toBe("retained");
      expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(2);
    } finally {
      resume.resolve();
      lookup.mockRestore();
    }
  }));

  it("retains the provider error when no authorized source can supply the base pack", () => within(async (impl, f) => {
    bindGit(impl);
    impl.storage.gitObjectMetadata.put({oid: f.commit, type: "commit", onRemote: [40], pullableFrom: [], pendingPush: []});
    const input = await f.context().export("REPO");
    await expect(impl.exportWorktreePack(input.id, true)).rejects.toMatchObject({
      message: "No authorized source can hydrate this Git commit.",
      cause: {message: expect.stringContaining("Unknown remote commit")},
    });
    await input.writeback.submitChanges("final", [], true);
  }));

  it("retains command writeback across segment rotation without reviving an ephemeral context", () => within(async (impl, f) => {
    const context = f.context();
    const first = await context.export("REPO");
    const row = impl.storage.activeAgents.get(1)!;
    impl.storage.activeAgents.put({...row, integration: {...row.integration!, segmentId: crypto.randomUUID()}});
    expect(() => context.check()).toThrow();
    await first.writeback.submitChanges("resumed", [{path: "resumed.txt", change: {set: "same command"}}], false);
    await expect(f.context().export("REPO")).rejects.toThrow(/already active/);
    await first.writeback.submitChanges("after-rejected-mount", [], false);
    await first.writeback.submitChanges("final", [], true);
    const second = await f.context().export("REPO");
    expect([...impl.storage.worktreeReplicaLeases.list()].filter(lease => !lease.released)).toHaveLength(1);
    await second.writeback.submitChanges("final", [], true);
  }));

  it("retries offline writeback through the live view when recovery registers during prefetch", () => within(async (impl, f) => {
    impl.addChatMessages(1, author, [{type: "changes", change: {}, createdWorktrees: [
      {worktreeId: f.tree.id, title: "Repo", bindingName: "REPO"},
    ]}]);
    impl.addChatMessages(1, {type: "user", id: "test-user", name: "Test"}, [{type: "message", message: "Run the command."}]);
    const mount = await f.context().export("REPO");
    const prefetch = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    let access!: WorktreeTurnAccess;
    let observed: string | null | undefined;
    const register = impl.registerWorktreeReplicaTurn.bind(impl);
    const registration = vi.spyOn(impl, "registerWorktreeReplicaTurn").mockImplementation((...args) => {
      access = args[1]; return register(...args);
    });
    const content = impl.getCurrentChatContent.bind(impl);
    let held = false;
    const reads = vi.spyOn(impl, "getCurrentChatContent").mockImplementation(async (...args) => {
      const result = await content(...args);
      if (!held) { held = true; prefetch.resolve(); await resume.promise; }
      return result;
    });
    const writeback = mount.writeback.submitChanges("recovery", [{path: "a.txt", change: {set: "container"}}], false);
    void writeback.catch(() => {});
    await prefetch.promise;
    const faux = createFauxCore({models: [{id: "test"}]});
    faux.setResponses([async () => {
      resume.resolve();
      await writeback;
      observed = await access.readFile(f.tree.id, "a.txt");
      return fauxAssistantMessage(fauxText("Done."));
    }]);
    try {
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, author,
        new AbortController().signal, {type: "user", id: "test-user", name: "Test"},
        {provider: "cloudflare", model: "test", apiToken: ""});
      await writeback;
      expect(observed).toBe("container");
      expect((await content(1, impl.storage.chatMeta.get(1)!)).get(f.tree.id)?.get("a.txt")).toBe("container");
    } finally { resume.resolve(); registration.mockRestore(); reads.mockRestore(); }
  }));

  it("drains an unfinished command after actual DO reset while model lookup is still pending", async () => {
    const name = crypto.randomUUID();
    const gate = Promise.withResolvers<void>();
    const lookup = vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async () => {
      await gate.promise;
      throw new Error("End the synthetic resumed model lookup");
    });
    try {
      const before = await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name), async instance => {
        const impl = instance["impl"], f = await setup(impl);
        const row = impl.storage.activeAgents.get(1)!;
        impl.storage.activeAgents.put({...row, initiatorUserId: impl.users.idFromName(name).toString()});
        const mount = await f.context().export("REPO");
        await mount.writeback.submitChanges("first", [{path: "once.txt", change: {set: "once"}}], false);
        return {leaseId: [...impl.storage.worktreeReplicaLeases.list()][0].id,
          segmentId: row.integration!.segmentId, treeId: f.tree.id};
      });
      await abortAllDurableObjects();
      const owner = testEnv.TEST_OVERSEER.getByName(name);
      const endpoint = await owner.testReplicaEndpoint(before.leaseId);
      await endpoint.submitChanges("final", [{path: "done.txt", change: {set: "drained"}}], true);
      await endpoint.submitChanges("final", [{path: "done.txt", change: {set: "drained"}}], true);
      await runInDurableObject(owner, async instance => {
        const impl = instance["impl"];
        expect(impl.storage.activeAgents.get(1)?.integration?.segmentId).not.toBe(before.segmentId);
        expect([...impl.storage.worktreeReplicaCommits.list()]).toHaveLength(2);
        expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!))
          .get(before.treeId)?.get("done.txt")).toBe("drained");
        gate.resolve();
        await impl.waitForAllAgentsToComplete();
        delete impl.env.AGENT_INTEGRATION_GRANTS;
      });
    } finally { gate.resolve(); lookup.mockRestore(); }
  });
  it("keeps all receipts for delayed reconciliation without scanning completed commands on mount", () => within(async (impl, f) => {
    const first = await f.context().export("REPO");
    await first.writeback.submitChanges("part", [{path: "once.txt", change: {set: "once"}}], false);
    await first.writeback.submitChanges("final", [], true);
    const receipts = [...impl.storage.worktreeReplicaCommits.list()];
    expect(receipts).toHaveLength(2);
    const fullScan = vi.spyOn(impl.storage.worktreeReplicaLeases, "list").mockImplementation(() => {
      throw new Error("Mount must not scan completed command history.");
    });
    try {
      const next = await f.context().export("REPO");
      await next.writeback.submitChanges("final", [], true);
    } finally { fullScan.mockRestore(); }
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 24 * 60 * 60 * 1000);
    try {
      impl.env.AGENT_INTEGRATION_GRANTS = "{}";
      await first.writeback.submitChanges("final", [], true);
      await expect((async () => { await first.writeback.submitChanges("late", [], false); })())
        .rejects.toThrow(/access ended/);
      for (const receipt of receipts) expect(impl.storage.worktreeReplicaCommits.get(receipt.id)).toEqual(receipt);
      expect([...impl.storage.worktreeReplicaLeases.list()]).toHaveLength(2);
    } finally { clock.mockRestore(); }
  }));
  it("captures pending OTs once, exports raw binary packs, and leaves unrelated files lazy", () => within(async (impl, f) => {
    const change = diffFiles(new Map([[f.tree.id, new Map([["a.txt", "one\ntwo\n"]])]]),
      new Map([[f.tree.id, new Map([["a.txt", "ONE\ntwo\n"]])]]));
    await f.step(change);
    const mount = await f.context().export("REPO");
    expect(mount.head).toBe(f.commit);
    expect(mount.pendingChanges).toEqual(change[f.tree.id].map(([path, change]) => ({path, change})));
    const objects = [];
    for (const pack of mount.packs) for await (const object of decodePackStream((await pack.fetch("https://export.invalid/")).body!, {
      maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024,
    })) objects.push(object);
    expect(objects.some(object => object.oid === f.commit && object.type === "commit")).toBe(true);
    expect(objects.some(object => object.type === "blob" && object.payload.includes(0))).toBe(true);
    const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    expect(content.get(f.tree.id)?.has("untouched.txt")).toBe(false);
    await mount.writeback.submitChanges("final", [], true);
  }));

  it("streams multiple small OTs, deduplicates lost replies and closes atomically with the final batch", () => within(async (impl, f) => {
    const mount = await f.context().export("REPO");
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
    const next = await f.context().export("REPO");
    expect(next.pendingChanges).toHaveLength(2);
    await next.writeback.submitChanges("done", [], true);
  }));

  it("rejects concurrent DO edits rather than reconciling or polling", () => within(async (_impl, f) => {
    const mount = await f.context().export("REPO");
    await f.step({[f.tree.id]: [["a.txt", {set: "DO changed"}]]});
    await expect((async () => { await mount.writeback.submitChanges("stale", [{path: "a.txt", change: {set: "container"}}], false); })())
      .rejects.toThrow(/concurrent writers/);
    const next = await f.context().export("REPO");
    await expect((async () => {await mount.writeback.submitChanges("late", [], false);})())
      .rejects.toThrow(/access ended/);
    await next.writeback.submitChanges("final", [], true);
  }));

  it("fails closed on revoked integration access and keeps the final receipt retryable", () => within(async (impl, f) => {
    const mount = await f.context().export("REPO");
    await mount.writeback.submitChanges("authority", [], false);
    impl.env.AGENT_INTEGRATION_GRANTS = "{}";
    await expect((async () => { await mount.writeback.submitChanges("authority", [], false); })()).rejects.toThrow(/access ended/);
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    await mount.writeback.submitChanges("final", [], true);
    impl.env.AGENT_INTEGRATION_GRANTS = "{}";
    await mount.writeback.submitChanges("final", [], true);
  }));

  it.each(["../escape", ".git/config", "a//b", "/root", "a\\b"])("rejects unsafe write path %s", path => within(async (_impl, f) => {
    const mount = await f.context().export("REPO");
    await expect((async () => { await mount.writeback.submitChanges("bad", [{path, change: {set: "bad"}}], false); })())
      .rejects.toThrow(/path|file|Path/);
    await mount.writeback.submitChanges("final", [], true);
  }));

  it("rejects an unknown binding and scopes writes to only the selected worktree", () => within(async (impl, f) => {
    await expect(f.context().export("UNKNOWN")).rejects.toThrow(/binding/);
    const mount = await f.context().export("OTHER");
    await mount.writeback.submitChanges("done", [{path: "new.txt", change: {set: "other"}}], true);
    const content = await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!);
    expect(content.get(f.tree.id)?.has("new.txt") ?? false).toBe(false);
    expect(content.get(f.other.id)?.get("new.txt")).toBe("other");
  }));

  it("returns a final acceptance receipt after actual DO eviction without repeating effects", async () => {
    const name = crypto.randomUUID();
    const leaseId = await runInDurableObject(testEnv.TEST_OVERSEER.getByName(name), async instance => {
      const impl = instance["impl"], f = await setup(impl);
      const mount = await f.context().export("REPO");
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
