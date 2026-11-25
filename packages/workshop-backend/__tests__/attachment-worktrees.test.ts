import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {buildPackStream, decodePackStream} from "../src/git-codec";
import {assertChatAttachmentSize, MAX_INLINE_ATTACHMENT_BYTES, MAX_INLINE_MESSAGE_BYTES, validateChatAttachmentUpload} from "../src/chat-attachment-validation";
import {MAX_TOOL_RESULT_CHARS, runAgent} from "../src/agent";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, getCurrentSystemPrompt, type Api, type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {replaceSpanChange, type CodeChange} from "@gadgets/workshop-shared/code-change";
import {MAX_WHOLE_TEXT_BYTES} from "../src/git-cache";
import type {AiChatStreamEvent} from "@gadgets/workshop-shared/api";
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
// `summary` answers a compaction the turn runs first.
async function scriptedTurn(impl: Impl, chatId: number, calls: ReturnType<typeof fauxToolCall>[], api?: Api,
                            summary?: string) {
  const faux = createFauxCore({models: [{id: "faux-model"}]});
  const requests: Message[][] = [];
  faux.setResponses([
    ...summary === undefined ? [] : [fauxAssistantMessage(fauxText(summary))],
    ...calls.length
      ? [fauxAssistantMessage(calls, {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Done"))]
      : [fauxAssistantMessage(fauxText("Done"))],
  ]);
  await runAgent(impl, {model: {...faux.getModel(), ...(api ? {api} : {})}, stream: (model, context, options) => {
    requests.push(structuredClone(context.messages));
    return faux.stream(model, context, options);
  }}, chatId, AUTHOR, new AbortController().signal, USER,
  {provider: "cloudflare", model: "faux-model", apiToken: ""});
  return requests;
}
// A PNG header claiming `width`×1000 pixels, padded to `size` bytes: projection reads only headers.
const pngOfSize = (size: number, width: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, 1000);
  return bytes;
};
const imageParts = (messages: Message[]) => messages.flatMap(message =>
  Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []);
const fileToolResults = (messages: Message[]) => messages.flatMap(message =>
  message.role === "toolResult" && message.toolName !== "observeUserChanges"
    ? [{toolName: message.toolName, content: message.content, isError: message.isError}] : []);
describe("attachment worktree ingress", () => {
  it("publishes EOF reference pins before tools run, persisting them with the completed step", () => inKernel(crypto.randomUUID(), async impl => {
    const oid = impl.gitCache.writeBlob(new TextEncoder().encode("column\nvalue\n")).oid;
    const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Read this", "auto",
        {attachments: [{oid, name: "report.csv", mimeType: "text/csv"}]});
    const source = 'worktree://ATTACHMENTS/report.csv';
    const events: AiChatStreamEvent[] = [];
    impl.emitChatStreamEvent = (_chatId, event) => events.push(event);
    const release = Promise.withResolvers<void>();
    const execute = vi.spyOn(impl, "executeCodeMode").mockImplementation(async () => {
      await release.promise;
      return "Done";
    });
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([
      fauxAssistantMessage([fauxText(`[Download][file]\n\n[file]: ${source}`),
        fauxToolCall("executeCode", {code: "await slowOperation()"})], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done")),
    ]);
    const running = runAgent(impl, {model: faux.getModel(), stream: faux.stream}, chatId,
        AUTHOR, new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalled());
      expect(events.flatMap(event => event.type === "textDelta" && event.embeds ? [event.embeds] : []))
          .toEqual([{[source]: oid}]);
      expect([...impl.storage.chats.list()].some(message => message.type === "message" && message.embeds)).toBe(false);
    } finally {
      release.resolve();
      await running;
      execute.mockRestore();
    }
    expect([...impl.storage.chats.list()].flatMap(message =>
        message.type === "message" && message.embeds ? [message.embeds] : [])).toEqual([{[source]: oid}]);
  }));

  it.each(["image", "file"])("pins streamed %s references across edits/deletion and a DO reset", async kind => {
    const path = kind === "image" ? "image.png" : "output.zip";
    const name = crypto.randomUUID(), source = `worktree://OUTPUTS/${path}`;
    let chatId: number, original: string, updated: string;
    await inKernel(name, async impl => {
      chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Draw an image", "auto");
      await scriptedTurn(impl, chatId, [fauxToolCall("createWorktree", {
        title: "Generated images", bindingName: "OUTPUTS",
      })]);
      const creation = [...impl.storage.chats.list()].flatMap(message =>
          message.type === "message" ? message.toolCalls ?? [] : [])
          .find(call => call.toolName === "createWorktree")!;
      expect(creation.error).toBeUndefined();
      if (creation.toolName !== "createWorktree") throw new Error("Expected createWorktree");
      const worktreeId = creation.output!.worktreeId;
      expect(await impl.gitCache.listCommitTreePaths(creation.output!.baseCommit)).toEqual([]);
      expect(impl.getChatAgentContext(chatId).scratch).toBeUndefined();
      original = impl.gitCache.writeBlob(Uint8Array.of(0, 255, 17)).oid;
      updated = impl.gitCache.writeBlob(Uint8Array.of(0, 255, 18)).oid;
      await step(impl, chatId, {[worktreeId]: [[path, {setBytes: {oid: original, byteLength: 3}}]]});
      const answer = async () => {
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Show the current image."}]);
        const events: AiChatStreamEvent[] = [];
        impl.emitChatStreamEvent = (_chatId, event) => events.push(event);
        const faux = createFauxCore({models: [{id: "faux-model"}]});
        faux.setResponses([fauxAssistantMessage(fauxText(`${kind === "image" ? "!" : ""}[Result](${source})`))]);
        await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, chatId,
            AUTHOR, new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
        return events.flatMap(event => event.type === "textDelta" && event.embeds ? [event.embeds] : []);
      };
      expect(await answer()).toEqual([{[source]: original}]);
      await step(impl, chatId, {[worktreeId]: [[path, {setBytes: {oid: updated, byteLength: 3}}]]});
      expect(await answer()).toEqual([{[source]: updated}]);
      await step(impl, chatId, {[worktreeId]: [[path, {remove: true}]]});
      expect(await answer()).toEqual([{[source]: null}]);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const messages = [...impl.storage.chats.list()].filter(message => message.chatId === chatId);
      expect(messages.flatMap(message => message.type === "message" && message.embeds ? [message.embeds] : []))
          .toEqual([{[source]: original}, {[source]: updated}, {[source]: null}]);
      expect(impl.gitCache.readBlob(original)).toEqual(Uint8Array.of(0, 255, 17));
      expect(impl.gitCache.readBlob(updated)).toEqual(Uint8Array.of(0, 255, 18));
    });
  });

  it("does not create a worktree for a chat without uploads", () => inKernel(crypto.randomUUID(), async impl => {
    const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Hello", "auto");
    await scriptedTurn(impl, chatId, []);
    await impl.prepareChatBindings(chatId, []);
    expect(impl.getChatAgentContext(chatId).scratch).toBeUndefined();
    expect([...impl.storage.gadgets.list()]).toEqual([]);
  }));

  it.each([false, true])("announces uploads in the transcript without changing the system prompt (initial: %s)", initial => inKernel(crypto.randomUUID(), async impl => {
    const id = impl.allocateWorkpieceId();
    impl.storage.gadgets.put({type: "gadget", id, title: "App", created: new Date(),
      bindingName: "ATTACHMENTS", bindings: {}});
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const oid = impl.gitCache.writeBlob(new TextEncoder().encode("uploaded")).oid;
    const upload = {oid, name: "input.txt", mimeType: "text/plain"};
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect", "auto",
      {attachments: initial ? [upload] : undefined});
    const first = await scriptedTurn(impl, chatId, []);
    const system = getCurrentSystemPrompt(first[0]);
    if (initial) impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    else await impl.sendChatMessage(user, {profile: USER}, chatId, "First upload", {attachments: [upload]});
    expect(impl.getChatAgentContext(chatId).scratch?.bindingName).toBe("ATTACHMENTS_2");
    // Also exercise a following turn, which reuses the cached workspace prompt.
    for (let i = 0; i < 2; i++) {
      const requests = await scriptedTurn(impl, chatId, []);
      expect(getCurrentSystemPrompt(requests[0])).toEqual(system);
      expect(getCurrentSystemPrompt(requests[0])).not.toContain("This chat's scratch worktree is");
      expect(JSON.stringify(requests[0])).toContain("workspace file env.ATTACHMENTS_2/input.txt");
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    }
  }));

  it("keeps an existing SCRATCH binding when receiving more attachments", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const oid = impl.gitCache.writeBlob(new TextEncoder().encode("uploaded")).oid;
    const upload = {oid, name: "input.txt", mimeType: "text/plain"};
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect", "auto", {attachments: [upload]});
    const context = impl.getChatAgentContext(chatId);
    const {worktreeId, bindingName} = context.scratch!;
    context.scratch = {worktreeId, bindingName: "SCRATCH"};
    if (context.bindings) {
      delete context.bindings[bindingName];
      context.bindings.SCRATCH = worktreeId;
    }
    impl.storage.chatContext.put(context);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Another upload", {attachments: [upload]});
    const requests = await scriptedTurn(impl, chatId, [
      fauxToolCall("readFile", {workpiece: "SCRATCH", filename: "input-2.txt"}),
    ]);
    expect(impl.getChatAgentContext(chatId).scratch).toEqual({worktreeId, bindingName: "SCRATCH"});
    expect([...impl.storage.gadgets.list()].filter(record => record.type === "worktree")).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("workspace file env.SCRATCH/input-2.txt");
    expect(JSON.stringify(fileToolResults(requests[1]))).toContain("uploaded");
  }));

  it("normalizes legacy source metadata without overwriting an already edited scratch file", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID()), id = crypto.randomUUID();
    const original = new TextEncoder().encode("original\n");
    impl.storage.chatAttachmentContent.put({fileId: id, data: original, state: {
      type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name: "notes.txt",
    }});
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect", "auto", {attachments: [{id}]});
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
      const seed = await impl.gitCache.writeBlob(new TextEncoder().encode("seed\n"));
      chatId = await impl.newChat(user, {profile: USER}, "Old attachments", "auto", {attachments:
        existing ? [{oid: seed.oid, mimeType: "text/plain", name: "seed.txt"}] : undefined});
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
      const writeBlob = impl.gitCache.writeBlob.bind(impl.gitCache);
      const fault = vi.spyOn(impl.gitCache, "writeBlob").mockImplementation(bytes => {
        if (bytes[0] === 0) throw new Error("migration interrupted");
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
      expect(JSON.stringify(requests)).toContain("workspace file env.ATTACHMENTS/legacy-2.txt");
    });
  });

  it("keeps a chat usable across eviction with a missing legacy payload and retries after repair", async () => {
    const name = crypto.randomUUID(), ids = [crypto.randomUUID(), crypto.randomUUID()];
    const original = new TextEncoder().encode("healthy legacy file\n");
    let chatId: number, worktreeId: number;
    await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      chatId = await impl.newChat(user, {profile: USER}, "Old chat", "auto");
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
      expect(request).toContain("env.ATTACHMENTS/0.txt");
      expect(request).not.toContain("1-2.txt");
    });
  });

  it.each(["before publication", "after durable publication"])(
    "retries a transient migration failure %s without duplicate projection", boundary => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID()), id = crypto.randomUUID();
    const chatId = await impl.newChat(user, {profile: USER}, "Old chat", "auto");
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
      ? vi.spyOn(impl.gitCache, "writeBlob").mockImplementationOnce(() => {
        throw new Error("transient failure");
      })
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
    const small = await impl.gitCache.writeBlob(new TextEncoder().encode("seed"));
    const chatId = await impl.newChat(user, {profile: USER}, "Seed", "auto", {attachments:
      [{oid: small.oid, mimeType: "text/plain", name: "seed.txt"}]});
    const text = "first line\nneedle\n" + "padding\n".repeat(524286);
    // Far over MAX_BUFFERED_BLOB_SIZE, so named by its blob, with short lines so the model
    // requests only a small window.
    const bytes = new TextEncoder().encode(text.padEnd(4 * 1024 * 1024, "x").slice(0, 4 * 1024 * 1024));
    const ref = await impl.gitCache.writeBlob(bytes);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Inspect", {attachments:
      [{oid: ref.oid, mimeType: "text/plain", name: "large.txt"}]});
    const worktree = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    const requests = await scriptedTurn(impl, chatId, [
      fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "large.txt", lineCount: 2}),
      fauxToolCall("grep", {workpiece: "ATTACHMENTS", path: "large.txt", pattern: "needle"}),
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

  it("accepts a workpiece written with the env. prefix the attachment note uses", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const ref = await impl.gitCache.writeBlob(new TextEncoder().encode("hello needle\n"));
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect", "auto",
      {attachments: [{oid: ref.oid, mimeType: "text/plain", name: "notes.txt"}]});
    const requests = await scriptedTurn(impl, chatId, [
      fauxToolCall("readFile", {workpiece: "env.ATTACHMENTS", filename: "notes.txt"}),
      fauxToolCall("grep", {workpiece: "env.ATTACHMENTS", pattern: "needle"}),
    ]);
    const results = fileToolResults(requests.at(-1)!);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result.content)).toContain("needle");
    }
  }));

  // An edit saved before the whole-text limit existed still applies to its base on replay, and
  // the file, whose text replay holds anyway, can still be edited. A first edit of a file that
  // large is refused before it is read.
  it("replays a saved edit of a file over the whole-text limit, and refuses a first one", async () => {
    const name = crypto.randomUUID();
    const text = "a row of the forecast\n".repeat(Math.ceil((MAX_WHOLE_TEXT_BYTES + 1) / 22));
    const {chatId, worktreeId} = await inKernel(name, async impl => {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const ref = impl.gitCache.writeBlob(new TextEncoder().encode(text));
      const chatId = await impl.newChat(user, {profile: USER}, "The forecasts", "auto", {attachments: [
        {oid: ref.oid, mimeType: "text/csv", name: "edited.csv"},
        {oid: ref.oid, mimeType: "text/csv", name: "untouched.csv"}]});
      const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      // As the code before the limit saved it, reading the base whole.
      const readFileAtCommit = impl.readFileAtCommit.bind(impl);
      impl.readFileAtCommit = (commit: string, path: string) => readFileAtCommit(commit, path);
      await step(impl, chatId, {[worktreeId]: [["edited.csv",
        {edit: replaceSpanChange(text.length, 0, "a row", "A ROW")}]]});
      impl.readFileAtCommit = readFileAtCommit;
      return {chatId, worktreeId};
    });
    // A fresh object, with nothing cached, folds and replays the saved edit over the base.
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
      expect(content.get(worktreeId)!.get("edited.csv")).toMatch(/^A ROW of the/);
      const window = (filename: string) =>
        fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename, lineCount: 2});
      const edit = (filename: string, textToReplace: string) => fauxToolCall("editFile",
        {workpiece: "ATTACHMENTS", filename, textToReplace, replacement: "The row"});
      const requests = await scriptedTurn(impl, chatId, [
        window("edited.csv"), edit("edited.csv", "A ROW"),
        window("untouched.csv"), edit("untouched.csv", "a row")]);
      const [, edited, , untouched] = fileToolResults(requests.at(-1)!);
      expect(edited.isError).toBe(false);
      expect(untouched.isError).toBe(true);
      expect(JSON.stringify(untouched.content)).toContain("too large to read or edit as whole text");
    });
  });

  it.each([false, true])("replays text replacements over a binary %s overlay without reading the obsolete base", existing => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const ref = await impl.gitCache.writeBlob(Uint8Array.of(0, 255));
    const chatId = await impl.newChat(user, {profile: USER}, "Start", "auto", {attachments:
      existing ? undefined : [{oid: ref.oid, mimeType: "application/octet-stream", name: "data.bin"}]});
    if (existing) {
      const seed = await impl.gitCache.writeBlob(new TextEncoder().encode("seed"));
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Seed", {attachments:
        [{oid: seed.oid, mimeType: "text/plain", name: "seed.txt"}]});
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Binary", {attachments:
        [{oid: ref.oid, mimeType: "application/octet-stream", name: "data.bin"}]});
    }
    const requests = await scriptedTurn(impl, chatId, [
      fauxToolCall("writeFile", {workpiece: "ATTACHMENTS", filename: "data.bin", content: "replacement\n"}),
      fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "data.bin"}),
      fauxToolCall("editFile", {workpiece: "ATTACHMENTS", filename: "data.bin", textToReplace: "replacement", replacement: "edited"}),
      fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "data.bin"}),
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
    // Over 8 MB, so stored chunked.
    const text = "a".repeat(8_000_001);
    let commit: string, oid: string;
    await inKernel(name, async impl => {
      commit = await impl.gitCache.writeFilesAsCommit(new Map([["large.txt", text]]), {
        parents: [], author: {name: "Test", email: "test@example.com"},
        message: "Large local text", timestamp: new Date(0),
      });
      expect(await impl.readFileAtCommit(commit, "large.txt")).toBe(text);
      const ref = await impl.gitCache.fileBytesAtCommit(commit, "large.txt");
      expect(ref?.byteLength).toBe(text.length);
      oid = ref!.oid;
      expect(impl.gitCache.readLocalObject(oid)?.payload.byteLength).toBe(text.length);
      expect(await impl.readFileAtCommit(commit, "large.txt")).toBe(text);
      expect(impl.gitCache.readCommitFiles(commit).get("large.txt")).toBe(text);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      expect(impl.storage.gitObjects.get(oid)).toHaveProperty("chunks");
      expect(impl.gitCache.readLocalObject(oid)?.payload.byteLength).toBe(text.length);
      expect(await impl.readFileAtCommit(commit, "large.txt")).toBe(text);
      expect(impl.gitCache.readCommitFiles(commit).get("large.txt")).toBe(text);
    });
  });

  it.each([Uint8Array.of(239, 187, 191, 65), Uint8Array.of(255, 65)])(
    "preserves attachment bytes without lossy UTF-8 projection (%j)", bytes => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name: "input.csv",
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()),
        {profile: USER}, "Read this CSV", "auto", {attachments: [{id}]});
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(bytes);
      const attachment = impl.storage.chatAttachmentContent.get(id)!;
      const context = impl.getChatAgentContext(chatId);
      expect(context.scratch).toBeDefined();
      expect(attachment.data).toBeUndefined();
      const tree = impl.storage.gadgets.get(context.scratch!.worktreeId)!;
      if (tree.type !== "worktree") throw new Error("Expected scratch worktree");
      if (bytes[0] === 255) {
        const value = await impl.gitCache.fileBytesAtCommit(tree.baseCommit, "input.csv");
        expect(impl.gitCache.readBlob(value!.oid, value!.byteLength)).toEqual(bytes);
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
      if (source === "blob") return {oid: (await impl.gitCache.writeBlob(data)).oid,
        mimeType: "text/plain", name};
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name,
      }});
      return {id};
    };
    const bytes = new TextEncoder().encode("x".repeat(size));
    assertChatAttachmentSize(bytes.byteLength);
    const upload = await stage(bytes, "large.txt");
    const chatId = existing
      ? await impl.newChat(user, {profile: USER}, "Initial", "auto", {attachments: [await stage(new TextEncoder().encode("small"), "small.txt")]})
      : await impl.newChat(user, {profile: USER}, "Read this", "auto", {attachments: [upload]});
    if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", {attachments: [upload]});
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
      : impl.gitCache.readBlob(value!.oid, value!.byteLength);
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
        const upload = validateChatAttachmentUpload({leadingBytes: bytes, mimeType: "text/plain", name});
        const id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
          type: "staged", uploadedAt: Date.now(), mimeType: upload.mimeType, name: upload.name,
        }});
        return {id};
      };
      const upload = stage(name);
      const chatId = existing
        ? await impl.newChat(user, {profile: USER}, "Initial", "auto", {attachments: [stage("seed.txt")]})
        : await impl.newChat(user, {profile: USER}, "Read this", "auto", {attachments: [upload]});
      if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", {attachments: [upload]});
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
    const chatId = await impl.newChat(user, {profile: USER}, "Initial", "auto", {attachments: [stage("input", "input.csv")]});
    const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    const generatedPath = mode === "directory" ? "report.csv/part.txt" : "report.csv";
    await step(impl, chatId, {[worktreeId]: [[generatedPath, {set: "agent-created"}]]});
    if (mode === "accepted") expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
    const upload = stage("uploaded", "report.csv");
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Another attachment", {attachments: [upload]});
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({workspacePath: "report-2.csv"});
    const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
    expect(content.get(worktreeId)?.get(generatedPath) ?? await impl.readFileAtCommit(impl.getWorktreePinBase(worktreeId)!, generatedPath)).toBe("agent-created");
    expect(content.get(worktreeId)?.get("report-2.csv")).toBe("uploaded");
  }));

  it("reuses deleted generated names but keeps historical upload names reserved", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const original = await impl.gitCache.writeBlob(new TextEncoder().encode("original"));
    const chatId = await impl.newChat(user, {profile: USER}, "Seed", "auto", {attachments:
      [{oid: original.oid, mimeType: "text/plain", name: "upload.txt"}]});
    const id = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    await step(impl, chatId, {[id]: [["generated.txt", {set: "temporary"}]]});
    await step(impl, chatId, {[id]: [["generated.txt", {remove: true}], ["upload.txt", {remove: true}]]});
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Upload", {attachments: [
      {oid: original.oid, mimeType: "text/plain", name: "generated.txt"},
      {oid: original.oid, mimeType: "text/plain", name: "upload.txt"},
    ]});
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
          oid: (await impl.gitCache.writeBlob(content)).oid, mimeType, name,
        };
        const upload = validateChatAttachmentUpload({leadingBytes: content, mimeType, name});
        const id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: upload.leadingBytes, state: {
          type: "staged", uploadedAt: Date.now(), mimeType: upload.mimeType, name: upload.name,
        }});
        return {id};
      };
      const upload = await stage(bytes, mimeType, name);
      const chatId = existing
        ? await impl.newChat(user, {profile: USER}, "Initial", "auto", {attachments: [await stage(new TextEncoder().encode("seed"), "text/plain", "seed.txt")]})
        : await impl.newChat(user, {profile: USER}, "Read file", "auto", {attachments: [upload]});
      if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Another file", {attachments: [upload]});
      const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      const overlay = (await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!)).get(worktreeId)?.get(name);
      const value = overlay ?? await impl.gitCache.fileBytesAtCommit(impl.getWorktreePinBase(worktreeId)!, name);
      if (typeof value !== "object") throw new Error("Expected opaque byte content");
      expect(value.byteLength).toBe(bytes.byteLength);
      expect(impl.gitCache.readBlob(value.oid, value.byteLength)).toEqual(bytes);
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
        upload = {oid: (await impl.gitCache.writeBlob(original)).oid,
          mimeType: "application/octet-stream", name: "data.bin"};
      } else {
        id = crypto.randomUUID();
        impl.storage.chatAttachmentContent.put({fileId: id, data: original, state: {
          type: "staged", uploadedAt: Date.now(), mimeType: "application/octet-stream", name: "data.bin",
        }});
        upload = {id};
      }
      chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Initial", "auto", {attachments: [upload]});
      const message = [...impl.storage.chats.list()].find(message => message.type === "message" && message.chatId === chatId);
      if (!message || message.type !== "message") throw new Error("Missing attachment message");
      id = message.attachments![0].id;
      worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
      const replacement = await impl.gitCache.writeBlob(updated);
      await step(impl, chatId, {[worktreeId]: [["data.bin", {setBytes: replacement}]]});
      expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(original);
      const value = await impl.gitCache.fileBytesAtCommit(impl.getWorktreePinBase(worktreeId)!, "data.bin");
      expect(impl.gitCache.readBlob(value!.oid, value!.byteLength)).toEqual(updated);
      await expect(impl.getChatAttachmentData(chatId + 1, id)).rejects.toThrow("not found");
    });
  });

  it.each(binaryFiles.slice(0, 3).concat(binaryFiles.slice(-2)))(
    "tells the model where $name lives without lossy binary decoding", file => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: file.content, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: file.mimeType, name: file.name,
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Inspect the file", "auto", {attachments: [{id}]});
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
      expect(text).toContain(`workspace file env.ATTACHMENTS/${file.name}`);
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
    const blob = await impl.gitCache.writeBlob(bytes);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const chatId = await impl.newChat(user, {profile: USER}, "Inspect the image", "auto", {attachments:
      [{oid: blob.oid, mimeType: "image/png", name: file.name}]});
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
      expect(text).toContain(`workspace file env.ATTACHMENTS/${file.name}`);
      expect(text).toContain("binary contents are not inlined");
    }
    const message = [...impl.storage.chats.list()].find(message => message.type === "message" && message.attachments?.length);
    if (!message || message.type !== "message") throw new Error("Missing attachment");
    expect(await impl.getChatAttachmentData(chatId, message.attachments![0].id)).toEqual(bytes);
    const tree = impl.storage.gadgets.get(impl.getChatAgentContext(chatId).scratch!.worktreeId)!;
    if (tree.type !== "worktree") throw new Error("Expected scratch worktree");
    const value = await impl.gitCache.fileBytesAtCommit(tree.baseCommit, file.name);
    expect(impl.gitCache.readBlob(value!.oid, value!.byteLength)).toEqual(bytes);
  }));

  // Inlined text is resent on every turn, and a large upload alone can exceed the model's window,
  // which compaction cannot fix. Past what readFile would return whole, the model gets the path.
  // A first upload creates the scratch worktree; a later one reaches it as a user change.
  it("inlines text that fits one tool result and gives larger text only by its workspace path", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const upload = async (name: string, text: string) =>
      ({oid: (await impl.gitCache.writeBlob(new TextEncoder().encode(text))).oid, mimeType: "text/plain", name});
    const fits = "fits\n".padEnd(MAX_TOOL_RESULT_CHARS, "f");
    const large = "needle\n".padEnd(MAX_TOOL_RESULT_CHARS + 1, "l");
    const chatId = await impl.newChat(user, {profile: USER}, "Read these", "auto", {attachments:
      [await upload("fits.txt", fits), await upload("first.txt", large)]});
    const requests = await scriptedTurn(impl, chatId, []);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "And this", {attachments:
      [await upload("later.txt", large)]});
    requests.push(...await scriptedTurn(impl, chatId, []));
    expect(requests).toHaveLength(2);
    const texts = requests.map(request => request.flatMap(message => {
      const parts: {type: string, text?: string}[] =
        typeof message.content === "string" ? [{type: "text", text: message.content}] : message.content;
      return parts.flatMap(part => part.type === "text" && part.text !== undefined ? [part.text] : []);
    }).join("\n"));
    for (const text of texts) {
      expect(text).toContain(fits);
      expect(text).toContain("env.ATTACHMENTS/first.txt");
      expect(text).not.toContain("needle");
    }
    expect(texts[1]).toContain("env.ATTACHMENTS/later.txt");
  }));

  it.each(["image/png", "application/pdf"])(
    "compacts before a later %s takes the chat past 20 inline images and PDFs", mimeType => inKernel(crypto.randomUUID(), async impl => {
      // Header fixtures exercise projection without decoding pixels or altering original bytes.
      const large = new Uint8Array(24), small = new Uint8Array(24);
      for (const [bytes, width] of [[large, 4000], [small, 2000]] as const) {
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(bytes.buffer);
        view.setUint32(8, 13); view.setUint32(12, 0x49484452);
        view.setUint32(16, width); view.setUint32(20, 1000);
      }
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const blob = await impl.gitCache.writeBlob(large);
      const batch = Array.from({length: 5}, (_, i) => ({oid: blob.oid, mimeType: "image/png", name: `${i}.png`}));
      const chatId = await impl.newChat(user, {profile: USER}, "First five", "auto", {attachments: batch});
      for (let i = 1; i < 4; ++i) await impl.sendChatMessage(user, {profile: USER}, chatId, "Five more", {attachments: batch});
      const before = await scriptedTurn(impl, chatId, [], "anthropic-messages");
      expect(imageParts(before[0])).toHaveLength(20);
      const lastBytes = mimeType === "image/png" ? small : new TextEncoder().encode("%PDF-1.7");
      const last = await impl.gitCache.writeBlob(lastBytes);
      await impl.sendChatMessage(user, {profile: USER}, chatId, "One more", {attachments:
        [{oid: last.oid, mimeType, name: "last"}]});
      // The summary request carries none of them, and the turn keeps the messages whose
      // attachments fit, as earlier requests showed them, at their full 4000 pixels.
      const [summary, compacted] = await scriptedTurn(impl, chatId, [], "anthropic-messages", "Summary of the first five.");
      expect(imageParts(summary)).toHaveLength(0);
      const parts = imageParts(compacted);
      expect(parts).toHaveLength(16);
      expect(parts.at(-1)).toMatchObject({type: "image", mimeType, data: lastBytes.toBase64()});
      expect(parts.filter(part => part.type === "image" && part.data === large.toBase64())).toHaveLength(15);
      expect(JSON.stringify(compacted)).toContain("Summary of the first five.");
      expect(JSON.stringify(compacted)).not.toContain("First five");
      // A later turn extends that request rather than rewriting it.
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Replay again");
      expect(imageParts((await scriptedTurn(impl, chatId, [], "anthropic-messages"))[0])).toEqual(parts);
      const originals = [...impl.storage.chats.list()].flatMap(message =>
        message.type === "message" ? message.attachments ?? [] : []);
      expect(originals).toHaveLength(21);
      for (const attachment of originals.slice(0, 20)) {
        expect(await impl.getChatAttachmentData(chatId, attachment.id)).toEqual(large);
      }
    }),
  );

  // Whether an image is inline depends only on its own message, so later messages never change
  // how an earlier one is shown. One past the limits is named by workspace path, unread.
  it("decides each image within its own message, and compacts once the chat's pass the byte limit", () => inKernel(crypto.randomUUID(), async impl => {
    const upload = async (name: string, size: number, width: number) =>
      ({oid: impl.gitCache.writeBlob(pngOfSize(size, width)).oid, mimeType: "image/png", name});
    const share = Math.floor(MAX_INLINE_MESSAGE_BYTES / 2.5);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    // The third of these passes the message's byte limit; the last passes the per-file one.
    const chatId = await impl.newChat(user, {profile: USER}, "Photos", "auto", {attachments: [
      await upload("a.png", share, 1), await upload("b.png", share, 2),
      await upload("c.png", share, 3), await upload("huge.png", MAX_INLINE_ATTACHMENT_BYTES + 1, 4)]});
    const attachmentName = (id: string) => [...impl.storage.chats.list()].flatMap(message =>
      message.type === "message" ? message.attachments ?? [] : []).find(attachment => attachment.id === id)?.name;
    const read = vi.spyOn(impl, "getChatAttachmentData");
    const first = (await scriptedTurn(impl, chatId, []))[0];
    expect(imageParts(first)).toHaveLength(2);
    for (const [name, size] of [["c.png", share], ["huge.png", MAX_INLINE_ATTACHMENT_BYTES + 1]] as const) {
      expect(JSON.stringify(first)).toContain(`[Attached image (${name}); workspace file env.ATTACHMENTS/${name}; ` +
        `${size} bytes, not shown to you: past the limits on the images and PDFs one request can carry.]`);
    }
    expect(read.mock.calls.map(([, id]) => attachmentName(id)).toSorted()).toEqual(["a.png", "b.png"]);

    // Later images that fit leave the first message as it was shown.
    await impl.sendChatMessage(user, {profile: USER}, chatId, "And these", {attachments:
      [await upload("d.png", 1000, 5), await upload("e.png", share, 6), await upload("f.png", share, 7)]});
    const second = (await scriptedTurn(impl, chatId, []))[0];
    expect(second.find(message => message.role === "user")).toEqual(first.find(message => message.role === "user"));
    expect(imageParts(second)).toHaveLength(5);

    // One more takes the chat past the request's byte limit, so the turn compacts the first
    // message away first.
    await impl.sendChatMessage(user, {profile: USER}, chatId, "And this", {attachments: [await upload("g.png", share, 8)]});
    const [, compacted] = await scriptedTurn(impl, chatId, [], undefined, "Summary of the photos.");
    expect(JSON.stringify(compacted)).toContain("Summary of the photos.");
    expect(JSON.stringify(compacted)).not.toContain("a.png");
    expect(imageParts(compacted)).toHaveLength(4);
  }));

  // Messages no turn showed a vision model, such as ones sent with none chosen, can hold more than
  // memory allows read at once: the oldest are named by path, unread, and the summary is written
  // from the transcript, since the prompt is no longer the one earlier requests sent.
  it("reads no more images and PDFs than a request and a new message carry", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const size = MAX_INLINE_MESSAGE_BYTES / 5;
    const blob = impl.gitCache.writeBlob(pngOfSize(size, 100));
    const batch = (from: number) =>
      Array.from({length: 5}, (_, i) => ({oid: blob.oid, mimeType: "image/png", name: `${from + i}.png`}));
    const chatId = await impl.newChat(user, {profile: USER}, "First five", "auto", {attachments: batch(0)});
    for (let i = 1; i < 4; ++i) await impl.sendChatMessage(user, {profile: USER}, chatId, "Five more", {attachments: batch(5 * i)});
    const names = new Map([...impl.storage.chats.list()].flatMap(message =>
      message.type === "message" ? message.attachments ?? [] : []).map(attachment => [attachment.id, attachment.name]));
    const read = vi.spyOn(impl, "getChatAttachmentData");

    const [summary, compacted] = await scriptedTurn(impl, chatId, [], "anthropic-messages", "Summary of the photos.");
    const unread = ["0.png", "1.png", "2.png", "3.png", "4.png"];
    expect(read.mock.calls.map(([, id]) => names.get(id)).filter(name => unread.includes(name!))).toEqual([]);
    // The other fifteen once before compacting, and the ten it keeps again after.
    expect(read).toHaveBeenCalledTimes(25);
    expect(JSON.stringify(summary)).toContain("workspace file env.ATTACHMENTS/0.png; " +
      `${size} bytes, not shown to you: past the limits on the images and PDFs one request can carry.]`);
    expect(imageParts(summary)).toHaveLength(0);
    expect(JSON.stringify(compacted)).toContain("Summary of the photos.");
    expect(imageParts(compacted)).toHaveLength(10);
  }));

  // Compaction summarizes the prompt as earlier requests sent it. If it fails, the turn fails:
  // showing the older attachments any other way would invalidate the thinking after them.
  it("fails the turn, rewriting nothing, when compaction for the inline limits fails", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const blob = impl.gitCache.writeBlob(pngOfSize(24, 100));
    const batch = (from: number, length = 5) =>
      Array.from({length}, (_, i) => ({oid: blob.oid, mimeType: "image/png", name: `${from + i}.png`}));
    const chatId = await impl.newChat(user, {profile: USER}, "First five", "auto", {attachments: batch(0)});
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const requests: Message[][] = [];
    const turn = (...responses: ReturnType<typeof fauxAssistantMessage>[]) => {
      faux.setResponses(responses);
      return runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "cloudflare", model: "faux-model", apiToken: ""});
    };
    const thinking = (messages: Message[]) => messages.flatMap(message =>
      message.role === "assistant" ? message.content.filter(block => block.type === "thinking") : []);
    await turn(fauxAssistantMessage([fauxThinking("Considering the first five."), fauxText("Seen.")]));
    for (let i = 1; i < 4; ++i) await impl.sendChatMessage(user, {profile: USER}, chatId, "Five more", {attachments: batch(5 * i)});
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Wait");
    await turn(fauxAssistantMessage(fauxText("Waiting.")));
    // The thinking is replayed while nothing rewrites the messages before it.
    expect(thinking(requests[1])).toHaveLength(1);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "One more", {attachments: batch(20, 1)});
    // An empty summary fails the compaction, and with it the turn, before any request to answer.
    const sent = requests.length;
    await expect(turn(fauxAssistantMessage(fauxText("")))).rejects.toThrow(
        "This chat's images and PDFs are past what one request can carry, and compacting it " +
        "failed: Compaction produced an empty summary. Retry to try again.");
    expect(requests.length - sent).toBe(1);
    expect(impl.loadChatHistory(chatId).checkpoint).toBeUndefined();

    // Retry compacts the prompt as first sent, keeping the thinking after the cut.
    await turn(fauxAssistantMessage(fauxText("Summary of the first five.")), fauxAssistantMessage(fauxText("Again.")));
    const compacted = requests.at(-1)!;
    expect(JSON.stringify(compacted)).toContain("Summary of the first five.");
    expect(JSON.stringify(compacted)).not.toContain("not shown to you");
    expect(imageParts(compacted)).toHaveLength(16);
    expect(thinking(compacted).map(block => block.type === "thinking" && block.thinking))
      .toEqual(["Considering the first five."]);
  }));

  // Images readFile shows count toward the same limits as attachments, as each step adds them: an
  // agent that looks at image after image compacts before a request would carry too many.
  it("compacts mid-turn once the images readFile showed pass the limit", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const blob = impl.gitCache.writeBlob(pngOfSize(24, 100));
    const chatId = await impl.newChat(user, {profile: USER}, "Look at this", {attachments:
      [{oid: blob.oid, mimeType: "image/png", name: "dot.png"}]});
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const requests: Message[][] = [];
    const turn = (...responses: ReturnType<typeof fauxAssistantMessage>[]) => {
      faux.setResponses(responses);
      return runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "cloudflare", model: "faux-model", apiToken: ""});
    };
    const looks = (count: number) => Array.from({length: count}, () => fauxAssistantMessage(
        [fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "dot.png"})],
        {stopReason: "toolUse"}));

    await turn(...looks(10), fauxAssistantMessage(fauxText("Seen ten times.")));
    expect(imageParts(requests.at(-1)!)).toHaveLength(11);
    const recorded = [...impl.storage.chats.list()].flatMap(message =>
      message.type === "message" ? message.toolCalls ?? [] : []);
    expect(recorded).toHaveLength(10);
    expect(recorded.every(call => call.toolName === "readFile" && call.imageBytes === 24)).toBe(true);

    // The tenth look of this turn would make the next request carry 21: the turn compacts first.
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Ten more");
    requests.length = 0;
    await turn(...looks(10), fauxAssistantMessage(fauxText("Summary of the looks.")),
      fauxAssistantMessage(fauxText("Seen ten more times.")));
    expect(Math.max(...requests.map(request => imageParts(request).length))).toBe(20);
    const compacted = requests.at(-1)!;
    expect(JSON.stringify(compacted)).toContain("Summary of the looks.");
    expect(imageParts(compacted).length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(compacted)).not.toContain("not shown to you");
  }));

  // Within one turn, too: the cut falls between the turn's own steps, prompt included, rather
  // than leaving the turn's images to be shown some other way.
  it("compacts into the running turn, keeping its thinking, once its image reads pass the limit", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const requests: Message[][] = [];
    const ref = impl.gitCache.writeBlob(pngOfSize(24, 100));
    const chatId = await impl.newChat(user, {profile: USER}, "Match this mockup", {attachments:
      [{oid: ref.oid, mimeType: "image/png", name: "ref.png"}]});
    const looks = Array.from({length: 20}, (_, i) => fauxAssistantMessage(
        [fauxThinking(`Look ${i}`), fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "ref.png"})],
        {stopReason: "toolUse"}));
    faux.setResponses([...looks, fauxAssistantMessage(fauxText("Summary of the looks.")),
      fauxAssistantMessage(fauxText("Matched."))]);
    await runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
      requests.push(structuredClone(context.messages));
      return faux.stream(model, context, options);
    }}, chatId, AUTHOR, new AbortController().signal, USER,
    {provider: "cloudflare", model: "faux-model", apiToken: ""});
    expect(Math.max(...requests.map(request => imageParts(request).length))).toBe(20);
    const last = requests.at(-1)!;
    expect(JSON.stringify(last)).toContain("Summary of the looks.");
    expect(JSON.stringify(last)).not.toContain("not shown to you");
    // The steps kept after the cut keep their thinking.
    const thinking = last.flatMap(message =>
      message.role === "assistant" ? message.content.filter(block => block.type === "thinking") : []);
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.at(-1)).toMatchObject({thinking: "Look 19"});
  }));

  // Replay shows a read of content the user later reverted as text, so it carries no image.
  it("counts no image read of content the user later reverted", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const dot = impl.gitCache.writeBlob(pngOfSize(24, 100));
    const chatId = await impl.newChat(user, {profile: USER}, "Look at this", {attachments:
      [{oid: dot.oid, mimeType: "image/png", name: "dot.png"}]});
    const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    await step(impl, chatId, {[worktreeId]: [["notes.txt", {set: "draft"}]]});
    const changes = [...impl.storage.chats.list()].find(message => message.type === "changes")!;
    const look = fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "dot.png"});
    await scriptedTurn(impl, chatId, Array.from({length: 19}, () => look));
    await impl.revertChanges(chatId, changes.sequence, USER);

    // Counting the 19 reads would take this request to 21 images and compact it first.
    await impl.sendChatMessage(user, {profile: USER}, chatId, "And this",
      {attachments: [{oid: dot.oid, mimeType: "image/png", name: "dot.png"}]});
    const requests = await scriptedTurn(impl, chatId, []);
    expect(requests).toHaveLength(1);
    expect(imageParts(requests[0])).toHaveLength(2);
  }));

  // After a switch to a model that can't take images, replay names an image read without
  // reading the image.
  it("replays an image read as a note for a model that can't view images", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const dot = impl.gitCache.writeBlob(pngOfSize(24, 100));
    const chatId = await impl.newChat(user, {profile: USER}, "Look at this", {attachments:
      [{oid: dot.oid, mimeType: "image/png", name: "dot.png"}]});
    await scriptedTurn(impl, chatId, [fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename: "dot.png"})]);
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Now in words");
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const requests: Message[][] = [];
    faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
    await runAgent(impl, {model: {...faux.getModel(), input: ["text"]}, stream: (model, context, options) => {
      requests.push(structuredClone(context.messages));
      return faux.stream(model, context, options);
    }}, chatId, AUTHOR, new AbortController().signal, USER,
    {provider: "cloudflare", model: "faux-model", apiToken: ""});
    expect(fileToolResults(requests[0])).toEqual([{toolName: "readFile", isError: false, content:
      [{type: "text", text: "dot.png: image not shown to you: this model can't view images."}]}]);
  }));

  // One step's image reads fit one message's budget, as a message's attachments do, so the
  // compaction that keeps the newest messages can always keep the step whole.
  it("refuses image reads past one message's budget within a step", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const dot = impl.gitCache.writeBlob(pngOfSize(24, 100));
    const chatId = await impl.newChat(user, {profile: USER}, "Look at these", {attachments:
      [{oid: dot.oid, mimeType: "image/png", name: "dot.png"}]});
    const worktreeId = impl.getChatAgentContext(chatId).scratch!.worktreeId;
    await step(impl, chatId, {[worktreeId]: [
      ["six.png", {setBytes: await impl.gitCache.writeBlob(pngOfSize(6 * 1024 * 1024, 100))}]]});
    const look = (filename: string) => fauxToolCall("readFile", {workpiece: "ATTACHMENTS", filename});
    const requests = await scriptedTurn(impl, chatId, [look("six.png"), look("six.png"), look("dot.png")]);
    const results = fileToolResults(requests.at(-1)!);
    expect(results.map(result => result.isError)).toEqual([false, true, false]);
    expect(JSON.stringify(results[1].content)).toContain("Too many images in one step");
    // The next step may read it.
    expect(imageParts(requests.at(-1)!)).toHaveLength(3);
  }));

  // The model has answered nothing after the messages it was refused with, so naming their
  // attachments by path changes nothing it has seen.
  it.each([
    ["anthropic-messages", '400 {"type":"error","error":{"type":"invalid_request_error","message":"too many PDF pages"}}'],
    // The Google SDK's message is the JSON body alone.
    ["google-generative-ai", '{"error":{"code":400,"message":"The document has more than 1000 pages.","status":"INVALID_ARGUMENT"}}'],
  ] as const)("names the attachments of a refused first request by path from then on (%s)", (api, errorMessage) => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const pdf = impl.gitCache.writeBlob(new TextEncoder().encode("%PDF-1.7 601 pages"));
    const chatId = await impl.newChat(user, {profile: USER}, "Read this", "auto", {attachments:
      [{oid: pdf.oid, mimeType: "application/pdf", name: "long.pdf"}]});
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const requests: Message[][] = [];
    const turn = (...responses: ReturnType<typeof fauxAssistantMessage>[]) => {
      faux.setResponses(responses);
      return runAgent(impl, {model: {...faux.getModel(), api}, stream: (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "cloudflare", model: "faux-model", apiToken: ""});
    };
    await expect(turn(fauxAssistantMessage([], {stopReason: "error", errorMessage})))
      .rejects.toThrow("Retrying sends this message's images and PDFs as workspace files instead.");
    expect(imageParts(requests[0])).toHaveLength(1);
    await turn(fauxAssistantMessage(fauxText("Read it from the workspace.")));
    expect(imageParts(requests[1])).toHaveLength(0);
    expect(JSON.stringify(requests[1])).toContain("[Attached PDF file (long.pdf); workspace file " +
      "env.ATTACHMENTS/long.pdf; 18 bytes, not shown to you: the model's provider refused a request with it.]");
  }));

  it("never scans attachment payloads on text-only sends or namespace allocation", () => inKernel(crypto.randomUUID(), async impl => {
    const list = vi.spyOn(impl.storage.chatAttachmentContent, "list")
      .mockImplementation(() => { throw new Error("Unexpected workspace-wide payload scan"); });
    try {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const first = await impl.newChat(user, {profile: USER}, "No attachments", "auto");
      await impl.sendChatMessage(user, {profile: USER}, first, "Still no attachments");
      const blob = await impl.gitCache.writeBlob(new TextEncoder().encode("input"));
      const upload = {oid: blob.oid, mimeType: "text/plain", name: "notes.txt"};
      await impl.sendChatMessage(user, {profile: USER}, first, "First upload", {attachments: [upload]});
      const scratch = impl.getChatAgentContext(first).scratch!;
      expect(scratch.bindingName).toBe("ATTACHMENTS");
      await step(impl, first, {[scratch.worktreeId]: [["plan.md", {set: "working plan"}]]});
      await impl.sendChatMessage(user, {profile: USER}, first, "Repeat upload", {attachments: [upload]});
      expect(impl.getChatAgentContext(first).scratch).toEqual(scratch);
      const content = await impl.getCurrentChatContent(first, impl.storage.chatMeta.get(first)!);
      expect(content.get(scratch.worktreeId)?.get("plan.md")).toBe("working plan");
      expect(content.get(scratch.worktreeId)?.get("notes-2.txt")).toBe("input");
      const other = await impl.newChat(user, {profile: USER}, "Other chat", "auto", {attachments: [upload]});
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
    const blob = await impl.gitCache.writeBlob(Uint8Array.of(1));
    const upload = {oid: blob.oid, mimeType: "image/png", name: "bad.png"};
    await expect(impl.newChat(user, {profile: USER}, "Bad MIME", "auto", {attachments: [upload]}))
      .rejects.toThrow("does not match its MIME");
    const local = await impl.gitCache.writeBlob(Uint8Array.of(2));
    const chatId = await impl.newChat(user, {profile: USER}, "Local blob", "auto", {attachments:
      [{oid: local.oid, mimeType: "application/octet-stream"}]});
    expect(impl.getChatAgentContext(chatId).scratch).toBeDefined();
    await expect(impl.newChat(user, {profile: USER}, "Missing blob", "auto", {attachments:
      [{oid: "a".repeat(40), mimeType: "application/octet-stream"}]}))
      .rejects.toThrow("Unknown Git blob");
    // Streamed, as the composer uploads: the blob is never held whole.
    const tooBigSize = 100 * 1024 * 1024 + 1, piece = new Uint8Array(1024 * 1024);
    let left = tooBigSize;
    const tooBig = await impl.gitCache.writeBlobStream(new ReadableStream({pull(controller) {
      if (left === 0) return controller.close();
      const length = Math.min(left, piece.byteLength);
      left -= length;
      controller.enqueue(piece.slice(0, length));
    }}), tooBigSize);
    // Refused by its size alone: none of its chunks is read.
    const record = impl.storage.gitObjects.get(tooBig.oid)!;
    if (!("chunks" in record)) throw new Error("expected a chunked blob");
    const chunks = new Set(record.chunks.map(chunk => chunk.oid));
    const get = impl.storage.gitObjects.get.bind(impl.storage.gitObjects);
    let chunkReads = 0;
    impl.storage.gitObjects.get = (oid: string) => {
      if (chunks.has(oid)) chunkReads++;
      return get(oid);
    };
    await expect(impl.newChat(user, {profile: USER}, "Too large", "auto", {attachments:
      [{oid: tooBig.oid, mimeType: "application/octet-stream"}]}))
      .rejects.toThrow("100 MB or smaller");
    expect(chunkReads).toBe(0);
  }));
});

// Data files for views (plans/live-views.md, "Data files"): the agent writes a file with
// executeCode, and a later answer's view reads it by a quoted worktree:// URL. The binding's
// writes are simulated: workerd refuses an executeCode call into the binding in this harness ("The
// RPC receiver's prototype does not implement writeFile"), so executeCodeMode is replaced with one
// that makes the changes the binding makes (worktree-session.ts) through the turn's
// WorktreeTurnAccess.appendChange: a text change for writeFile, a stored blob and a setBytes change
// for writeBytes.
type Write = {path: string, text?: string, bytes?: string};

// `value`, or a failed test if it is missing.
function only<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`No ${what}`);
  return value;
}

describe("data files for views", () => {
  // Each executeCode call's writes, by the id its code carries.
  const writesById = new Map<string, Write[]>();
  // The OID each simulated writeBytes stored, by path.
  const storedBlobs = new Map<string, string>();
  const code = (...writes: Write[]) => {
    const id = crypto.randomUUID();
    writesById.set(id, writes);
    return fauxToolCall("executeCode", {code: id});
  };
  const view = (path: string) => `Here it is.\n\n<inline-html>\n<title>Data</title>\n<p id="out"></p>\n` +
    `<script type="module">\nconst rows = await embeds.json("worktree://OUTPUTS/${path}");\n</script>\n</inline-html>`;
  // One agent turn whose model answers each step in order; returns the pins of its stored answers.
  async function turn(impl: Impl, chatId: number, steps: ReturnType<typeof fauxAssistantMessage>[]) {
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Show my data"}]);
    const before = new Set([...impl.storage.chats.list()].map(message => message.sequence));
    const execute = vi.spyOn(impl, "executeCodeMode").mockImplementation(
        async (_chatId, id, _initiator, _model, bindings, _output, worktreeTurn) => {
          const entry = bindings.OUTPUTS;
          if (entry?.type !== "workpiece" || !worktreeTurn) throw new Error("no OUTPUTS worktree");
          for (const {path, text, bytes} of only(writesById.get(id), "writes")) {
            if (text !== undefined) {
              worktreeTurn.appendChange(entry.id, path, {set: text});
            } else {
              const blob = impl.gitCache.writeBlob(new TextEncoder().encode(bytes));
              storedBlobs.set(path, blob.oid);
              worktreeTurn.appendChange(entry.id, path, {setBytes: blob});
            }
          }
          return "Written";
        });
    try {
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([...steps, fauxAssistantMessage(fauxText("Done"))]);
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, chatId,
          AUTHOR, new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
    } finally {
      execute.mockRestore();
    }
    return [...impl.storage.chats.list()].filter(message => message.chatId === chatId && !before.has(message.sequence))
        .flatMap(message => message.type === "message" && message.embeds ? [message.embeds] : []);
  }
  const steps = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, {stopReason: "toolUse"});
  const answer = (text: string, ...calls: ReturnType<typeof fauxToolCall>[]) =>
    fauxAssistantMessage([fauxText(text), ...calls], calls.length ? {stopReason: "toolUse"} : undefined);
  const newChat = (impl: Impl) =>
    impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Draw my data", "auto");
  const createOutputs = fauxToolCall("createWorktree", {title: "Outputs", bindingName: "OUTPUTS"});
  const source = (path: string) => `worktree://OUTPUTS/${path}`;
  const text = (impl: Impl, oid: string | null | undefined) =>
    new TextDecoder().decode(impl.gitCache.readBlob(only(oid, "pin")));

  it("pins a file written in an earlier step, as a text change or a setBytes change, in the next step's view", () =>
    inKernel(crypto.randomUUID(), async impl => {
      const chatId = await newChat(impl);
      const pins = await turn(impl, chatId, [
        steps(createOutputs, code({path: "text.json", text: "[1,2]"})),
        steps(code({path: "bytes.json", bytes: "[3]"})),
        answer(view("text.json") + "\n\n" + view("bytes.json")),
      ]);
      const pinned = only(pins.at(-1), "pinned answer");
      expect(text(impl, pinned[source("text.json")])).toBe("[1,2]");
      // A setBytes change pins the very blob it stored.
      expect(pinned[source("bytes.json")]).toBe(storedBlobs.get("bytes.json"));
    }));

  it("pins the path as it was in a view written in the same response as its write", () =>
    inKernel(crypto.randomUUID(), async impl => {
      const chatId = await newChat(impl);
      await turn(impl, chatId, [steps(createOutputs, code({path: "old.json", text: "[1]"}))]);
      const pins = await turn(impl, chatId, [
        answer(view("new.json") + "\n\n" + view("old.json"),
            code({path: "new.json", text: "[9]"}, {path: "old.json", text: "[2]"})),
      ]);
      const pinned = only(pins.at(0), "pinned answer");
      expect(pinned[source("new.json")]).toBeNull();
      expect(text(impl, pinned[source("old.json")])).toBe("[1]");
    }));

  it("pins null for a binding that is a Gadget, not a worktree", () => inKernel(crypto.randomUUID(), async impl => {
    const chatId = await newChat(impl);
    const pins = await turn(impl, chatId, [
      steps(fauxToolCall("createGadget", {title: "Log", bindingName: "LOG"})),
      answer('<inline-html>\n<script type="module">embeds.json("worktree://LOG/client.js")</script>\n</inline-html>'),
    ]);
    expect(pins.at(-1)).toEqual({"worktree://LOG/client.js": null});
  }));

  it("pins a file written in an earlier turn, before its change is accepted", () =>
    inKernel(crypto.randomUUID(), async impl => {
      const chatId = await newChat(impl);
      await turn(impl, chatId, [steps(createOutputs, code({path: "totals.json", text: "[42]"}))]);
      const pins = await turn(impl, chatId, [answer(view("totals.json"))]);
      expect(text(impl, only(pins.at(-1), "pinned answer")[source("totals.json")])).toBe("[42]");
    }));
});
