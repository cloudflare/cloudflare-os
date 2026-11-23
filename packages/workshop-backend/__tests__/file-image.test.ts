import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
  type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {runAgent} from "../src/agent";
import {ELIDED_FILE_IMAGE, readFileImage} from "../src/file-image";

declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
// A genuine 1x1 PNG, also used to verify the exact bytes sent to the provider.
const PNG = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==");
async function inKernel<T>(name: string, test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), instance => test(instance.impl));
}
async function turn(impl: Impl, chatId: number, steps: ReturnType<typeof fauxToolCall>[][]) {
  const faux = createFauxCore({models: [{id: "faux-model", contextWindow: 8_000_000}]});
  const requests: Message[][] = [];
  faux.setResponses([...steps.map(calls => fauxAssistantMessage(calls, {stopReason: "toolUse"})),
    fauxAssistantMessage(fauxText("Done"))]);
  await runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
    requests.push(structuredClone(context.messages));
    return faux.stream(model, context, options);
  }}, chatId, AUTHOR, new AbortController().signal, USER,
  {provider: "cloudflare", model: "faux-model", apiToken: "", contextWindow: 8_000_000});
  return {requests};
}
async function setup(impl: Impl, bytes = PNG) {
  const blob = impl.gitCache.writeBlob(bytes);
  const commitId = await impl.gitCache.writeFilesAsCommit(new Map([["image.png", blob]]), {
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

  it("loads only the newest four images on replay and bounds live parallel reads", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const first = await turn(impl, chatId, [[read(), read(), read(), read(), read()]]);
    const outputs = results(first.requests.at(-1)!);
    expect(outputs.filter(result => !result.isError)).toHaveLength(4);
    expect(outputs.at(-1)).toMatchObject({isError: true});
    impl.addChatMessages(chatId, USER, [{type: "message", message: "One more"}]);
    const next = await turn(impl, chatId, [[read()]]);
    expect(JSON.stringify(results(next.requests.at(-1)!)[0])).toContain(ELIDED_FILE_IMAGE);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const open = vi.spyOn(impl, "openBlob");
    const replay = await turn(impl, chatId, []);
    const shown = results(replay.requests[0]);
    expect(shown.flatMap(result => result.content.filter(part => part.type === "image"))).toHaveLength(4);
    expect(JSON.stringify(shown[0])).toContain(ELIDED_FILE_IMAGE);
    expect(open.mock.calls.filter(([oid]) => oid === impl.gitCache.writeBlob(PNG).oid)).toHaveLength(4);
  }));

  it("does not let reverted reads displace valid image history", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await turn(impl, chatId, [[read(), read(), read(), read()]]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "One more"}]);
    await turn(impl, chatId, [[read()]]);
    const lastRead = [...impl.storage.chats.list()].findLast(message =>
      message.type === "message" && message.toolCalls?.some(call => call.toolName === "readFile"));
    if (!lastRead) throw new Error("Expected image read");
    impl.addChatMessages(chatId, USER, [{type: "revert", revertFrom: lastRead.sequence},
      {type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    const shown = results(requests[0]);
    expect(shown.slice(0, 4).every(result => result.content.some(part => part.type === "image"))).toBe(true);
    expect(shown.at(-1)?.content.every(part => part.type === "text")).toBe(true);
  }));

  it.each(["oversize", "dimensions", "truncated"])("rejects %s images without sending binary text", kind => inKernel(crypto.randomUUID(), async impl => {
    const bytes = kind === "oversize" ? new Uint8Array(4 * 1024 * 1024 + 1) : PNG.slice();
    bytes.set(PNG.slice(0, Math.min(bytes.length, PNG.length)));
    if (kind === "dimensions") new DataView(bytes.buffer).setUint32(16, 8001);
    const {chatId} = await setup(impl, kind === "truncated" ? bytes.slice(0, 16) : bytes);
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0].isError).toBe(true);
    expect(results(requests.at(-1)!)[0].content.every(part => part.type === "text")).toBe(true);
  }));

  it("reserves image-count capacity for earlier user attachments", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    for (let batch = 0; batch < 4; ++batch) {
      await impl.sendChatMessage(user, {profile: USER}, chatId, "Attached", {attachments:
        Array.from({length: 5}, (_, index) => ({oid: blob.oid, mimeType: "image/png", name: `${batch}-${index}.png`}))});
    }
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0]).toMatchObject({isError: true,
      content: [{type: "text", text: expect.stringContaining("attachments")}]});
    expect(requests.at(-1)!.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image") : [])).toHaveLength(20);
  }));

  it("bounds total raw bytes across images in a step", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set(PNG);
    const {chatId} = await setup(impl, bytes);
    const {requests} = await turn(impl, chatId, [[read(), read(), read(), read()]]);
    expect(results(requests.at(-1)!).filter(result => !result.isError)).toHaveLength(3);
    expect(results(requests.at(-1)!).at(-1)).toMatchObject({isError: true});
  }));

  it("does not read a large image body before rejecting its size", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = new Uint8Array(5 * 1024 * 1024);
    bytes.set(PNG);
    const blob = impl.gitCache.writeBlob(bytes);
    const reader = await impl.openBlob(blob.oid);
    const read = vi.spyOn(reader, "read");
    expect(() => readFileImage(reader)).toThrow("4 MiB");
    expect(read.mock.calls).toEqual([[0, 12]]);
  }));
});
