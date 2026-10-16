import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {buildPackStream, decodePackStream} from "../src/git-codec";
import {validateChatAttachmentUpload} from "../src/chat-attachment-validation";
import {runAgent} from "../src/agent";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Api, type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import type {CodeChange} from "@gadgets/workshop-shared/code-change";
import {MAX_GIT_OBJECT_SIZE} from "../src/git-cache";
declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
async function inKernel<T>(name: string, test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), instance => test(instance.impl));
}
async function step(impl: Impl, chatId: number, change: CodeChange) {
  await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [{change}], createdGadgets: [],
    createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});
}
async function scriptedTurn(impl: Impl, chatId: number, calls: ReturnType<typeof fauxToolCall>[], api?: Api) {
  // Isolate file operations from compaction of the legacy model-inline attachment payload.
  const faux = createFauxCore({models: [{id: "faux-model", contextWindow: 8_000_000}]});
  const requests: Message[][] = [];
  faux.setResponses(calls.length
    ? [fauxAssistantMessage(calls, {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Done"))]
    : [fauxAssistantMessage(fauxText("Done"))]);
  await runAgent(impl, {model: {...faux.getModel(), ...(api ? {api} : {})}, stream: (model, context, options) => {
    requests.push(structuredClone(context.messages));
    return faux.stream(model, context, options);
  }}, chatId, AUTHOR, new AbortController().signal, USER,
  {provider: "cloudflare", model: "faux-model", apiToken: "", contextWindow: 8_000_000});
  return requests;
}
const fileToolResults = (messages: Message[]) => messages.flatMap(message =>
  message.role === "toolResult" && message.toolName !== "observeUserChanges"
    ? [{toolName: message.toolName, content: message.content, isError: message.isError}] : []);
describe("scratch worktree attachment ingress", () => {
  it("normalizes legacy source metadata without overwriting an already edited scratch file", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID()), id = crypto.randomUUID();
    const original = new TextEncoder().encode("original\n");
    impl.storage.chatAttachmentContent.put({fileId: id, data: original, state: {
      type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name: "notes.txt",
    }});
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect", undefined, [{id}]);
    const context = impl.getChatAgentContext(chatId);
    const worktreeId = context.scratch!.worktreeId;
    delete context.attachmentsMigrated;
    impl.storage.chatContext.put(context);
    await step(impl, chatId, {[worktreeId]: [["notes.txt", {remove: true}], ["renamed.txt", {set: "edited\n"}]]});
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Continue");
    const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
    expect(content.get(worktreeId)?.has("notes.txt")).toBe(false);
    expect(content.get(worktreeId)?.get("renamed.txt")).toBe("edited\n");
    expect(await impl.getChatAttachmentData(chatId, id)).toEqual(original);
    expect(impl.storage.chatAttachmentContent.get(id)?.state).toHaveProperty("oid");
  }));

  it.each([false, true])("resumes legacy migration after eviction into one %s existing scratch worktree", async existing => {
    const name = crypto.randomUUID();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const originals = [new TextEncoder().encode("legacy text\n"), Uint8Array.of(0, 255, 17)];
    let chatId: number, worktreeId: number;
    await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const seed = await impl.gitStore.writeBlob(new TextEncoder().encode("seed\n"));
      chatId = await impl.newChat(user, {profile: USER}, "Old attachments", undefined,
        existing ? [{oid: seed.oid, mimeType: "text/plain", name: "seed.txt"}] : undefined);
      const message = [...impl.storage.chats.list()].find(message => message.type === "message")!;
      if (message.type !== "message") throw new Error("Expected message");
      message.attachments = [...message.attachments ?? [], ...ids.map((id, i) => ({
        id, mimeType: i ? "application/octet-stream" : "text/plain", name: "legacy.txt", size: originals[i].length,
      }))];
      impl.storage.chats.put(message);
      ids.forEach((id, i) => impl.storage.chatAttachmentContent.put({fileId: id, data: originals[i],
        state: {type: "committed", chatId}}));
      const context = impl.getChatAgentContext(chatId);
      delete context.attachmentsMigrated;
      impl.storage.chatContext.put(context);
      const writeBlob = impl.gitStore.writeBlob.bind(impl.gitStore);
      const fault = vi.spyOn(impl.gitStore, "writeBlob").mockImplementation(bytes => {
        if (bytes[0] === 0) return Promise.reject(new Error("migration interrupted"));
        return writeBlob(bytes);
      });
      try {
        await impl.sendChatMessage(user, {profile: USER}, chatId, "Continue");
        expect(impl.getChatAgentContext(chatId).attachmentsMigrated).not.toBe(true);
      } finally { fault.mockRestore(); }
      worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      expect(impl.storage.chatAttachmentContent.get(ids[0])?.data).toBeUndefined();
      expect(impl.storage.chatAttachmentContent.get(ids[1])?.data).toEqual(originals[1]);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Retry");
      const context = impl.getChatAgentContext(chatId);
      expect(context.attachmentsMigrated).toBe(true);
      expect(context.scratch?.worktreeId).toBe(worktreeId);
      const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
      const base = impl.getWorktreePinBase(worktreeId)!;
      const paths = new Set([...(await impl.gitCache.listCommitTreePaths(base)).map(entry => entry.path),
        ...content.get(worktreeId)?.keys() ?? []]);
      expect(paths).toEqual(new Set(existing ? ["seed.txt", "legacy.txt", "legacy-2.txt"] : ["legacy.txt", "legacy-2.txt"]));
      for (const [i, id] of ids.entries()) {
        expect(await impl.getChatAttachmentData(chatId, id)).toEqual(originals[i]);
        expect(impl.storage.chatAttachmentContent.get(id)?.data).toBeUndefined();
        await expect(impl.getChatAttachmentData(chatId + 1, id)).rejects.toThrow("not found");
      }
      const rows = [...impl.storage.chats.list()];
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Again");
      expect([...impl.storage.chats.list()].filter(message => message.type === "changes"))
        .toEqual(rows.filter(message => message.type === "changes"));
      const requests = await scriptedTurn(impl, chatId, []);
      expect(JSON.stringify(requests)).toContain("workspace file env.SCRATCH/legacy-2.txt");
    });
  });

  it("keeps a chat usable across eviction with a missing legacy payload and retries after repair", async () => {
    const name = crypto.randomUUID(), ids = [crypto.randomUUID(), crypto.randomUUID()];
    const original = new TextEncoder().encode("healthy legacy file\n");
    let chatId: number, worktreeId: number;
    await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      chatId = await impl.newChat(user, {profile: USER}, "Old chat");
      const message = [...impl.storage.chats.list()].find(message => message.type === "message")!;
      if (message.type !== "message") throw new Error("Expected message");
      message.attachments = ids.map((id, i) => ({id, mimeType: "text/plain", name: `${i}.txt`, size: original.length}));
      impl.storage.chats.put(message);
      ids.forEach((id, i) => impl.storage.chatAttachmentContent.put({fileId: id,
        ...(i ? {data: original} : {}), state: {type: "committed", chatId}}));
      const context = impl.getChatAgentContext(chatId);
      delete context.attachmentsMigrated;
      impl.storage.chatContext.put(context);
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Continue despite the missing upload");
      expect(impl.getChatAgentContext(chatId).attachmentsMigrated).not.toBe(true);
      worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      expect(await impl.getChatAttachmentData(chatId, ids[1])).toEqual(original);
      const request = JSON.stringify(await scriptedTurn(impl, chatId, []));
      expect(request).toContain("original contents are currently unavailable");
      expect(request).toContain("healthy legacy file");
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Another turn");
      expect(JSON.stringify(await scriptedTurn(impl, chatId, [])))
        .toContain("original contents are currently unavailable");
      // Repairing the source is observed on the next visit; failures are not permanently skipped.
      impl.storage.chatAttachmentContent.put({fileId: ids[0], data: original, state: {type: "committed", chatId}});
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Retry the repaired upload");
      expect(impl.getChatAgentContext(chatId).attachmentsMigrated).toBe(true);
      expect(impl.getChatAgentContext(chatId).scratch?.worktreeId).toBe(worktreeId);
      expect(await impl.getChatAttachmentData(chatId, ids[0])).toEqual(original);
      const request = JSON.stringify(await scriptedTurn(impl, chatId, []));
      expect(request).not.toContain("original contents are currently unavailable");
      expect(request).toContain("env.SCRATCH/0.txt");
      expect(request).not.toContain("1-2.txt");
    });
  });

  it.each(["before publication", "after durable publication"])(
    "retries a transient migration failure %s without duplicate projection", boundary => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID()), id = crypto.randomUUID();
    const chatId = await impl.newChat(user, {profile: USER}, "Old chat");
    const message = [...impl.storage.chats.list()].find(message => message.type === "message")!;
    if (message.type !== "message") throw new Error("Expected message");
    message.attachments = [{id, mimeType: "text/plain", name: "old.txt", size: 3}];
    impl.storage.chats.put(message);
    impl.storage.chatAttachmentContent.put({fileId: id, data: new TextEncoder().encode("old"),
      state: {type: "committed", chatId}});
    const context = impl.getChatAgentContext(chatId);
    delete context.attachmentsMigrated;
    impl.storage.chatContext.put(context);
    const sync = impl.ctx.storage.sync.bind(impl.ctx.storage);
    const fault = boundary === "before publication"
      ? vi.spyOn(impl.gitStore, "writeBlob").mockRejectedValueOnce(new Error("transient failure"))
      : vi.spyOn(impl.ctx.storage, "sync").mockImplementationOnce(async () => {
        await sync();
        throw new Error("migration acknowledgement lost");
      });
    try {
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Continue");
      expect(impl.getChatAgentContext(chatId).attachmentsMigrated).toBe(true);
      expect(fault).toHaveBeenCalledTimes(boundary === "before publication" ? 2 : 1);
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(new TextEncoder().encode("old"));
      const worktree = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      expect((await impl.gitCache.listCommitTreePaths(impl.getWorktreePinBase(worktree)!))
        .map(entry => entry.path)).toEqual(["old.txt"]);
      const stored = [...impl.storage.chats.list()].find(record =>
        record.type === "message" && record.attachments?.length);
      expect(stored?.type === "message" && stored.attachments?.[0].workspacePath).toBe("old.txt");
    } finally { fault.mockRestore(); }
  }));

  it("reads and greps a full-size text upload without changing its byte-backed OT state", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const small = await impl.gitStore.writeBlob(new TextEncoder().encode("seed"));
    const chatId = await impl.newChat(user, {profile: USER}, "Seed", undefined,
      [{oid: small.oid, mimeType: "text/plain", name: "seed.txt"}]);
    const text = "first line\nneedle\n" + "padding\n".repeat(524286);
    // Exact upload cap, with short lines so the model requests only a small window.
    const bytes = new TextEncoder().encode(text.padEnd(4 * 1024 * 1024, "x").slice(0, 4 * 1024 * 1024));
    const ref = await impl.gitStore.writeBlob(bytes);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Inspect", undefined,
      [{oid: ref.oid, mimeType: "text/plain", name: "large.txt"}]);
    const worktree = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    const requests = await scriptedTurn(impl, chatId, [
      fauxToolCall("readFile", {workpiece: "SCRATCH", filename: "large.txt", lineCount: 2}),
      fauxToolCall("grep", {workpiece: "SCRATCH", path: "large.txt", pattern: "needle"}),
    ]);
    const results = fileToolResults(requests.at(-1)!);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.content)).toContain("needle");
    }
    expect((await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!))
      .get(worktree)?.get("large.txt")).toEqual(ref);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Follow up");
    const replay = fileToolResults((await scriptedTurn(impl, chatId, [])).at(-1)!);
    expect(replay).toEqual(results);
  }));

  it.each([false, true])("replays text replacements over a binary %s overlay without reading the obsolete base", existing => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const ref = await impl.gitStore.writeBlob(Uint8Array.of(0, 255));
    const chatId = await impl.newChat(user, {profile: USER}, "Start", undefined,
      existing ? undefined : [{oid: ref.oid, mimeType: "application/octet-stream", name: "data.bin"}]);
    if (existing) {
      const seed = await impl.gitStore.writeBlob(new TextEncoder().encode("seed"));
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Seed", undefined,
        [{oid: seed.oid, mimeType: "text/plain", name: "seed.txt"}]);
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Binary", undefined,
        [{oid: ref.oid, mimeType: "application/octet-stream", name: "data.bin"}]);
    }
    const requests = await scriptedTurn(impl, chatId, [
      fauxToolCall("writeFile", {workpiece: "SCRATCH", filename: "data.bin", content: "replacement\n"}),
      fauxToolCall("readFile", {workpiece: "SCRATCH", filename: "data.bin"}),
      fauxToolCall("editFile", {workpiece: "SCRATCH", filename: "data.bin", textToReplace: "replacement", replacement: "edited"}),
      fauxToolCall("readFile", {workpiece: "SCRATCH", filename: "data.bin"}),
    ]);
    const results = fileToolResults(requests.at(-1)!);
    expect(results).toHaveLength(4);
    for (const result of results) expect(result.isError).toBe(false);
    expect(JSON.stringify(results[1])).toContain("replacement");
    expect(JSON.stringify(results[3])).toContain("edited");
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Follow up");
    const replay = fileToolResults((await scriptedTurn(impl, chatId, [])).at(-1)!);
    expect(replay).toEqual(results);
  }));

  it("keeps large local text readable after byte access and DO eviction", async () => {
    const name = crypto.randomUUID();
    const text = "a".repeat(MAX_GIT_OBJECT_SIZE + 1);
    let commit: string, oid: string;
    await inKernel(name, async impl => {
      commit = await impl.gitStore.writeFilesAsCommit(new Map([["large.txt", text]]), {
        parents: [], author: {name: "Test", email: "test@example.com"},
        message: "Large local text", timestamp: new Date(0),
      });
      expect(await impl.readFileAtCommit(commit, "large.txt")).toBe(text);
      const ref = await impl.gitCache.fileBytesAtCommit(commit, "large.txt");
      expect(ref?.byteLength).toBe(text.length);
      oid = ref!.oid;
      expect(impl.gitCache.readLocalObject(oid)?.payload.byteLength).toBe(text.length);
      expect(await impl.readFileAtCommit(commit, "large.txt")).toBe(text);
      expect((await impl.gitStore.readCommitFiles(commit)).get("large.txt")).toBe(text);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      expect(impl.storage.gitObjects.get(oid)).toBeDefined();
      expect(impl.gitCache.readLocalObject(oid)?.payload.byteLength).toBe(text.length);
      expect(await impl.readFileAtCommit(commit, "large.txt")).toBe(text);
      expect((await impl.gitStore.readCommitFiles(commit)).get("large.txt")).toBe(text);
    });
  });

  it.each([Uint8Array.of(239, 187, 191, 65), Uint8Array.of(255, 65)])(
    "preserves attachment bytes without lossy UTF-8 projection (%j)", bytes => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name: "input.csv",
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()),
        {profile: USER}, "Read this CSV", undefined, [{id}]);
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(bytes);
      const attachment = impl.storage.chatAttachmentContent.get(id)!;
      const context = impl.getChatAgentContext(chatId);
      expect(context.scratch).toBeDefined();
      expect(attachment.data).toBeUndefined();
      const tree = impl.storage.gadgets.get(context.scratch!.worktreeId)!;
      if (tree.type !== "worktree") throw new Error("Expected scratch worktree");
      if (bytes[0] === 255) {
        const value = await impl.gitCache.fileBytesAtCommit(tree.baseCommit, "input.csv");
        expect(impl.gitStore.readBlob(value!.oid, value!.byteLength)).toEqual(bytes);
        await expect(impl.readFileAtCommit(tree.baseCommit, "input.csv")).rejects.toThrow(/not a text file/);
      } else {
        expect(await impl.readFileAtCommit(tree.baseCommit, "input.csv")).toBe("\ufeffA");
      }
    }),
  );

  it.each([512 * 1024 + 1, 4 * 1024 * 1024].flatMap(size =>
    [false, true].flatMap(existing => ["blob", "legacy"].map(source => ({size, existing, source})))))(
    "projects $size-byte text uploads (existing worktree: $existing, $source)", ({size, existing, source}) => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = async (data: Uint8Array, name: string) => {
      if (source === "blob") return {oid: (await impl.gitStore.writeBlob(data)).oid,
        mimeType: "text/plain", name};
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name,
      }});
      return {id};
    };
    const bytes = new TextEncoder().encode("x".repeat(size));
    validateChatAttachmentUpload({content: bytes, mimeType: "text/plain", name: "large.txt"});
    const upload = await stage(bytes, "large.txt");
    const chatId = existing
      ? await impl.newChat(user, {profile: USER}, "Initial", undefined, [await stage(new TextEncoder().encode("small"), "small.txt")])
      : await impl.newChat(user, {profile: USER}, "Read this", undefined, [upload]);
    if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", undefined, [upload]);
    const message = [...impl.storage.chats.list()].findLast(message => message.type === "message" &&
      message.attachments?.some(attachment => attachment.name === "large.txt"));
    if (!message || message.type !== "message") throw new Error("Missing attachment message");
    const id = message.attachments!.find(attachment => attachment.name === "large.txt")!.id;
    const returned = await impl.getChatAttachmentData(chatId, id);
    expect(returned.byteLength).toBe(bytes.byteLength);
    // Verify byte identity without an element-by-element matcher over a large upload.
    expect(await crypto.subtle.digest("SHA-256", returned)).toEqual(await crypto.subtle.digest("SHA-256", bytes));
    expect(impl.storage.chatAttachmentContent.get(id)?.state).toMatchObject({type: "committed", chatId});
    expect(impl.storage.chatAttachmentContent.get(id)?.state).toHaveProperty("workspacePath", "large.txt");
    expect(impl.getChatAgentContext(chatId).scratch).toBeDefined();
    const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    const value = (await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!))
      .get(worktreeId)?.get("large.txt")
      ?? await impl.readFileAtCommit(impl.getWorktreePinBase(worktreeId)!, "large.txt");
    const workspaceBytes = typeof value === "string" ? new TextEncoder().encode(value)
      : impl.gitStore.readBlob(value!.oid, value!.byteLength);
    expect(await crypto.subtle.digest("SHA-256", workspaceBytes)).toEqual(await crypto.subtle.digest("SHA-256", bytes));
    expect([...impl.storage.chats.list()].some(message => message.type === "message" &&
      message.attachments?.some(attachment => attachment.id === id))).toBe(true);
  }));

  it.each([
    {name: "a".repeat(199) + "😀.txt", path: "a".repeat(199)},
    {name: "a".repeat(254) + "😀.txt", path: "a".repeat(200)},
    {name: "😀".repeat(100) + ".txt", path: "😀".repeat(50)},
    {name: "bad-" + String.fromCharCode(0xd800) + ".txt", path: "bad-\ufffd.txt"},
  ].flatMap(file => [false, true].map(existing => ({...file, existing}))))(
    "round-trips Unicode filenames through Git (existing worktree: $existing, $path)", ({name, path, existing}) => inKernel(crypto.randomUUID(), async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const bytes = new TextEncoder().encode("original upload");
      const stage = (name: string) => {
        const upload = validateChatAttachmentUpload({content: bytes, mimeType: "text/plain", name});
        const id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
          type: "staged", uploadedAt: Date.now(), mimeType: upload.mimeType, name: upload.name,
        }});
        return {id};
      };
      const upload = stage(name);
      const chatId = existing
        ? await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage("seed.txt")])
        : await impl.newChat(user, {profile: USER}, "Read this", undefined, [upload]);
      if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", undefined, [upload]);
      const attachment = impl.storage.chatAttachmentContent.get(upload.id)!;
      expect(attachment.data).toBeUndefined();
      expect(attachment.state).toHaveProperty("workspacePath", path);
      expect(new TextEncoder().encode(path).byteLength).toBeLessThanOrEqual(200);
      expect(await impl.getChatAttachmentData(chatId, upload.id)).toEqual(bytes);
    }),
  );

  it.each(["pending", "accepted", "directory"])("does not overwrite %s agent-created attachment-worktree paths", mode => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = (text: string, name: string) => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: new TextEncoder().encode(text), state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name,
      }});
      return {id};
    };
    const chatId = await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage("input", "input.csv")]);
    const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    const generatedPath = mode === "directory" ? "report.csv/part.txt" : "report.csv";
    await step(impl, chatId, {[worktreeId]: [[generatedPath, {set: "agent-created"}]]});
    if (mode === "accepted") expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
    const upload = stage("uploaded", "report.csv");
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Another attachment", undefined, [upload]);
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({workspacePath: "report-2.csv"});
    const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
    expect(content.get(worktreeId)?.get(generatedPath) ?? await impl.readFileAtCommit(impl.getWorktreePinBase(worktreeId)!, generatedPath)).toBe("agent-created");
    expect(content.get(worktreeId)?.get("report-2.csv")).toBe("uploaded");
  }));

  it("reuses deleted generated names but keeps historical upload names reserved", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const original = await impl.gitStore.writeBlob(new TextEncoder().encode("original"));
    const chatId = await impl.newChat(user, {profile: USER}, "Seed", undefined,
      [{oid: original.oid, mimeType: "text/plain", name: "upload.txt"}]);
    const id = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    await step(impl, chatId, {[id]: [["generated.txt", {set: "temporary"}]]});
    await step(impl, chatId, {[id]: [["generated.txt", {remove: true}], ["upload.txt", {remove: true}]]});
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Upload", undefined, [
      {oid: original.oid, mimeType: "text/plain", name: "generated.txt"},
      {oid: original.oid, mimeType: "text/plain", name: "upload.txt"},
    ]);
    const message = [...impl.storage.chats.list()].findLast(message => message.type === "message")!;
    if (message.type !== "message") throw new Error("Expected message");
    expect(message.attachments?.map(ref => ref.workspacePath)).toEqual(["generated.txt", "upload-2.txt"]);
  }));

  const binaryFiles = [
    {name: "photo.png", mimeType: "image/png", content: Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==")},
    {name: "report.pdf", mimeType: "application/pdf", content: new TextEncoder().encode("%PDF-1.7")},
    {name: "archive.zip", mimeType: "application/zip", content: Uint8Array.of(80, 75, 3, 4, 0, 255)},
    {name: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: Uint8Array.of(80, 75, 0, 255)},
    {name: "sound.mp3", mimeType: "audio/mpeg", content: Uint8Array.of(73, 68, 51, 0, 255)},
    {name: "unknown.bin", mimeType: "application/octet-stream", content: Uint8Array.from({length: 256}, (_, i) => i)},
    {name: "empty.bin", mimeType: "application/octet-stream", content: new Uint8Array()},
    {name: "invalid.csv", mimeType: "text/csv", content: Uint8Array.of(255, 65)},
    {name: "nul.txt", mimeType: "text/plain", content: Uint8Array.of(65, 0, 66)},
  ];
  it.each(binaryFiles.flatMap(file => [false, true].flatMap(existing =>
    ["blob", "legacy"].map(source => ({...file, existing, source})))))(
    "projects $name byte-for-byte, including Git transfer (existing worktree: $existing, $source)", ({name, mimeType, content: bytes, existing, source}) => inKernel(crypto.randomUUID(), async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const stage = async (content: Uint8Array, mimeType: string, name: string) => {
        if (source === "blob") return {
          oid: (await impl.gitStore.writeBlob(content)).oid, mimeType, name,
        };
        const upload = validateChatAttachmentUpload({content, mimeType, name});
        const id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: upload.content, state: {
          type: "staged", uploadedAt: Date.now(), mimeType: upload.mimeType, name: upload.name,
        }});
        return {id};
      };
      const upload = await stage(bytes, mimeType, name);
      const chatId = existing
        ? await impl.newChat(user, {profile: USER}, "Initial", undefined, [await stage(new TextEncoder().encode("seed"), "text/plain", "seed.txt")])
        : await impl.newChat(user, {profile: USER}, "Read file", undefined, [upload]);
      if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Another file", undefined, [upload]);
      const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      const overlay = (await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!)).get(worktreeId)?.get(name);
      const value = overlay ?? await impl.gitCache.fileBytesAtCommit(impl.getWorktreePinBase(worktreeId)!, name);
      if (typeof value !== "object") throw new Error("Expected opaque byte content");
      expect(value.byteLength).toBe(bytes.byteLength);
      expect(impl.gitStore.readBlob(value.oid, value.byteLength)).toEqual(bytes);
      const message = [...impl.storage.chats.list()].findLast(message =>
        message.type === "message" && message.attachments?.some(file => file.name === name));
      if (!message || message.type !== "message") throw new Error("Missing attachment message");
      const attachment = message.attachments!.find(file => file.name === name)!;
      expect(await impl.getChatAttachmentData(chatId, attachment.id)).toEqual(bytes);
      expect(impl.storage.chatAttachmentContent.get(attachment.id)?.state).toMatchObject({workspacePath: name});
      if (source === "blob") expect(impl.storage.chatAttachmentContent.get(attachment.id)?.data).toBeUndefined();

      const object = await impl.gitCache.ensureObject(value.oid, {type: "blob"});
      const pack = buildPackStream(1, (async function* () {yield object;})());
      const received = [];
      for await (const item of decodePackStream(pack, {
        maxPackSize: 1024 * 1024, maxObjectSize: 1024 * 1024, resolveBase: () => undefined,
      })) received.push(item);
      expect(received).toEqual([{oid: value.oid, type: "blob", payload: bytes}]);

      const hydrated = impl.hydrateChatMessageForClient(message);
      if (hydrated.type !== "message") throw new Error("Expected message");
      expect(hydrated.attachments?.[0].content).toEqual(mimeType === "image/png" ? bytes : undefined);
    }),
  );

  it.each(["blob", "legacy"])("retains immutable downloads and committed binary workspace edits across DO eviction (%s)", async source => {
    const name = crypto.randomUUID();
    const original = Uint8Array.of(0, 255, 1), updated = Uint8Array.of(0, 128, 2);
    let chatId: number, worktreeId: number, id: string;
    await inKernel(name, async impl => {
      let upload;
      if (source === "blob") {
        upload = {oid: (await impl.gitStore.writeBlob(original)).oid,
          mimeType: "application/octet-stream", name: "data.bin"};
      } else {
        id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: original, state: {
          type: "staged", uploadedAt: Date.now(), mimeType: "application/octet-stream", name: "data.bin",
        }});
        upload = {id};
      }
      chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Initial", undefined, [upload]);
      const message = [...impl.storage.chats.list()].find(message => message.type === "message" && message.chatId === chatId);
      if (!message || message.type !== "message") throw new Error("Missing attachment message");
      id = message.attachments![0].id;
      worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      const replacement = await impl.gitStore.writeBlob(updated);
      await step(impl, chatId, {[worktreeId]: [["data.bin", {setBytes: replacement}]]});
      expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(original);
      const value = await impl.gitCache.fileBytesAtCommit(impl.getWorktreePinBase(worktreeId)!, "data.bin");
      expect(impl.gitStore.readBlob(value!.oid, value!.byteLength)).toEqual(updated);
      await expect(impl.getChatAttachmentData(chatId + 1, id)).rejects.toThrow("not found");
    });
  });

  it.each(binaryFiles.slice(0, 3).concat(binaryFiles.slice(-2)))(
    "tells the model where $name lives without lossy binary decoding", file => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: file.content, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: file.mimeType, name: file.name,
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Inspect the file", undefined, [{id}]);
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([fauxAssistantMessage(fauxText("Acknowledged"))]);
      const requests: Message[][] = [];
      await runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "cloudflare", model: "faux-model", apiToken: ""});
      expect(requests).toHaveLength(1);
      const input = requests[0].find(message => message.role === "user")!;
      if (!Array.isArray(input.content)) throw new Error("Expected attachment parts");
      const text = input.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
      expect(text).toContain(`workspace file env.SCRATCH/${file.name}`);
      expect(text).not.toContain("\ufffd");
      expect(input.content.some(part => part.type === "image")).toBe(file.mimeType === "image/png");
      if (file.mimeType !== "image/png") expect(text).toContain("binary contents are not inlined");
    }),
  );

  it.each([
    {name: "panorama.png", base64: "iVBORw0KGgoAAAANSUhEUgAAIygAAAABCAAAAACWSFqZAAAAH0lEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAADAgQEjKQABNueTHwAAAABJRU5ErkJggg=="},
    {name: "screenshot.png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAACMoCAAAAADkiOyqAAAAKElEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAADwZGUAABmYkvJwAAAABJRU5ErkJggg=="},
  ])("keeps oversized $name byte-exact and out of first-turn and replay model inputs", file => inKernel(crypto.randomUUID(), async impl => {
    // Valid 9000×1 / 1×9000 PNGs, not merely forged dimension headers.
    const bytes = Uint8Array.fromBase64(file.base64);
    const blob = await impl.gitStore.writeBlob(bytes);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect the image", undefined,
      [{oid: blob.oid, mimeType: "image/png", name: file.name}]);
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([fauxAssistantMessage(fauxText("First turn")), fauxAssistantMessage(fauxText("Second turn"))]);
    const requests: Message[][] = [];
    for (let turn = 0; turn < 2; ++turn) {
      if (turn > 0) await impl.sendChatMessage(user, {profile: USER}, chatId, "Follow up");
      await runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "cloudflare", model: "faux-model", apiToken: ""});
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const input = request.find(message => message.role === "user")!;
      if (!Array.isArray(input.content)) throw new Error("Expected attachment parts");
      expect(input.content.some(part => part.type === "image")).toBe(false);
      const text = input.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
      expect(text).toContain(`workspace file env.SCRATCH/${file.name}`);
      expect(text).toContain("binary contents are not inlined");
    }
    const message = [...impl.storage.chats.list()].find(message => message.type === "message" && message.attachments?.length);
    if (!message || message.type !== "message") throw new Error("Missing attachment");
    expect(await impl.getChatAttachmentData(chatId, message.attachments![0].id)).toEqual(bytes);
    const tree = impl.storage.gadgets.get(impl.getChatAgentContext(chatId).scratch!.worktreeId)!;
    if (tree.type !== "worktree") throw new Error("Expected scratch worktree");
    const value = await impl.gitCache.fileBytesAtCommit(tree.baseCommit, file.name);
    expect(impl.gitStore.readBlob(value!.oid, value!.byteLength)).toEqual(bytes);
  }));

  it.each(["image/png", "application/pdf"])(
    "reprojects earlier large images when a later %s crosses the many-image limit", mimeType => inKernel(crypto.randomUUID(), async impl => {
      // Header fixtures exercise projection without decoding pixels or altering original bytes.
      const large = new Uint8Array(24), small = new Uint8Array(24);
      for (const [bytes, width] of [[large, 4000], [small, 2000]] as const) {
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(bytes.buffer);
        view.setUint32(8, 13); view.setUint32(12, 0x49484452);
        view.setUint32(16, width); view.setUint32(20, 1000);
      }
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const blob = await impl.gitStore.writeBlob(large);
      const batch = Array.from({length: 5}, (_, i) => ({oid: blob.oid, mimeType: "image/png", name: `${i}.png`}));
      const chatId = await impl.newChat(user, {profile: USER}, "First five", undefined, batch);
      for (let i = 1; i < 4; ++i) await impl.sendChatMessage(user, {profile: USER}, chatId, "Five more", undefined, batch);
      const imageParts = (messages: Message[]) => messages.flatMap(message =>
        Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []);
      const before = await scriptedTurn(impl, chatId, [], "anthropic-messages");
      expect(imageParts(before[0])).toHaveLength(20);
      const lastBytes = mimeType === "image/png" ? small : new TextEncoder().encode("%PDF-1.7");
      const last = await impl.gitStore.writeBlob(lastBytes);
      await impl.sendChatMessage(user, {profile: USER}, chatId, "One more", undefined,
        [{oid: last.oid, mimeType, name: "last"}]);
      for (let turn = 0; turn < 2; ++turn) {
        if (turn) await impl.sendChatMessage(user, {profile: USER}, chatId, "Replay again");
        const request = (await scriptedTurn(impl, chatId, [], "anthropic-messages"))[0];
        const parts = imageParts(request);
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({type: "image", mimeType, data: lastBytes.toBase64()});
        expect(JSON.stringify(request)).toContain("workspace file env.SCRATCH/0.png");
        expect(JSON.stringify(request)).toContain("binary contents are not inlined");
      }
      const originals = [...impl.storage.chats.list()].flatMap(message =>
        message.type === "message" ? message.attachments ?? [] : []);
      expect(originals).toHaveLength(21);
      for (const attachment of originals.slice(0, 20)) {
        expect(await impl.getChatAttachmentData(chatId, attachment.id)).toEqual(large);
      }
    }),
  );

  it("never scans attachment payloads on text-only sends or namespace allocation", () => inKernel(crypto.randomUUID(), async impl => {
    const list = vi.spyOn(impl.storage.chatAttachmentContent, "list")
      .mockImplementation(() => { throw new Error("Unexpected workspace-wide payload scan"); });
    try {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const first = await impl.newChat(user, {profile: USER}, "No attachments");
      await impl.sendChatMessage(user, {profile: USER}, first, "Still no attachments");
      const blob = await impl.gitStore.writeBlob(new TextEncoder().encode("input"));
      const upload = {oid: blob.oid, mimeType: "text/plain", name: "notes.txt"};
      await impl.sendChatMessage(user, {profile: USER}, first, "First upload", undefined, [upload]);
      const scratch = impl.getChatAgentContext(first).scratch!;
      expect(scratch.bindingName).toBe("SCRATCH");
      await step(impl, first, {[scratch.worktreeId]: [["plan.md", {set: "working plan"}]]});
      await impl.sendChatMessage(user, {profile: USER}, first, "Repeat upload", undefined, [upload]);
      expect(impl.getChatAgentContext(first).scratch).toEqual(scratch);
      const content = await impl.getCurrentChatContent(first, impl.storage.chatMeta.get(first)!);
      expect(content.get(scratch.worktreeId)?.get("plan.md")).toBe("working plan");
      expect(content.get(scratch.worktreeId)?.get("notes-2.txt")).toBe("input");
      const other = await impl.newChat(user, {profile: USER}, "Other chat", undefined, [upload]);
      const otherScratch = impl.getChatAgentContext(other).scratch!;
      expect(otherScratch.worktreeId).not.toBe(scratch.worktreeId);
      const messages = [...impl.storage.chats.list()].filter(m => m.chatId === other && m.type === "message");
      expect(messages[0]).toMatchObject({attachments: [{workspacePath: "notes.txt"}]});
      expect(list).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
    }
  }));

  it("accepts any local Git blob and checks attachment signatures and limits when sending", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const blob = await impl.gitStore.writeBlob(Uint8Array.of(1));
    const upload = {oid: blob.oid, mimeType: "image/png", name: "bad.png"};
    await expect(impl.newChat(user, {profile: USER}, "Bad MIME", undefined, [upload]))
      .rejects.toThrow("does not match its MIME");
    const local = await impl.gitStore.writeBlob(Uint8Array.of(2));
    const chatId = await impl.newChat(user, {profile: USER}, "Local blob", undefined,
      [{oid: local.oid, mimeType: "application/octet-stream"}]);
    expect(impl.getChatAgentContext(chatId).scratch).toBeDefined();
    await expect(impl.newChat(user, {profile: USER}, "Missing blob", undefined,
      [{oid: "a".repeat(40), mimeType: "application/octet-stream"}]))
      .rejects.toThrow("Unknown Git blob");
    const tooBig = await impl.gitStore.writeBlob(new Uint8Array(4 * 1024 * 1024 + 1));
    await expect(impl.newChat(user, {profile: USER}, "Too large", undefined,
      [{oid: tooBig.oid, mimeType: "application/octet-stream"}]))
      .rejects.toThrow("too large");
  }));
});
