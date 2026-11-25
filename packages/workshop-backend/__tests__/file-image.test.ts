import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
  type AssistantMessage, type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {runAgent} from "../src/agent";
import {getModel} from "../src/ai-models";
declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const MAX_STEP_BYTES = 10 * 1024 * 1024;
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
// A genuine 1x1 PNG, also used to verify the exact bytes sent to the provider.
const PNG = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");
async function inKernel<T>(name: string, test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), instance => test(instance.impl));
}
async function turn(impl: Impl, chatId: number, steps: ReturnType<typeof fauxToolCall>[][]) {
  return scriptedTurn(impl, chatId, [...steps.map(calls => fauxAssistantMessage(calls, {stopReason: "toolUse"})),
    fauxAssistantMessage(fauxText("Done"))]);
}
async function scriptedTurn(impl: Impl, chatId: number, responses: AssistantMessage[], vision = true) {
  const faux = createFauxCore({models: [{id: "faux-model", contextWindow: 8_000_000}]});
  const requests: Message[][] = [];
  faux.setResponses(responses);
  await runAgent(impl, {model: {...faux.getModel(), input: vision ? ["text", "image"] : ["text"]}, stream: (model, context, options) => {
    requests.push(structuredClone(context.messages));
    return faux.stream(model, context, options);
  }}, chatId, AUTHOR, new AbortController().signal, USER,
  {provider: "cloudflare", model: "faux-model", apiToken: "", contextWindow: 8_000_000});
  return {requests};
}
async function setup(impl: Impl, bytes = PNG, extraFiles: [string, Uint8Array][] = []) {
  const blob = impl.gitCache.writeBlob(bytes);
  const commitId = await impl.gitCache.writeFilesAsCommit(new Map([["image.png", blob], ...extraFiles.map(([name, data]) => [name, impl.gitCache.writeBlob(data)] as const)]), {
    parents: [], author: {name: "Test", email: "test@example.com"},
    message: "image", timestamp: new Date(0),
  });
  const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, "Inspect");
  await turn(impl, chatId, [[fauxToolCall("createWorktree", {title: "Images", bindingName: "IMAGES", commitId})]]);
  impl.addChatMessages(chatId, USER, [{type: "message", message: "Read the image"}]);
  return {chatId, blob};
}
const read = (extra = {}) => fauxToolCall("readFile", {workpiece: "IMAGES", filename: "image.png", ...extra});
const results = (messages: Message[]) => messages.flatMap(message =>
  message.role === "toolResult" && message.toolName === "readFile" ? [message] : []);

describe("images read from a worktree", () => {
  it("shows pixels immediately and replays the immutable blob after file removal and eviction", async () => {
    const name = crypto.randomUUID();
    let chatId: number;
    await inKernel(name, async impl => {
      ({chatId} = await setup(impl));
      const {requests} = await turn(impl, chatId, [[read()]]);
      const shown = results(requests.at(-1)!)[0];
      expect(shown.isError).toBe(false);
      expect(shown.content).toContainEqual({type: "image", data: PNG.toBase64(), mimeType: "image/png"});
      const recorded = [...impl.storage.chats.list()].flatMap(message =>
        message.type === "message" ? message.toolCalls ?? [] : []).find(call => call.toolName === "readFile");
      expect(recorded).toHaveProperty("image.byteLength", PNG.length);
      expect(JSON.stringify(recorded)).not.toContain(PNG.toBase64());
      const creation = [...impl.storage.chats.list()].flatMap(message =>
        message.type === "message" ? message.toolCalls ?? [] : []).find(call => call.toolName === "createWorktree");
      if (creation?.toolName !== "createWorktree" || !creation.output) throw new Error("Expected worktree");
      const worktreeId = creation.output.worktreeId;
      await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [{change: {[worktreeId!]: [["image.png", {remove: true}]]}}],
        createdGadgets: [], createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const {requests} = await turn(impl, chatId, []);
      expect(results(requests[0])[0].content).toContainEqual({type: "image", data: PNG.toBase64(), mimeType: "image/png"});
    });
  });

  it.each([{startLine: 1}, {lineCount: 1}])("rejects image line windows: %j", window => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const {requests} = await turn(impl, chatId, [[read(window)]]);
    expect(results(requests.at(-1)!)[0]).toMatchObject({isError: true,
      content: [{type: "text", text: expect.stringContaining("line windows")}]});
  }));

  it.each(["oversize", "dimensions", "truncated"])("rejects %s images without recording pixels", kind => inKernel(crypto.randomUUID(), async impl => {
    const bytes = kind === "oversize" ? new Uint8Array(7 * 1024 * 1024 + 1) : PNG.slice();
    bytes.set(PNG.slice(0, Math.min(bytes.length, PNG.length)));
    if (kind === "dimensions") new DataView(bytes.buffer).setUint32(16, 8001);
    const {chatId} = await setup(impl, kind === "truncated" ? bytes.slice(0, 16) : bytes);
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0]).toMatchObject({isError: true});
    expect(impl.loadChatHistory(chatId).chatMessages.flatMap(msg =>
      msg.type === "message" ? msg.toolCalls ?? [] : []).filter(call => call.toolName === "readFile")
      .every(call => !call.image)).toBe(true);
  }));

  it("rejects text-only model reads before loading image bodies", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const original = impl.openFileAtCommit.bind(impl);
    const reads: number[] = [];
    vi.spyOn(impl, "openFileAtCommit").mockImplementation(async (...args) => {
      const file = await original(...args);
      if (file) {
        const read = file.reader.read.bind(file.reader);
        vi.spyOn(file.reader, "read").mockImplementation((offset, length) => {
          reads.push(length); return read(offset, length);
        });
      }
      return file;
    });
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Use vision")),
    ], false);
    expect(results(requests.at(-1)!)[0]).toMatchObject({isError: true});
    expect(Math.max(...reads)).toBeLessThan(PNG.length);
  }));

  it("bounds images in a step using the attachment message budget", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = new Uint8Array(MAX_STEP_BYTES / 2 + 1);
    bytes.set(PNG);
    const {chatId} = await setup(impl, bytes);
    const {requests} = await turn(impl, chatId, [[read(), read()]]);
    expect(results(requests.at(-1)!).map(result => result.isError)).toEqual([false, true]);
    expect(results(requests.at(-1)!)[0].content).toContainEqual({type: "image", data: bytes.toBase64(), mimeType: "image/png"});
  }));

  it("shares the image-count limit with uploads and removes dependent thinking when compaction fails", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    // Each batch fits its own message; the final file read takes the request past 20 images.
    for (let batch = 0; batch < 4; ++batch) {
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Attached", {attachments:
        Array.from({length: 5}, (_, index) => ({oid: blob.oid, mimeType: "image/png", name: `${batch}-${index}.png`}))});
    }
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("")), // Failed summary: fall back to omission markers.
      fauxAssistantMessage(fauxText("Done")),
    ]);
    const last = requests.at(-1)!;
    expect(last.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image") : [])).toHaveLength(16);
    expect(results(last).at(-1)!.content.some(part => part.type === "image")).toBe(true);
  }));

  it("does not send reverted image reads", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await turn(impl, chatId, [[read()]]);
    const lastRead = impl.loadChatHistory(chatId).chatMessages.findLast(message =>
      message.type === "message" && message.toolCalls?.some(call => call.toolName === "readFile"));
    if (!lastRead) throw new Error("Expected image read");
    impl.addChatMessages(chatId, USER, [{type: "revert", revertFrom: lastRead.sequence}, {type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0]).every(result => result.content.every(part => part.type === "text"))).toBe(true);
  }));

  it("records provider refusal without retrying completed tools, and leaves the chat usable", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await expect(scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read(), fauxToolCall("writeFile", {workpiece: "IMAGES", filename: "note.txt", content: "Saved"})], {stopReason: "toolUse"}),
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 Invalid image"}),
    ])).rejects.toThrow("400 Invalid image");
    const calls = impl.loadChatHistory(chatId).chatMessages.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    expect(calls.filter(call => call.toolName === "writeFile")).toHaveLength(1);
    expect(calls.find(call => call.toolName === "readFile")).toHaveProperty("image.rejected", true);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0])[0].content.every(part => part.type === "text")).toBe(true);
  }));

  it("reads an uncommitted byte-backed file and preserves its original pixels after replacement", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    const creation = impl.loadChatHistory(chatId).chatMessages.flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : [])
      .find(call => call.toolName === "createWorktree");
    if (creation?.toolName !== "createWorktree" || !creation.output) throw new Error("Expected worktree");
    const worktreeId = creation.output.worktreeId;
    const step = (changes: Parameters<Impl["commitAgentStep"]>[3]["changes"]) =>
      impl.commitAgentStep(chatId, AUTHOR, [], {changes, createdGadgets: [], createdWorktrees: [],
        addedBindings: [], worktreeCommits: [], blueprintMerges: []});
    // writeBytes and replica submissions produce the same setBytes postimage.
    await step([{change: {[worktreeId]: [["generated.png", {setBytes: blob}]]}}]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Inspect the generated file"}]);
    await turn(impl, chatId, [[read({filename: "generated.png"})]]);
    await step([{change: {[worktreeId]: [["generated.png", {set: "now text"}]]}}]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0])[0].content).toContainEqual({type: "image", data: PNG.toBase64(), mimeType: "image/png"});
  }));

  it("omits older file-image batches and their dependent thinking if compaction fails", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await scriptedTurn(impl, chatId, [
      fauxAssistantMessage(Array.from({length: 10}, () => read()), {stopReason: "toolUse"}),
      fauxAssistantMessage([fauxThinking("Considering images."), fauxText("Seen")]),
    ]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Ten more"}]);
    await turn(impl, chatId, [Array.from({length: 10}, () => read())]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "One more"}]);
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("")), fauxAssistantMessage(fauxText("Done")),
    ]);
    const last = requests.at(-1)!;
    expect(results(last).flatMap(result => result.content.filter(part => part.type === "image"))).toHaveLength(11);
    expect(JSON.stringify(results(last)[0])).toContain("Older image pixels omitted");
    expect(last.flatMap(message => message.role === "assistant"
      ? message.content.filter(part => part.type === "thinking") : [])).toEqual([]);
  }));
});

describe("file images in provider requests", () => {
  it.each([
    ["openai", "gpt-4.1"], ["anthropic", "claude-sonnet-4-5"], ["google", "gemini-2.5-pro"],
  ] as const)("sends pixels through the %s adapter", (provider, model) => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await turn(impl, chatId, [[read(), read()]]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const config = {provider, model, apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const actualStream = handle.stream;
    let payload = "";
    handle.stream = (model, context, options) => actualStream(model, context, {...options, maxRetries: 0,
      fetch: async (input, init) => {
        payload = await new Request(input, init).text();
        return new Response("fixture done", {status: 418});
      },
    });
    await expect(runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config)).rejects.toThrow();
    expect(payload).toContain(PNG.toBase64());
    if (provider === "google") {
      const contents = JSON.parse(payload).contents;
      const responseTurns = contents.filter((turn: {parts: object[]}) => turn.parts.some(part => "functionResponse" in part));
      expect(responseTurns.at(-1).parts.filter((part: object) => "functionResponse" in part)).toHaveLength(2);
    }
  }));
});

// Genuine JPEG; extra COM segments below exercise the same pixels with a long metadata header.
const JPEG = Uint8Array.fromBase64("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z");

describe("file image headers", () => {
  it.each([
    [PNG, "image/png"], [JPEG, "image/jpeg"],
    [Uint8Array.fromBase64("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"), "image/webp"],
  ] as const)("recognizes the source bytes as %s", (bytes, mimeType) => inKernel(crypto.randomUUID(), async impl => {
    const {readFileImage} = await import("../src/file-image");
    const reader = await impl.openBlob(impl.gitCache.writeBlob(bytes).oid);
    expect(readFileImage(reader)).toEqual({type: "image", mimeType, data: bytes.toBase64()});
  }));

  it("keeps RIFF-like UTF-8 on the text path", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl, new TextEncoder().encode("RIFF....WEBP is the container header."));
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0]).toMatchObject({isError: false,
      content: [{type: "text", text: expect.stringContaining("RIFF....WEBP")}]});
  }));
});
