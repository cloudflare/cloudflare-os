import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {abortAllDurableObjects, runInDurableObject} from "cloudflare:test";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
  type AssistantMessage, type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import {runAgent} from "../src/agent";
import {getModel} from "../src/ai-models";
import {estimateImageTokens, getModelTokenLimits} from "../src/agent-compaction";
import type {AiModelConfig} from "@gadgets/workshop-shared/api";
import {ELIDED_FILE_IMAGE, OVERFLOW_FILE_IMAGE, REJECTED_FILE_IMAGE, UNSUPPORTED_FILE_IMAGE, fileImageDescription, withImageDimensions, isImageDecodeError, readFileImage} from "../src/file-image";

declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
// A genuine 1x1 PNG, also used to verify the exact bytes sent to the provider.
const PNG = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");
// Genuine JPEG; extra COM segments below exercise the same pixels with a long metadata header.
const JPEG = Uint8Array.fromBase64("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z");
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

  it.each(["oversize", "dimensions", "patches", "truncated"])("rejects %s images without sending binary text", kind => inKernel(crypto.randomUUID(), async impl => {
    const bytes = kind === "oversize" ? new Uint8Array(4 * 1024 * 1024 + 1) : PNG.slice();
    bytes.set(PNG.slice(0, Math.min(bytes.length, PNG.length)));
    if (kind === "dimensions") new DataView(bytes.buffer).setUint32(16, 8001);
    if (kind === "patches") {
      // Header-only fixture: resolution admission runs before any provider can decode pixels.
      const view = new DataView(bytes.buffer);
      view.setUint32(16, 7680); view.setUint32(20, 4320);
    }
    const {chatId} = await setup(impl, kind === "truncated" ? bytes.slice(0, 16) : bytes);
    const {requests} = await turn(impl, chatId, [[read()]]);
    expect(results(requests.at(-1)!)[0].isError).toBe(true);
    expect(results(requests.at(-1)!)[0].content.every(part => part.type === "text")).toBe(true);
    expect([...impl.storage.chats.list()].flatMap(message => message.type === "message"
      ? message.toolCalls ?? [] : []).filter(call => call.toolName === "readFile").every(call => !call.image)).toBe(true);
  }));

  it.each([[6400, 4800, true], [6401, 4800, false], [8000, 3840, true], [8000, 3841, false]] as const)(
    "bounds 32px patch coverage for a %s x %s header", (width, height, accepted) => inKernel(crypto.randomUUID(), async impl => {
      const bytes = PNG.slice();
      const view = new DataView(bytes.buffer);
      view.setUint32(16, width); view.setUint32(20, height);
      const blob = impl.gitCache.writeBlob(bytes);
      const reader = await impl.openBlob(blob.oid);
      if (accepted) expect(readFileImage(reader)?.data).toBe(bytes.toBase64());
      else expect(() => readFileImage(reader)).toThrow("30,000 32px patches");
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
          if (length > 30) bodyReads.push(length);
          return read(offset, length);
        });
      }
      return file;
    });
    const {requests} = await turn(impl, chatId, [[read(), read(), read(), read(), read()]]);
    expect(results(requests.at(-1)!).filter(result => !result.isError)).toHaveLength(3);
    expect(bodyReads).toEqual([bytes.length, bytes.length, bytes.length]);
  }));

  it.each(["cloudflare", "cloudflare-auto-router", "ollama"] as const)(
    "keeps image references without loading pixels for text-only %s, then shows them after a model switch", provider => inKernel(crypto.randomUUID(), async impl => {
      const bytes = new Uint8Array(4 * 1024 * 1024);
      bytes.set(PNG);
      const {chatId, blob} = await setup(impl, bytes);
      const config: AiModelConfig = provider === "cloudflare" ? {
        provider, model: "@cf/zai-org/glm-5.2", apiToken: "fixture",
      } : provider === "ollama" ? {provider, model: "qwen3:8b", apiToken: "fixture",
        apiUrl: "http://ollama.fixture:11434/api"} : {provider, model: "cloudflare/auto", apiToken: "fixture",
        autoRouterPool: {models: ["@cf/openai/gpt-oss-20b"]}};
      const metadata = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe("http://ollama.fixture:11434/api/show");
        expect(await request.json()).toEqual({model: "qwen3:8b"});
        return Response.json({capabilities: ["completion", "tools"]});
      });
      if (provider === "ollama") vi.stubGlobal("fetch", metadata);
      try {
        const handle = getModel((provider === "ollama" ? {} : {CF_AI_GATEWAY: "fixture", CF_AI_GATEWAY_ACCOUNT_ID: "fixture",
          CF_AI_GATEWAY_API_TOKEN: "fixture", CF_AI_GATEWAY_PROVIDERS: "cloudflare,cloudflare-auto-router"}) as Cloudflare.Env, config, USER);
        if (provider !== "ollama") expect(handle.model.input).toEqual(["text"]);
        const realStream = handle.stream;
        const faux = createFauxCore({models: [{id: "fixture"}]});
        faux.setResponses([fauxAssistantMessage([read()], {stopReason: "toolUse"})]);
        const originalOpen = impl.openFileAtCommit.bind(impl);
        const bodyReads: number[] = [];
        vi.spyOn(impl, "openFileAtCommit").mockImplementation(async (...args) => {
          const file = await originalOpen(...args);
          if (file) {
            const read = file.reader.read.bind(file.reader);
            vi.spyOn(file.reader, "read").mockImplementation((offset, length) => {
              if (length > 30) bodyReads.push(length);
              return read(offset, length);
            });
          }
          return file;
        });
        let first = true;
        const bodies: string[] = [], pools: (string | null)[] = [];
        handle.stream = (model, context, options) => {
          if (first) {first = false; return faux.stream(model, context, options);}
          return realStream(model, context, {...options, maxRetries: 0, fetch: async (input, init) => {
            const request = new Request(input, init);
            bodies.push(await request.text());
            pools.push(request.headers.get("cf-aig-allowed-models"));
            return new Response(`data: ${JSON.stringify({id: "text", object: "chat.completion.chunk", created: 0,
              model: config.model, choices: [{index: 0, delta: {content: "Done"}, finish_reason: "stop"}],
            })}\n\ndata: [DONE]\n\n`, {headers: {"content-type": "text/event-stream"}});
          }});
        };
        const run = () => runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
        await run();
        expect(bodyReads).toEqual([]);
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
        const openBlob = vi.spyOn(impl, "openBlob");
        await run();
        expect(openBlob.mock.calls.filter(([oid]) => oid === blob.oid)).toHaveLength(0);
        for (const body of bodies) {
          expect(body).toContain(UNSUPPORTED_FILE_IMAGE);
          expect(body).not.toContain('"image_url"');
        }
        if (provider === "cloudflare-auto-router") expect(pools).toEqual([
          "@cf/openai/gpt-oss-20b", "@cf/openai/gpt-oss-20b",
        ]);
        const calls = impl.loadChatHistory(chatId).chatMessages.flatMap(message =>
          message.type === "message" ? message.toolCalls ?? [] : []);
        expect(calls.find(call => call.toolName === "readFile")).toHaveProperty("image.oid", blob.oid);
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Use vision now"}]);
        const switched = await turn(impl, chatId, []);
        expect(results(switched.requests[0])[0].content.some(part => part.type === "image")).toBe(true);
        if (provider === "ollama") expect(metadata).toHaveBeenCalledOnce();
      } finally {
        if (provider === "ollama") vi.unstubAllGlobals();
      }
    }));

  it.each([false, true].flatMap(longHeader => [false, true].map(attachment => ({longHeader, attachment}))))(
    "accounts for identical JPEG pixels on live reads and replay: %j", ({longHeader, attachment}) =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = longHeader ? new Uint8Array(JPEG.length + 2 * 65537) : JPEG;
      if (longHeader) {
        bytes.set(JPEG.subarray(0, 2));
        for (const offset of [2, 65539]) bytes.set([0xff, 0xfe, 0xff, 0xff], offset);
        bytes.set(JPEG.subarray(2), 2 + 2 * 65537);
      }
      const {chatId, blob} = await setup(impl, bytes);
      if (attachment) await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()),
        {profile: USER}, chatId, "Attached", {attachments: Array.from({length: 4}, (_, index) =>
          ({oid: blob.oid, mimeType: "image/jpeg", name: `${index}.jpg`}))});
      impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(68_500)}]);
      const config: AiModelConfig = {provider: "openai", model: "gpt-6-astra", apiToken: "fixture",
        contextWindow: 8_000_000, compactionInputBudget: 272_000};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({models: [{id: "fixture", contextWindow: 8_000_000}]});
      const imageTokens: number[] = [];
      handle.stream = (model, context, options) => {
        imageTokens.push(context.messages.reduce((sum, message) => sum + estimateImageTokens(message), 0));
        return faux.stream(model, context, options);
      };
      const checkpoints = vi.spyOn(impl, "commitChatCompaction");
      faux.setResponses([...(attachment ? [] : [fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"})]),
        fauxAssistantMessage(fauxText("Done"))]);
      const run = () => runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      await run();
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
      await run();
      expect(imageTokens).toEqual(attachment ? [4096, 4096] : [0, 4096, 4096]);
      expect(checkpoints).not.toHaveBeenCalled();
    }));

  it.each([false, true])("compacts tile-priced file images before sending them (replay=%s)", replay =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = PNG.slice();
      new DataView(bytes.buffer).setUint32(16, 768);
      new DataView(bytes.buffer).setUint32(20, 768);
      const {chatId} = await setup(impl, bytes);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(27_500)}]);
      if (replay) {
        await turn(impl, chatId, [[read(), read(), read()]]);
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue with vision"}]);
      }
      const config: AiModelConfig = {provider: "openai", model: "gpt-4o-mini", apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
        models: [{id: "fixture", contextWindow: 8_000_000}]});
      const commit = impl.commitAgentStep.bind(impl);
      vi.spyOn(impl, "commitAgentStep").mockImplementation((...args) => {
        // The prior request's measured usage excludes these newly returned pixels.
        if (args[4] && args[2].some(message => message.type === "message" && message.toolCalls?.some(call =>
          call.toolName === "readFile"))) args[4].totalTokens = 55_000;
        return commit(...args);
      });
      const requests: Message[][] = [];
      handle.stream = (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      };
      faux.setResponses([...(replay ? [] : [fauxAssistantMessage([read(), read(), read()], {stopReason: "toolUse"})]),
        fauxAssistantMessage(fauxText("Earlier context summary")), fauxAssistantMessage(fauxText("Done"))]);
      const checkpoints = vi.spyOn(impl, "commitChatCompaction");
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      expect(checkpoints).toHaveBeenCalledOnce();
      expect(faux.getPendingResponseCount()).toBe(0);
      // Pixel-bearing requests follow compaction, so the 55K-token prefix is gone.
      const withPixels = requests.filter(messages => messages.some(message =>
        typeof message.content !== "string" && message.content.some(part => part.type === "image")));
      expect(withPixels).toHaveLength(1);
      expect(withPixels[0].reduce((sum, message) => sum + estimateImageTokens(message, handle.model), 0)).toBe(76_503);
      expect(JSON.stringify(withPixels[0])).not.toContain("context ".repeat(27_500));
    }));

  it.each([false, true])("caps an unsplittable screenshot batch against the model window (replay=%s)", replay =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = PNG.slice();
      new DataView(bytes.buffer).setUint32(16, 1920);
      new DataView(bytes.buffer).setUint32(20, 1080);
      const {chatId} = await setup(impl, bytes);
      if (replay) {
        await turn(impl, chatId, [[read(), read(), read(), read()]]);
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue with vision"}]);
      }
      const config: AiModelConfig = {provider: "openai", model: "gpt-4o-mini", apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
        models: [{id: "fixture", contextWindow: 8_000_000}]});
      const requests: Message[][] = [];
      handle.stream = (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      };
      faux.setResponses([...(replay ? [] : [fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"})]),
        fauxAssistantMessage(fauxText("Done"))]);
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      const shown = results(requests.at(-1)!);
      expect(shown.filter(result => result.content.some(part => part.type === "image"))).toHaveLength(2);
      if (replay) expect(JSON.stringify(shown)).toContain(ELIDED_FILE_IMAGE);
      else expect(shown.filter(result => result.isError)).toHaveLength(2);
      // A retry/follow-up must keep the capped projection, rather than resurrecting four pixels.
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      const budget = Math.floor(getModelTokenLimits(config).inputBudget * 0.75);
      for (const messages of requests) expect(messages.reduce((sum, message) =>
        sum + estimateImageTokens(message, handle.model), 0)).toBeLessThanOrEqual(budget);
    }));

  it.each([
    {replay: false, overflow: false}, {replay: true, overflow: false},
    {replay: false, overflow: true}, {replay: true, overflow: true},
  ])("elides or recovers an unsplittable mixed image/text batch: %j", ({replay, overflow}) =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = PNG.slice();
      new DataView(bytes.buffer).setUint32(16, 1920);
      new DataView(bytes.buffer).setUint32(20, 1080);
      const logs = Array.from({length: overflow ? 6 : 5}, (_, index) => [`log${index}.txt`,
        new TextEncoder().encode("log entry with several fields ".repeat(1100).slice(0, 32100))] as [string, Uint8Array]);
      const {chatId} = await setup(impl, bytes, logs);
      const calls = [read(), read(), ...logs.map(([filename]) => read({filename}))];
      if (replay) await expect(scriptedTurn(impl, chatId, [
        fauxAssistantMessage(calls, {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxText(""), {stopReason: "error", errorMessage: "400 fixture stop after saved batch"}),
      ])).rejects.toThrow("400 fixture stop");
      const config: AiModelConfig = {provider: "openai", model: "gpt-4o-mini", apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
        models: [{id: "fixture", contextWindow: 8_000_000}]});
      const requests: Message[][] = [];
      const realStream = handle.stream;
      let overflowRequests = 0, rejectedBody = "";
      handle.stream = (model, context, options) => {
        requests.push(structuredClone(context.messages));
        if (overflow && overflowRequests === 0 && results(context.messages).length === calls.length &&
            results(context.messages).some(result => result.content.some(part => part.type === "image"))) {
          ++overflowRequests;
          return realStream(model, context, {...options, maxRetries: 0, fetch: async (input, init) => {
            rejectedBody = await new Request(input, init).text();
            return Response.json({error: {code: "context_length_exceeded", type: "invalid_request_error",
              message: "Your input exceeds the context window of this model"}}, {status: 400});
          }});
        }
        return faux.stream(model, context, options);
      };
      const effects = vi.spyOn(impl, "commitAgentStep");
      faux.setResponses([...(replay ? [] : [fauxAssistantMessage(calls, {stopReason: "toolUse"})]),
        ...Array.from({length: 6}, () => fauxAssistantMessage(fauxText("Summary or completed response")))]);
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      const retained = requests.findLast(messages => results(messages).length === calls.length)!;
      expect(retained).toBeDefined();
      expect(results(retained).flatMap(result => result.content.filter(part => part.type === "image"))).toHaveLength(overflow ? 0 : 1);
      expect(JSON.stringify(results(retained))).toContain(overflow ? OVERFLOW_FILE_IMAGE : ELIDED_FILE_IMAGE);
      expect(results(retained).filter(result => JSON.stringify(result.content).includes("log entry with several fields"))).toHaveLength(logs.length);
      const recorded = effects.mock.calls.flatMap(call => call[2]).flatMap(message =>
        message.type === "message" ? message.toolCalls ?? [] : []).filter(call => call.toolName === "readFile");
      expect(recorded).toHaveLength(replay ? 0 : calls.length);
      if (overflow) {
        expect(overflowRequests).toBe(1);
        expect(rejectedBody).toContain(bytes.toBase64());
        for (const [filename] of logs) expect(rejectedBody).toContain(filename);
      }
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      faux.setResponses(Array.from({length: 6}, () => fauxAssistantMessage(fauxText("Done"))));
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      expect(results(requests.at(-1)!).flatMap(result => result.content.filter(part => part.type === "image")).length).toBeLessThanOrEqual(1);
      expect([...impl.storage.chats.list()].flatMap(message => message.type === "message" ?
        message.toolCalls ?? [] : []).some(call => call.toolName === "readFile" && call.image?.rejected)).toBe(false);
    }));

  it.each([false, true])("bounds overflow recovery and subsequent explicit reads (second overflow=%s)", secondOverflow => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const faux = createFauxCore({models: [{id: "fixture", contextWindow: 8_000_000}]});
    const failure = () => fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 context_length_exceeded"});
    faux.setResponses([fauxAssistantMessage([read()], {stopReason: "toolUse"}), failure(),
      ...(secondOverflow ? [failure()] : [fauxAssistantMessage([read()], {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Done"))])]);
    const requests: Message[][] = [];
    const running = runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
      requests.push(structuredClone(context.messages));
      return faux.stream(model, context, options);
    }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "cloudflare", model: "fixture", apiToken: "", contextWindow: 8_000_000});
    if (secondOverflow) await expect(running).rejects.toThrow("context_length_exceeded");
    else await running;
    expect(requests).toHaveLength(secondOverflow ? 3 : 4);
    expect(results(requests[1])[0].content.some(part => part.type === "image")).toBe(true);
    expect(results(requests[2])[0].content).toEqual([{type: "text", text: OVERFLOW_FILE_IMAGE}]);
    const reads = impl.loadChatHistory(chatId).chatMessages.flatMap(message =>
      message.type === "message" ? message.toolCalls ?? [] : []).filter(call => call.toolName === "readFile");
    expect(reads).toHaveLength(secondOverflow ? 1 : 2);
    expect(reads.every(call => !call.image?.rejected)).toBe(true);
    for (const message of results(requests.at(-1)!)) expect(message.content).toEqual([{type: "text", text: OVERFLOW_FILE_IMAGE}]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Inspect the original in a fresh turn"}]);
    expect(results((await turn(impl, chatId, [])).requests[0])[0].content).toContainEqual({
      type: "image", mimeType: "image/png", data: PNG.toBase64(),
    });
  }));

  it("surfaces a text-only context overflow without adding a file-image retry", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await expect(scriptedTurn(impl, chatId, [fauxAssistantMessage([], {
      stopReason: "error", errorMessage: "400 context_length_exceeded without file pixels",
    })])).rejects.toThrow("context_length_exceeded without file pixels");
  }));

  it("shows the source-to-Claude coordinate transform on live reads and replay", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = PNG.slice();
    new DataView(bytes.buffer).setUint32(16, 3840);
    new DataView(bytes.buffer).setUint32(20, 2160);
    const {chatId} = await setup(impl, bytes);
    const config: AiModelConfig = {provider: "anthropic", model: "claude-opus-5-5", apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const faux = createFauxCore({models: [{id: "fixture", contextWindow: 8_000_000}]});
    const requests: Message[][] = [];
    handle.stream = (model, context, options) => {
      requests.push(structuredClone(context.messages));
      return faux.stream(model, context, options);
    };
    faux.setResponses([fauxAssistantMessage([read()], {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Done"))]);
    const run = () => runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
    await run();
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
    await run();
    for (const messages of requests.slice(1)) {
      const output = JSON.stringify(results(messages));
      expect(output).toContain("Source: 3840 x 2160");
      expect(output).toContain("Claude content frame: 2576 x 1449");
      expect(output).toContain("x * 3840/2576, y * 2160/1449");
      expect(output).toContain("desktop/DPI transform");
      expect(output).toContain(bytes.toBase64());
    }
  }));

  it.each([
    ["claude-sonnet-4-5", 1920, 1080, "1456 x 819"],
    ["claude-sonnet-4-20250514", 1920, 1080, "1456 x 819"],
    ["claude-opus-4-20250514", 1920, 1080, "1456 x 819"],
    ["claude-opus-4-7-20261001", 3840, 2160, "2576 x 1449"],
    ["claude-opus-4-7", 3840, 2160, "2576 x 1449"],
    ["claude-fable-5-2", 6400, 4800, "2212 x 1659"],
    ["claude-fable-5-1", 6400, 4800, "2212 x 1659"],
    ["claude-mythos-5-2", 6400, 4800, "2212 x 1659"],
    ["claude-mythos-5-1", 6400, 4800, "2212 x 1659"],
    ["claude-mythos-5", 6400, 4800, "2212 x 1659"],
    ["claude-sonnet-4-5", 1075, 1520, "924 x 1307"],
    ["claude-haiku-4-5", 6272, 3138, "1568 x 784"],
    ["claude-haiku-4-5", 3138, 6272, "784 x 1568"],
    ["claude-opus-5-5", 1000, 1000, "1000 x 1000"],
  ] as const)("describes documented native coordinate frames: %s %sx%s", (id, width, height, frame) => {
    const {model} = getModel({} as Cloudflare.Env, {provider: "anthropic", model: id, apiToken: "fixture"}, USER);
    const image = withImageDimensions({type: "image", mimeType: "image/png", data: ""}, [width, height]);
    expect(fileImageDescription(image, model)).toContain(`Claude content frame: ${frame}`);
  });

  it("requires a known crop/resize transform for providers without a coordinate mapping", () => {
    const {model} = getModel({} as Cloudflare.Env, {provider: "openai", model: "gpt-4o-mini", apiToken: "fixture"}, USER);
    const image = withImageDimensions({type: "image", mimeType: "image/png", data: ""}, [3840, 2160]);
    expect(fileImageDescription(image, model)).toContain("crop/resize within the selected model's native vision limits");
    expect(fileImageDescription(image, model)).not.toContain("Claude content frame");
  });

  it.each([
    ["anthropic", "claude-opus-5-5", 120_000, 4740],
    ["anthropic", "claude-opus-5-5", 45_000, 4740],
    ["anthropic", "claude-haiku-4-5", 45_000, 1564],
    ["anthropic", "claude-fable-5-2", 45_000, 4740],
    ["anthropic", "claude-fable-5-1", 45_000, 4740],
    ["anthropic", "claude-mythos-5-2", 45_000, 4740],
    ["anthropic", "claude-mythos-5-1", 45_000, 4740],
    ["anthropic", "claude-mythos-5", 45_000, 4740],
    ["openai", "gpt-4.1-mini", 128_000, 4977],
    ["openai", "gpt-4.1-mini", 45_000, 4977],
    ["openai", "gpt-5.2", 45_000, 3687],
    ["openai", "gpt-5.4", 45_000, 3000],
    ["openai", "gpt-4o", 45_000, 765],
  ] as const)("admits and replays four large images at the resized cost (%s/%s, %s)", (provider, model, budget, tokens) =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = PNG.slice();
      new DataView(bytes.buffer).setUint32(16, 6400);
      new DataView(bytes.buffer).setUint32(20, 4800);
      const {chatId} = await setup(impl, bytes);
      const config: AiModelConfig = {provider, model, apiToken: "fixture",
        contextWindow: 8_000_000, compactionInputBudget: budget};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({models: [{id: "fixture", contextWindow: 8_000_000}]});
      const requests: Message[][] = [];
      handle.stream = (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      };
      const run = () => runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
      faux.setResponses([fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"}),
        fauxAssistantMessage(fauxText("Done"))]);
      await run();
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
      await run();
      expect(requests).toHaveLength(3);
      for (const messages of requests.slice(1)) {
        const images = results(messages);
        expect(images).toHaveLength(4);
        for (const result of images) {
          expect(result.isError).toBe(false);
          expect(result.content).toContainEqual({type: "image", mimeType: "image/png", data: bytes.toBase64()});
          expect(estimateImageTokens(result, handle.model)).toBe(tokens);
        }
      }
    }));

  it.each(["claude-custom", "claude-mythos-preview"])("keeps conservative image accounting for unknown Claude aliases: %s", id => {
    const {model} = getModel({} as Cloudflare.Env, {provider: "anthropic", model: id, apiToken: "fixture"}, USER);
    const image = withImageDimensions({type: "image", mimeType: "image/png", data: ""}, [6400, 4800]);
    expect(estimateImageTokens({role: "user", content: [image], timestamp: 0}, model)).toBe(36_000);
  });

  it("admits visual token cost before reading an image body", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set(PNG);
    const reader = await impl.openBlob(impl.gitCache.writeBlob(bytes).oid);
    const reads = vi.spyOn(reader, "read");
    const admit = vi.fn(() => false);
    expect(readFileImage(reader, undefined, admit)).toBeUndefined();
    expect(admit).toHaveBeenCalledOnce();
    expect(reads.mock.calls.every(([, length]) => length <= 30)).toBe(true);
  }));

  it.each(["oversize", "dimensions"])("keeps a saved text-only %s read from stranding vision or /compact", kind =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = kind === "oversize" ? new Uint8Array(5.5 * 1024 * 1024) : PNG.slice();
      bytes.set(PNG);
      if (kind === "dimensions") new DataView(bytes.buffer).setUint32(16, 8001);
      const {chatId} = await setup(impl, bytes);
      const faux = createFauxCore({models: [{id: "fixture", contextWindow: 8_000_000}]});
      faux.setResponses([fauxAssistantMessage([read()], {stopReason: "toolUse"}), fauxAssistantMessage(fauxText("Done"))]);
      await runAgent(impl, {model: {...faux.getModel(), input: ["text"]}, stream: faux.stream}, chatId,
        AUTHOR, new AbortController().signal, USER, {provider: "cloudflare", model: "fixture", apiToken: "", contextWindow: 8_000_000});
      for (let retry = 0; retry < 2; ++retry) {
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue with vision"}]);
        const {requests} = await turn(impl, chatId, []);
        expect(results(requests[0])[0]).toMatchObject({isError: true});
        expect(JSON.stringify(results(requests[0]))).toContain(kind === "oversize" ? "4 MiB" : "8000 pixels");
      }
      impl.addChatMessages(chatId, USER, [{type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""}}]);
      const checkpoints = vi.spyOn(impl, "commitChatCompaction");
      await scriptedTurn(impl, chatId, [fauxAssistantMessage(fauxText("Earlier invalid image omitted."))]);
      expect(checkpoints).toHaveBeenCalledOnce();
    }));

  it.each(["dimensions", "legacy", "unavailable"])("bounds blob opens across a long image history (%s)", mode =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = new Uint8Array(1024 * 1024);
      bytes.set(PNG);
      new DataView(bytes.buffer).setUint32(16, 768);
      new DataView(bytes.buffer).setUint32(20, 768);
      const {chatId, blob} = await setup(impl, bytes);
      await turn(impl, chatId, [[read()]]);
      const original = impl.loadChatHistory(chatId).chatMessages.flatMap(message =>
        message.type === "message" ? message.toolCalls ?? [] : []).find(call => call.toolName === "readFile")!;
      expect(original.image?.dimensions).toEqual([768, 768]);
      for (let index = 0; index < 140; ++index) impl.addChatMessages(chatId, AUTHOR, [{type: "message", message: "",
        toolCalls: [{...original, toolCallId: `image-${index}`}]}]);
      if (mode === "legacy") for (const message of impl.storage.chats.list()) {
        if (message.type === "message" && message.toolCalls?.some(call => call.image)) impl.storage.chats.put({
          ...message, toolCalls: message.toolCalls.map(call => call.image
            ? {...call, image: {...call.image, dimensions: undefined}} : call),
        });
      }
      const config: AiModelConfig = {provider: "openai", model: "gpt-4o-mini", apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({models: [{id: "fixture", contextWindow: 8_000_000}]});
      const requests: Message[][] = [];
      handle.stream = (model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(model, context, options);
      };
      const openBlob = impl.openBlob.bind(impl);
      const opens = vi.spyOn(impl, "openBlob").mockImplementation(oid => {
        if (mode === "unavailable" && oid === blob.oid) throw new Error("Fixture blob unavailable");
        return openBlob(oid);
      });
      for (let turn = 0; turn < 2; ++turn) {
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
        faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
        opens.mockClear();
        await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
        expect(opens.mock.calls.filter(([oid]) => oid === blob.oid)).toHaveLength(mode === "dimensions" ? 3 : 4);
        expect(results(requests.at(-1)!).filter(result => result.content.some(part => part.type === "image")))
          .toHaveLength(mode === "unavailable" ? 0 : 3);
      }
    }));

  it.each(["model switch", "router pool switch", "unchanged vision model"] as const)(
    "checks newly visible history images before compaction after a %s", mode => inKernel(crypto.randomUUID(), async impl => {
      const bytes = PNG.slice();
      const dimensions = new DataView(bytes.buffer);
      dimensions.setUint32(16, 6400); dimensions.setUint32(20, 4800);
      const {chatId} = await setup(impl, bytes);
      // 150K text tokens plus four 36K image estimates crosses Astra's 272K input tier.
      impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(75_000)}]);
      const gatewayEnv = {CF_AI_GATEWAY: "fixture", CF_AI_GATEWAY_ACCOUNT_ID: "fixture",
        CF_AI_GATEWAY_API_TOKEN: "fixture", CF_AI_GATEWAY_PROVIDERS: "openai,cloudflare,cloudflare-auto-router"} as Cloudflare.Env;
      const vision: AiModelConfig = mode === "router pool switch" ? {
        provider: "cloudflare-auto-router", model: "cloudflare/auto", apiToken: "fixture",
        autoRouterPool: {models: ["openai/gpt-6-astra"]},
      } : {provider: "openai", model: "gpt-6-astra", apiToken: "fixture"};
      const first: AiModelConfig = mode === "unchanged vision model" ? vision
        : mode === "router pool switch" ? {...vision, autoRouterPool: {models: ["@cf/openai/gpt-oss-20b"]}}
        : {provider: "cloudflare", model: "@cf/zai-org/glm-5.2", apiToken: "fixture"};
      const handle = getModel(gatewayEnv, first, USER);
      const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
        models: [{id: "fixture", contextWindow: 8_000_000}]});
      const response = (text: string, model = handle.model) => ({...fauxAssistantMessage(fauxText(text)),
        api: model.api, provider: model.provider, model: model.id});
      const measured = response("Done");
      faux.setResponses([{...fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"}),
        api: handle.model.api, provider: handle.model.provider, model: handle.model.id}, measured]);
      handle.stream = faux.stream;
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
        {...first, contextWindow: 8_000_000, compactionInputBudget: 8_000_000});
      const history = impl.loadChatHistory(chatId);
      expect(history.measuredTokens).toBeGreaterThan(150_000);
      expect(history.measuredTokens).toBeLessThan(180_000);
      const last = history.chatMessages.findLast(message => message.type === "message" && message.author.type === "agent")!;
      expect(impl.getChatModelData(chatId, last.sequence)?.inputImageTokens)
        .toBe(mode === "unchanged vision model" ? 144_000 : 0);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue with vision"}]);
      const checkpoints = vi.spyOn(impl, "commitChatCompaction");
      const next = getModel(gatewayEnv, vision, USER);
      faux.setResponses([...(mode === "unchanged vision model" ? [] : [response("Earlier context summary", next.model)]),
        response("Done", next.model)]);
      next.stream = faux.stream;
      await runAgent(impl, next, chatId, AUTHOR, new AbortController().signal, USER,
        {...vision, contextWindow: 8_000_000, compactionInputBudget: 272_000});
      expect(checkpoints).toHaveBeenCalledTimes(mode === "unchanged vision model" ? 0 : 1);
      expect(faux.getPendingResponseCount()).toBe(0);
    }));

  it.each([false, true])("keeps measured usage across image eviction (provider downsamples=%s)", downsampled => inKernel(crypto.randomUUID(), async impl => {
    const thumbnail = PNG.slice(), large = PNG.slice();
    new DataView(thumbnail.buffer).setUint32(16, 1024);
    new DataView(thumbnail.buffer).setUint32(20, 1024);
    new DataView(large.buffer).setUint32(16, 6400);
    new DataView(large.buffer).setUint32(20, 4800);
    const {chatId} = await setup(impl, downsampled ? large : thumbnail, [["next.png", downsampled ? thumbnail : large],
      ["notes.txt", new TextEncoder().encode("notes ".repeat(5500))]]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(downsampled ? 20_000 : 65_000)}]);
    const config: AiModelConfig = downsampled
      ? {provider: "anthropic", model: "claude-haiku-4-5", apiToken: "fixture"}
      : {provider: "openai", model: "gpt-6-astra", apiToken: "fixture"};
    const measured = downsampled ? 168_000 : 215_000;
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
      models: [{id: "fixture", contextWindow: 8_000_000}]});
    faux.setResponses([fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done"))]);
    handle.stream = faux.stream;
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
      {...config, contextWindow: 8_000_000, compactionInputBudget: 8_000_000});
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, totalTokens: measured});
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Read the next image batch"}]);
    const commit = impl.commitAgentStep.bind(impl);
    vi.spyOn(impl, "commitAgentStep").mockImplementation((...args) => {
      // Faux's text-only tokenizer cannot represent the prior provider's billed usage. Seed
      // that actual measurement at the real persistence barrier before the live budget check.
      if (args[4] && args[2].some(message => message.type === "message" && message.toolCalls?.some(call =>
        call.toolName === "readFile" && call.input.filename === "next.png"))) args[4].totalTokens = measured;
      return commit(...args);
    });
    faux.setResponses([fauxAssistantMessage([read({filename: "next.png"}), read({filename: downsampled ? "notes.txt" : "next.png"})], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Summary")), fauxAssistantMessage(fauxText("Done"))]);
    const checkpoints = vi.spyOn(impl, "commitChatCompaction");
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
      {...config, contextWindow: 8_000_000, compactionInputBudget: downsampled ? 200_000 : 272_000});
    expect(checkpoints).toHaveBeenCalledOnce();
    expect(faux.getPendingResponseCount()).toBe(0);
  }));

  it.each([false, true])("preserves legacy measured usage only without historical media (media=%s)", hasMedia =>
    inKernel(crypto.randomUUID(), async impl => {
      const {chatId} = await setup(impl);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(20_000)}]);
      await turn(impl, chatId, hasMedia ? [[read()]] : []);
      const last = impl.loadChatHistory(chatId).chatMessages.findLast(message =>
        message.type === "message" && message.author.type === "agent")!;
      const {inputImageTokens: _legacyMissing, ...legacy} = impl.getChatModelData(chatId, last.sequence)!;
      impl.storage.chatModelData.put({chatId, sequence: last.sequence, message: legacy});
      // Older provider usage remains authoritative for text-only history, even when the
      // character estimate is much smaller. An ambiguous old media projection is re-estimated.
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, totalTokens: 250_000});
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
      const config: AiModelConfig = {provider: "openai", model: "gpt-6-astra", apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
        models: [{id: "fixture", contextWindow: 8_000_000}]});
      faux.setResponses([...(hasMedia ? [] : [fauxAssistantMessage(fauxText("Summary"))]),
        fauxAssistantMessage(fauxText("Done"))]);
      handle.stream = faux.stream;
      const checkpoints = vi.spyOn(impl, "commitChatCompaction");
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
        {...config, contextWindow: 8_000_000, compactionInputBudget: 272_000});
      expect(checkpoints).toHaveBeenCalledTimes(hasMedia ? 0 : 1);
      expect(faux.getPendingResponseCount()).toBe(0);
    }));

  it.each(["model", "router pool"] as const)("keeps history when a %s switch removes all pixels", mode => inKernel(crypto.randomUUID(), async impl => {
    const bytes = PNG.slice();
    const dimensions = new DataView(bytes.buffer);
    dimensions.setUint32(16, 6400); dimensions.setUint32(20, 4800);
    const {chatId} = await setup(impl, bytes);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(34_000)}]);
    const gatewayEnv = {CF_AI_GATEWAY: "fixture", CF_AI_GATEWAY_ACCOUNT_ID: "fixture",
      CF_AI_GATEWAY_API_TOKEN: "fixture", CF_AI_GATEWAY_PROVIDERS: "openai,cloudflare,cloudflare-auto-router"} as Cloudflare.Env;
    const vision: AiModelConfig = mode === "router pool" ? {
      provider: "cloudflare-auto-router", model: "cloudflare/auto", apiToken: "fixture",
      autoRouterPool: {models: ["openai/gpt-6-astra"]},
    } : {provider: "openai", model: "gpt-6-astra", apiToken: "fixture"};
    const handle = getModel(gatewayEnv, vision, USER);
    const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
      models: [{id: "fixture", contextWindow: 8_000_000}]});
    faux.setResponses([fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done"))]);
    handle.stream = faux.stream;
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
      {...vision, contextWindow: 8_000_000, compactionInputBudget: 8_000_000});
    // Faux counts text only. Seed the prior provider measurement including the 144K image cost.
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, totalTokens: 215_000});
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue without pixels"}]);
    const text: AiModelConfig = mode === "router pool" ? {...vision,
      autoRouterPool: {models: ["@cf/openai/gpt-oss-20b"]}}
      : {provider: "cloudflare", model: "@cf/zai-org/glm-5.2", apiToken: "fixture"};
    const next = getModel(gatewayEnv, text, USER);
    expect(next.model.input).toEqual(["text"]);
    const checkpoints = vi.spyOn(impl, "commitChatCompaction");
    faux.setResponses([fauxAssistantMessage(fauxText("Done"))]);
    next.stream = faux.stream;
    await runAgent(impl, next, chatId, AUTHOR, new AbortController().signal, USER,
      {...text, contextWindow: 8_000_000, compactionInputBudget: 216_634});
    expect(checkpoints).not.toHaveBeenCalled();
    expect(faux.getPendingResponseCount()).toBe(0);
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

  it("keeps older reads elided during recovery and admits explicit reads across later reloads", () => inKernel(crypto.randomUUID(), async impl => {
    // Distinct immutable blobs: both ends are corrupt, but only the newest four enter replay.
    const older = Array.from({length: 5}, (_, index) => new Uint8Array([
      ...(index === 0 || index === 4 ? PNG.slice(0, 33) : PNG), index,
    ]));
    const {chatId} = await setup(impl, PNG, older.map((bytes, index) => [`old-${index}.png`, bytes]));
    await turn(impl, chatId, older.map((_, index) => [read({filename: `old-${index}.png`})]));
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 invalid image data"}),
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage([read(), read(), read(), read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Recovered with fresh pixels")),
    ]);
    expect(requests).toHaveLength(4);
    const initial = results(requests[0]);
    expect(initial[0].content).toEqual([{type: "text", text: ELIDED_FILE_IMAGE}]);
    expect(initial.slice(1).flatMap(result => result.content.filter(part => part.type === "image"))
      .map(part => part.data)).toEqual(older.slice(1).map(bytes => bytes.toBase64()));
    const retry = results(requests[1]);
    expect(retry[0].content).toEqual([{type: "text", text: ELIDED_FILE_IMAGE}]);
    expect(retry.slice(1).every(result => result.content.some(part => part.type === "text" && part.text === REJECTED_FILE_IMAGE))).toBe(true);
    for (const [index, expectedCount] of [[2, 1], [3, 4]]) {
      const shown = results(requests[index]);
      expect(shown[0].content).toEqual([{type: "text", text: ELIDED_FILE_IMAGE}]);
      expect(shown.flatMap(result => result.content.filter(part => part.type === "image")))
        .toEqual(Array.from({length: expectedCount}, () => ({type: "image", mimeType: "image/png", data: PNG.toBase64()})));
    }
  }));

  it("preserves earlier omitted observations of a blob when the rejected batch is reverted", () => inKernel(crypto.randomUUID(), async impl => {
    const newer = [
      ...[1, 2, 3].map(index => new Uint8Array([...PNG, index])), PNG, PNG.slice(0, 33),
    ];
    const {chatId} = await setup(impl, PNG, newer.map((bytes, index) => [`new-${index}.png`, bytes]));
    await turn(impl, chatId, [[read()]]);
    const older = impl.loadChatHistory(chatId).chatMessages.findLast(msg =>
      msg.type === "message" && msg.toolCalls?.some(call => call.toolName === "readFile"))!;
    const newerFrom = impl.nextChatSequencePeek(chatId);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Read the newer batch"}]);
    await turn(impl, chatId, newer.map((_, index) => [read({filename: `new-${index}.png`})]));
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 invalid image data"}),
      fauxAssistantMessage(fauxText("Omitted the failed batch")),
    ]);
    expect(results(requests[0])[0].content).toEqual([{type: "text", text: ELIDED_FILE_IMAGE}]);
    expect(results(requests[1])[0].content).toEqual([{type: "text", text: ELIDED_FILE_IMAGE}]);
    const savedOlder = impl.loadChatHistory(chatId).chatMessages.find(msg => msg.sequence === older.sequence);
    expect(savedOlder?.type === "message" && savedOlder.toolCalls?.some(call =>
      call.toolName === "readFile" && call.image?.rejected)).toBe(false);
    const latestSameBlob = impl.loadChatHistory(chatId).chatMessages.flatMap(msg =>
      msg.type === "message" ? msg.toolCalls ?? [] : []).findLast(call =>
        call.toolName === "readFile" && call.input.filename === "new-3.png");
    expect(latestSameBlob).toHaveProperty("image.rejected", true);
    impl.addChatMessages(chatId, USER, [{type: "revert", revertFrom: newerFrom},
      {type: "message", message: "Continue from before that batch"}]);
    const replay = await turn(impl, chatId, []);
    expect(results(replay.requests[0])[0].content).toContainEqual({type: "image", mimeType: "image/png", data: PNG.toBase64()});
  }));

  it.each([
    ["openai", "image_parse_error", 200], ["openai", "invalid_image", 200],
    ["openai", "invalid_image_format", 200],
    ["openai", "invalid_image_mode", 200], ["openai", "invalid_base64_image", 200],
    ["openai", "unsupported_image_media_type", 200], ["openai", "empty_image_file", 200],
    ["openai", "invalid_image_format", 400], ["openai", "invalid_image_mode", 422],
    ["google", "Unable to process input image", 400],
    ["cloudflare-auto-router", "invalid_image_format", 400],
    ["cloudflare-auto-router", "invalid_image_mode", 422],
    ["ollama", "decode WebP image: webp: invalid format", 500],
    ["ollama", "decode WebP image: riff: list subchunk too long", 500],
    ["ollama", "decode WebP image: unexpected EOF", 500],
    ["ollama", "Failed to load image or audio file", 500],
  ] as const)("recovers through the real %s provider adapter: %s (%s)", (provider, errorCode, status) => inKernel(crypto.randomUUID(), async impl => {
    const bytes = PNG.slice(0, 33);
    const {chatId} = await setup(impl, bytes);
    const config: AiModelConfig = {provider, model: provider === "cloudflare-auto-router" ? "cloudflare/auto"
      : provider === "openai" ? "gpt-6.1-sol" : provider === "ollama" ? "fixture-vision" : "gemini-2.5-flash", apiToken: "fixture",
      ...(provider === "cloudflare-auto-router" ? {autoRouterPool: {models: ["openai/gpt-6-astra"]}} : {})};
    const handle = getModel((provider === "ollama" ? {} : {CF_AI_GATEWAY: "fixture", CF_AI_GATEWAY_ACCOUNT_ID: "fixture",
      CF_AI_GATEWAY_API_TOKEN: "fixture", CF_AI_GATEWAY_PROVIDERS: "openai,cloudflare-auto-router"}) as Cloudflare.Env, config, USER);
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
        if ((provider === "openai" || provider === "cloudflare-auto-router") && status !== 200) return Response.json({error: {
          code: errorCode, message: "You uploaded an unsupported image.", type: "invalid_request_error", param: null,
        }}, {status});
        if (provider === "ollama") return Response.json({error: {message: errorCode}}, {status});
        return provider === "openai"
          ? new Response([
            {type: "response.created", response: {id: "resp_fixture", status: "in_progress", output: []}},
            {type: "response.failed", response: {id: "resp_fixture", status: "failed", output: [],
              error: {code: errorCode, message: "Could not process image"}}},
          ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {headers: {"content-type": "text/event-stream"}})
          : Response.json({error: {code: 400, message: "Unable to process input image", status: "INVALID_ARGUMENT"}}, {status: 400});
      }});
      void response.result().then(message => { providerError = message.errorMessage ?? ""; });
      return response;
    };
    if (provider === "ollama") vi.stubGlobal("fetch", async () => Response.json({capabilities: ["completion", "vision"]}));
    try {
      await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
    } finally {if (provider === "ollama") vi.unstubAllGlobals();}
    expect(body).toContain(bytes.toBase64());
    expect(providerError).toContain(errorCode);
    if (provider === "openai") {
      if (status === 200) expect(handle.lastResponse?.status).toBe(200);
      else expect(providerError).toContain(`OpenAI API error (${status}):`);
    }
    expect(requests).toHaveLength(3);
    expect(results(requests[2])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const replay = await turn(impl, chatId, []);
    expect(results(replay.requests[0])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
  }));

  it("recovers a valid file image rejected by an Ollama-compatible text-only endpoint without /api/show", () =>
    inKernel(crypto.randomUUID(), async impl => {
      const {chatId} = await setup(impl);
      const config: AiModelConfig = {provider: "ollama", model: `text-only-${crypto.randomUUID()}`, apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const realStream = handle.stream;
      const faux = createFauxCore({models: [{id: "fixture"}]});
      faux.setResponses([fauxAssistantMessage([read()], {stopReason: "toolUse"})]);
      const requests: Message[][] = [], bodies: string[] = [];
      handle.stream = (model, context, options) => {
        requests.push(structuredClone(context.messages));
        if (requests.length === 1) return faux.stream(model, context, options);
        return realStream(model, context, {...options, maxRetries: 0, fetch: async (input, init) => {
          bodies.push(await new Request(input, init).text());
          if (bodies.at(-1)!.includes(PNG.toBase64())) return Response.json({error: {code: 500, type: "server_error",
            message: "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj",
          }}, {status: 500});
          return new Response([
            {id: "text-only", choices: [{index: 0, delta: {role: "assistant", content: "Recovered"}, finish_reason: null}]},
            {id: "text-only", choices: [{index: 0, delta: {}, finish_reason: "stop"}]},
          ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
            headers: {"content-type": "text/event-stream"},
          });
        }});
      };
      const probe = vi.fn(async (_url: string) => new Response("Not found", {status: 404}));
      vi.stubGlobal("fetch", probe);
      try {
        const run = () => runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
        await run();
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue on an unrelated topic"}]);
        await run();
      } finally {vi.unstubAllGlobals();}
      expect(probe).toHaveBeenCalledOnce();
      expect(String(probe.mock.calls[0][0])).toContain("/api/show");
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toContain(PNG.toBase64());
      expect(bodies.slice(1).every(body => !body.includes(PNG.toBase64()))).toBe(true);
      expect(requests).toHaveLength(4);
      for (const messages of requests.slice(2)) expect(results(messages)[0].content)
        .toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
    }));

  it.each(["openai", "cloudflare-auto-router"] as const)("surfaces a %s image-policy refusal once and omits those pixels later", async provider => {
    const name = crypto.randomUUID();
    let chatId: number;
    await inKernel(name, async impl => {
      ({chatId} = await setup(impl));
      await turn(impl, chatId, [[read()]]);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Describe it"}]);
      const config: AiModelConfig = {provider, model: provider === "openai" ? "gpt-6-astra" : "cloudflare/auto",
        apiToken: "fixture", ...(provider === "cloudflare-auto-router" ? {autoRouterPool: {models: ["openai/gpt-6-astra"]}} : {})};
      const handle = getModel({CF_AI_GATEWAY: "fixture", CF_AI_GATEWAY_ACCOUNT_ID: "fixture",
        CF_AI_GATEWAY_API_TOKEN: "fixture", CF_AI_GATEWAY_PROVIDERS: "openai,cloudflare-auto-router"} as Cloudflare.Env, config, USER);
      const stream = handle.stream;
      let requests = 0;
      handle.stream = (model, context, options) => stream(model, context, {...options, maxRetries: 0, fetch: async () => {
        ++requests;
        if (provider === "cloudflare-auto-router") return Response.json({error: {
          code: "image_content_policy_violation", message: "Image rejected under the image policy.",
          type: "invalid_request_error", param: null,
        }}, {status: 400});
        return new Response(`data: ${JSON.stringify({type: "response.failed", response: {
          id: "policy", status: "failed", output: [], error: {
            code: "image_content_policy_violation", message: "Image rejected under the image policy.",
          },
        }})}\n\n`, {headers: {"content-type": "text/event-stream"}});
      }});
      await expect(runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config))
          .rejects.toThrow("image_content_policy_violation");
      expect(requests).toBe(1);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Now discuss an unrelated topic"}]);
      await impl.ctx.storage.sync();
    });
    await abortAllDurableObjects();
    await inKernel(name, async impl => {
      const {requests} = await turn(impl, chatId, []);
      expect(results(requests[0])[0].content).toEqual([{type: "text", text: REJECTED_FILE_IMAGE}]);
    });
  });

  it("surfaces a second automatic compaction image rejection without sending stale pixels", () => inKernel(crypto.randomUUID(), async impl => {
    const bytes = PNG.slice();
    const dimensions = new DataView(bytes.buffer);
    dimensions.setUint32(16, 6400); dimensions.setUint32(20, 4800);
    const second = new Uint8Array([...bytes, 1]);
    const {chatId} = await setup(impl, bytes, [["second.png", second]]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "context ".repeat(200_000)}]);
    const config: AiModelConfig = {provider: "anthropic", model: "claude-sonnet-5-5", apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const faux = createFauxCore({api: handle.model.api, provider: handle.model.provider,
      models: [{id: "fixture", contextWindow: 8_000_000}]});
    faux.setResponses([
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage([read({filename: "second.png"})], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done")),
    ]);
    const realStream = handle.stream;
    handle.stream = faux.stream;
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
      {...config, contextWindow: 8_000_000, compactionInputBudget: 8_000_000});
    // The measured usage retains the second read. After the first rejection invalidates that
    // measurement, the larger character estimate moves the summary boundary past both reads.
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, totalTokens: 250_000});
    // Leave room for exactly one resized Claude image in the measured compaction tail.
    impl.addChatMessages(chatId, USER, [{type: "message", message: "tail ".repeat(22_000)}]);
    const bodies: string[] = [];
    handle.stream = (model, context, options) => realStream(model, context, {...options, maxRetries: 0, fetch: async (input, init) => {
      bodies.push(await new Request(input, init).text());
      return Response.json({type: "error", error: {
        type: "invalid_request_error", message: "Could not process image",
      }}, {status: 400});
    }});
    await expect(runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER,
      {...config, contextWindow: 8_000_000, compactionInputBudget: 272_000})).rejects.toThrow("Could not process image");
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => body.includes('"compaction"'))).toBe(true);
    expect(bodies[0]).toContain(bytes.toBase64());
    expect(bodies[0]).not.toContain(second.toBase64());
    expect(bodies[1]).toContain(second.toBase64());
    expect(bodies[1]).not.toContain(bytes.toBase64());
    const reads = impl.loadChatHistory(chatId).chatMessages.flatMap(message => message.type === "message"
      ? (message.toolCalls ?? []).filter(call => call.toolName === "readFile") : []);
    expect(reads).toHaveLength(2);
    expect(reads.every(call => call.toolName === "readFile" && call.image?.rejected)).toBe(true);
    expect(impl.loadChatHistory(chatId).checkpoint).toBeUndefined();
  }));

  it.each([
    ["Could not process image", REJECTED_FILE_IMAGE],
    ["prompt is too long: 210000 tokens > 200000 maximum", OVERFLOW_FILE_IMAGE],
  ])("reruns native /compact without file pixels after %s", (errorMessage, marker) => inKernel(crypto.randomUUID(), async impl => {
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
        type: "invalid_request_error", message: errorMessage,
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
    expect(bodies[1]).toContain(marker);
    expect(impl.loadChatHistory(chatId).checkpoint?.summary).toBe("Image content omitted.");
  }));

  it.each([
    ["400 invalid image data", 400, true],
    ["500 decode WebP image: webp: invalid format", 500, false],
    ["500 internal server error", 500, false],
    ["503 decode WebP image: webp: invalid format", 503, false],
    ["image_parse_error: Could not process image", 200, true],
    ["Error Code image_parse_error: Could not process image", 200, true],
    ["invalid_image_mode: Could not process image", 200, true],
    ['OpenAI API error (400): {"code":"invalid_image_format","message":"The supplied image could not be parsed."}', 400, true],
    ['400: {"code":"invalid_image_format","message":"You uploaded an unsupported image."}', 400, true],
    ['422: {"code":"invalid_image_mode","message":"You uploaded an unsupported image."}', 422, true],
    ['503: {"code":"invalid_image_format","message":"You uploaded an unsupported image."}', 503, false],
    ['400: {"code":"image_content_policy_violation","message":"You uploaded an unsupported image."}', 400, false],
    ['OpenAI API error (503): {"code":"invalid_image_format","message":"The supplied image could not be parsed."}', 503, false],
    ["image_content_policy_violation: Could not process image", 200, false],
    ["failed_to_download_image: Could not process image", 200, false],
    [JSON.stringify({error: {code: 400, message: "Unable to process input image"}}), undefined, true],
    [JSON.stringify({error: {code: 503, message: "Unable to process input image"}}), undefined, false], ["422 Unable to decode the image", 422, true],
    ["400 image limit exceeded", 400, false], ["400 invalid image dimensions", 400, false],
    ["503 Could not process image", 503, false], ["Could not process image", undefined, false],
  ] as const)("recognizes only definite decode errors: %s", (message, status, expected) => {
    expect(isImageDecodeError(message, status)).toBe(expected);
  });

  it.each([
    ["ollama", 500, true], ["ollama", 503, false], ["openai", 500, false], [undefined, 500, false],
  ] as const)("scopes llama.cpp decoder failure to Ollama (%s, %s)", (provider, status, expected) => {
    expect(isImageDecodeError("Failed to load image or audio file", status, provider)).toBe(expected);
  });

  it.each([
    ["ollama", 500, true], ["ollama", 503, false], ["openai", 500, false], [undefined, 500, false],
  ] as const)("scopes the stable WebP decoder prefix to Ollama (%s, %s)", (provider, status, expected) => {
    expect(isImageDecodeError("decode WebP image: riff: list subchunk too long", status, provider)).toBe(expected);
  });

  it.each([
    ["ollama", 500, true], ["ollama", 503, false], ["openai", 500, false], [undefined, 500, false],
  ] as const)("scopes explicit unsupported-image input to Ollama (%s, %s)", (provider, status, expected) => {
    expect(isImageDecodeError("image input is not supported - hint: provide the mmproj", status, provider)).toBe(expected);
    expect(isImageDecodeError("audio input is not supported", status, provider)).toBe(false);
  });

  it.each(["png", "webp", "jpeg"])("rejects %s resolution from a real blob header without reading its body", format =>
    inKernel(crypto.randomUUID(), async impl => {
      const bytes = new Uint8Array(2 * 1024 * 1024), view = new DataView(bytes.buffer);
      if (format === "png") {
        bytes.set(PNG); view.setUint32(16, 7680); view.setUint32(20, 4320);
      } else if (format === "webp") {
        bytes.set(new TextEncoder().encode("RIFF....WEBPVP8X")); view.setUint32(4, bytes.length - 8, true);
        bytes.set([0xff, 0x1d, 0, 0xdf, 0x10, 0], 24); // 7680 x 4320.
      } else {
        bytes.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]); // Seek across a large APP segment.
        const sof = 4 + 65535;
        bytes.set([0xff, 0xc0, 0, 8, 8, 0x10, 0xe0, 0x1e, 0, 1], sof);
      }
      const blob = impl.gitCache.writeBlob(bytes);
      const reader = await impl.openBlob(blob.oid);
      const ranges = vi.spyOn(reader, "read");
      expect(() => readFileImage(reader)).toThrow("resolution exceeds");
      expect(ranges.mock.calls.every(([, length]) => length <= 1024)).toBe(true);
      expect(ranges).not.toHaveBeenCalledWith(0, bytes.length);
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
