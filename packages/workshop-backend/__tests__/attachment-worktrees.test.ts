import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {buildPackStream, decodePackStream} from "../src/git-codec";
import {validateChatAttachmentUpload} from "../src/chat-attachment-validation";
import {runAgent} from "../src/agent";
import {createFauxCore, fauxAssistantMessage, fauxText, type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import type {CodeChange} from "@gadgets/workshop-shared/code-change";
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
describe("attachment worktree ingress", () => {
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
      expect(context.attachments).toBeDefined();
      expect(attachment.data).toBeUndefined();
      const tree = impl.storage.gadgets.get(context.attachments!.worktreeId)!;
      if (tree.type !== "worktree") throw new Error("Expected attachments worktree");
      if (bytes[0] === 255) {
        const value = await impl.readByteFileAtCommit(tree.baseCommit, "input.csv");
        expect(await new Response(impl.byteStore.read(value!)).bytes()).toEqual(bytes);
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
      if (source === "blob") return {oid: (await impl.byteStore.import("client-upload", data)).oid,
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
    expect(impl.getChatAgentContext(chatId).attachments).toBeDefined();
    const worktreeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
    const value = (await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!))
      .get(worktreeId)?.get("large.txt")
      ?? await impl.readFileAtCommit(impl.getWorktreePinBase(worktreeId)!, "large.txt");
    const workspaceBytes = typeof value === "string" ? new TextEncoder().encode(value)
      : await new Response(impl.byteStore.read(value!)).bytes();
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
    const worktreeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
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

  const binaryFiles = [
    {name: "photo.png", mimeType: "image/png", content: Uint8Array.of(137, 80, 78, 71, 0, 255)},
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
          oid: (await impl.byteStore.import("client-upload", content)).oid, mimeType, name,
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
      const worktreeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
      const overlay = (await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!)).get(worktreeId)?.get(name);
      const value = overlay ?? await impl.readByteFileAtCommit(impl.getWorktreePinBase(worktreeId)!, name);
      if (typeof value !== "object") throw new Error("Expected opaque byte content");
      expect(value.byteLength).toBe(bytes.byteLength);
      expect(await new Response(impl.byteStore.read(value)).bytes()).toEqual(bytes);
      const message = [...impl.storage.chats.list()].findLast(message =>
        message.type === "message" && message.attachments?.some(file => file.name === name));
      if (!message || message.type !== "message") throw new Error("Missing attachment message");
      const attachment = message.attachments!.find(file => file.name === name)!;
      expect(await impl.getChatAttachmentData(chatId, attachment.id)).toEqual(bytes);
      expect(impl.storage.chatAttachmentContent.get(attachment.id)?.state).toMatchObject({workspacePath: name});
      if (source === "blob") expect(impl.storage.chatAttachmentContent.get(attachment.id)?.data).toBeUndefined();

      const object = await impl.gitCache.packObject(value.oid, {type: "blob"});
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
        upload = {oid: (await impl.byteStore.import("client-upload", original)).oid,
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
      worktreeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
      const replacement = await impl.byteStore.import("kernel", updated);
      await step(impl, chatId, {[worktreeId]: [["data.bin", {setBytes: replacement}]]});
      expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(original);
      const value = await impl.readByteFileAtCommit(impl.getWorktreePinBase(worktreeId)!, "data.bin");
      expect(await new Response(impl.byteStore.read(value!)).bytes()).toEqual(updated);
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

  it("never scans attachment payloads on text-only sends or namespace allocation", () => inKernel(crypto.randomUUID(), async impl => {
    const list = vi.spyOn(impl.storage.chatAttachmentContent, "list")
      .mockImplementation(() => { throw new Error("Unexpected workspace-wide payload scan"); });
    try {
      const user = env.TEST_USER.getByName(crypto.randomUUID());
      const first = await impl.newChat(user, {profile: USER}, "No attachments");
      await impl.sendChatMessage(user, {profile: USER}, first, "Still no attachments");
      const blob = await impl.byteStore.import("client-upload", new TextEncoder().encode("input"));
      const upload = {oid: blob.oid, mimeType: "text/plain", name: "notes.txt"};
      await impl.sendChatMessage(user, {profile: USER}, first, "First upload", undefined, [upload]);
      const scratch = impl.getChatAgentContext(first).attachments!;
      expect(scratch.bindingName).toBe("SCRATCH");
      await step(impl, first, {[scratch.worktreeId]: [["plan.md", {set: "working plan"}]]});
      await impl.sendChatMessage(user, {profile: USER}, first, "Repeat upload", undefined, [upload]);
      expect(impl.getChatAgentContext(first).attachments).toEqual(scratch);
      const content = await impl.getCurrentChatContent(first, impl.storage.chatMeta.get(first)!);
      expect(content.get(scratch.worktreeId)?.get("plan.md")).toBe("working plan");
      expect(content.get(scratch.worktreeId)?.get("notes-2.txt")).toBe("input");
      const other = await impl.newChat(user, {profile: USER}, "Other chat", undefined, [upload]);
      const otherScratch = impl.getChatAgentContext(other).attachments!;
      expect(otherScratch.worktreeId).not.toBe(scratch.worktreeId);
      const messages = [...impl.storage.chats.list()].filter(m => m.chatId === other && m.type === "message");
      expect(messages[0]).toMatchObject({attachments: [{workspacePath: "notes.txt"}]});
      expect(list).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
    }
  }));

  it("checks blob provenance, attachment signatures and limits when sending", () => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const blob = await impl.byteStore.import("client-upload", Uint8Array.of(1));
    const upload = {oid: blob.oid, mimeType: "image/png", name: "bad.png"};
    await expect(impl.newChat(user, {profile: USER}, "Bad MIME", undefined, [upload]))
      .rejects.toThrow("does not match its MIME");
    const otherScope = await impl.byteStore.import("worktree:other", Uint8Array.of(2));
    await expect(impl.newChat(user, {profile: USER}, "Not an upload", undefined,
      [{oid: otherScope.oid, mimeType: "application/octet-stream"}]))
      .rejects.toThrow("not uploaded in this workspace");
    const tooBig = await impl.byteStore.import("client-upload", new Uint8Array(4 * 1024 * 1024 + 1));
    await expect(impl.newChat(user, {profile: USER}, "Too large", undefined,
      [{oid: tooBig.oid, mimeType: "application/octet-stream"}]))
      .rejects.toThrow("too large");
  }));
});
