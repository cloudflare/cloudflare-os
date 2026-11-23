import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
  type AssistantMessage, type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {runAgent} from "../src/agent";
import {getModel} from "../src/ai-models";
import type {AiModelConfig} from "@gadgets/workshop-shared/api";
import {ELIDED_FILE_IMAGE, REJECTED_FILE_IMAGE, isImageDecodeError, readFileImage} from "../src/file-image";

declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
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
async function scriptedTurn(impl: Impl, chatId: number, responses: AssistantMessage[]) {
  const faux = createFauxCore({models: [{id: "faux-model", contextWindow: 8_000_000}]});
  const requests: Message[][] = [];
  faux.setResponses(responses);
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

  it("does not reserve image bytes for workspace-only attachments", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const oversized = new Uint8Array(4 * 1024 * 1024);
    oversized.set(PNG);
    new DataView(oversized.buffer).setUint32(16, 8192);
    const blob = impl.gitCache.writeBlob(oversized);
    for (let index = 0; index < 4; ++index) {
      await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId, "Attached", {
        attachments: [{oid: blob.oid, mimeType: "image/png", name: `${index}.png`}],
      });
    }
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0].isError).toBe(false);
    expect(requests.at(-1)!.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "image") : [])).toHaveLength(1);
  }));

  it("rejects a step's excess image reads before loading their payloads", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set(PNG);
    const {chatId} = await setup(impl, bytes);
    const open = impl.openFileAtCommit.bind(impl);
    const bodyReads: number[] = [];
    vi.spyOn(impl, "openFileAtCommit").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (file) {
        const read = file.reader.read.bind(file.reader);
        vi.spyOn(file.reader, "read").mockImplementation((offset, length) => {
          if (length > 12) bodyReads.push(length);
          return read(offset, length);
        });
      }
      return file;
    });
    const {requests} = await turn(impl, chatId, [[read(), read(), read(), read(), read()]]);
    expect(results(requests.at(-1)!).filter(result => !result.isError)).toHaveLength(3);
    expect(bodyReads).toEqual([bytes.length, bytes.length, bytes.length]);
  }));

  it("reads RIFF-like UTF-8 as text", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl, new TextEncoder().encode("RIFF....WEBP is the container header."));
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0]).toMatchObject({isError: false,
      content: [{type: "text", text: expect.stringContaining("RIFF....WEBP is the container header.")}]});
  }));

  it("recovers from a provider decode error without replaying effects or poisoning later turns", async () => {
    const name = crypto.randomUUID();
    let chatId: number;
    await inKernel(name, async impl => {
      ({chatId} = await setup(impl, PNG.slice(0, 33))); // Valid IHDR, no pixel data.
      const {requests} = await scriptedTurn(impl, chatId, [
        fauxAssistantMessage([read(), fauxToolCall("writeFile", {
          workpiece: "IMAGES", filename: "note.txt", content: "Saved exactly once",
        })], {stopReason: "toolUse"}),
        fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 Could not process image"}),
        fauxAssistantMessage(fauxText("Please convert the image.")),
      ]);
      expect(results(requests[1])[0].content.some(part => part.type === "image")).toBe(true);
      expect(results(requests[2])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
      const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
      expect(calls.filter(call => call.toolName === "writeFile")).toHaveLength(1);
      expect(calls.find(call => call.toolName === "readFile")).toHaveProperty("image.rejected", true);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const open = vi.spyOn(impl, "openBlob");
      const {requests} = await turn(impl, chatId, []);
      expect(results(requests[0])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
      expect(open).not.toHaveBeenCalled();
    });
  });

  it.each(["400 Invalid request", "503 Could not process image"])("does not discard pixels for unrelated or transient failures: %s", message =>
    inKernel(crypto.randomUUID(), async impl => {
      const {chatId} = await setup(impl);
      const run = scriptedTurn(impl, chatId, [
        fauxAssistantMessage([read()], {stopReason: "toolUse"}),
        fauxAssistantMessage([], {stopReason: "error", errorMessage: message}),
        fauxAssistantMessage(fauxText("Recovered")),
      ]);
      if (message.startsWith("400")) await expect(run).rejects.toThrow(message);
      else await run;
      const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
      expect(calls.find(call => call.toolName === "readFile")).not.toHaveProperty("image.rejected");
    }));

  it("limits decode-error recovery to one retry and persists the final omission", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const failure = () => fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 invalid image data"});
    await expect(scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}), failure(),
      fauxAssistantMessage([read()], {stopReason: "toolUse"}), failure(),
    ])).rejects.toThrow("invalid image data");
    const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    expect(calls.filter(call => call.toolName === "readFile").every(call => call.image?.rejected)).toBe(true);
  }));

  it.each(["openai", "google"] as const)("recovers through the real %s provider adapter", provider => inKernel(crypto.randomUUID(), async impl => {
    const bytes = PNG.slice(0, 33);
    const {chatId} = await setup(impl, bytes);
    const config: AiModelConfig = {provider, model: provider === "openai" ? "gpt-6.1-sol" : "gemini-2.5-flash", apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const realStream = handle.stream;
    const faux = createFauxCore({models: [{id: "fixture"}]});
    faux.setResponses([
      fauxAssistantMessage([read()], {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Recovered")),
    ]);
    const requests: Message[][] = [];
    let body = "", providerError = "";
    handle.stream = (model, context, options) => {
      requests.push(structuredClone(context.messages));
      if (requests.length !== 2) return faux.stream(model, context, options);
      const response = realStream(model, context, {...options, maxRetries: 0, fetch: async (input, init) => {
        body = await new Request(input, init).text();
        return provider === "openai"
          ? new Response([
            {type: "response.created", response: {id: "resp_fixture", status: "in_progress", output: []}},
            {type: "response.failed", response: {id: "resp_fixture", status: "failed", output: [],
              error: {code: "image_parse_error", message: "Could not process image"}}},
          ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {headers: {"content-type": "text/event-stream"}})
          : Response.json({error: {code: 400, message: "Unable to process input image", status: "INVALID_ARGUMENT"}}, {status: 400});
      }});
      void response.result().then(message => { providerError = message.errorMessage ?? ""; });
      return response;
    };
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
    expect(body).toContain(bytes.toBase64());
    expect(providerError).toContain(provider === "openai" ? "image_parse_error" : "Unable to process input image");
    if (provider === "openai") expect(handle.lastResponse?.status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(results(requests[2])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const replay = await turn(impl, chatId, []);
    expect(results(replay.requests[0])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
  }));

  it("reruns explicit native /compact without rejected pixels through the real Anthropic adapter", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = PNG.slice(0, 33);
    const {chatId} = await setup(impl, bytes);
    await turn(impl, chatId, [[read()]]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    await turn(impl, chatId, []);
    impl.addChatMessages(chatId, USER, [{type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""}}]);
    const config: AiModelConfig = {provider: "anthropic", model: "claude-sonnet-5-5", apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const realStream = handle.stream;
    const bodies: string[] = [];
    handle.stream = (model, context, options) => realStream(model, context, {...options, maxRetries: 0, fetch: async (input, init) => {
      bodies.push(await new Request(input, init).text());
      if (bodies.length === 1) return Response.json({type: "error", error: {
        type: "invalid_request_error", message: "Could not process image",
      }}, {status: 400});
      const events = [
        {type: "message_start", message: {id: "msg_fixture", type: "message", role: "assistant", model: config.model,
          content: [], stop_reason: null, usage: {input_tokens: 0, output_tokens: 0}}},
        {type: "content_block_start", index: 0, content_block: {type: "compaction", content: "Image content omitted.", signature: "fixture"}},
        {type: "content_block_stop", index: 0},
        {type: "message_delta", delta: {stop_reason: "compaction"}, usage: {input_tokens: 0, output_tokens: 1}},
        {type: "message_stop"},
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: {"content-type": "text/event-stream"},
      });
    }});
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain(bytes.toBase64());
    expect(bodies[0]).toContain('"compaction"');
    expect(bodies[1]).not.toContain(bytes.toBase64());
    expect(bodies[1]).toContain(REJECTED_FILE_IMAGE);
    expect(impl.loadChatHistory(chatId).checkpoint?.summary).toBe("Image content omitted.");
  }));

  it.each([
    ["400 invalid image data", 400, true],
    ["image_parse_error: Could not process image", 200, true],
    ["Error Code image_parse_error: Could not process image", 200, true],
    [JSON.stringify({error: {code: 400, message: "Unable to process input image"}}), undefined, true],
    [JSON.stringify({error: {code: 503, message: "Unable to process input image"}}), undefined, false], ["422 Unable to decode the image", 422, true],
    ["400 image limit exceeded", 400, false], ["400 invalid image dimensions", 400, false],
    ["503 Could not process image", 503, false], ["Could not process image", undefined, false],
  ] as const)("recognizes only definite decode errors: %s", (message, status, expected) => {
    expect(isImageDecodeError(message, status)).toBe(expected);
  });

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
