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
import {ELIDED_FILE_IMAGE, REJECTED_FILE_IMAGE, UNSUPPORTED_FILE_IMAGE, isImageDecodeError, readFileImage} from "../src/file-image";

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

  it.each(["cloudflare", "cloudflare-auto-router"] as const)(
    "keeps image references without loading pixels for text-only %s, then shows them after a model switch", provider => inKernel(crypto.randomUUID(), async impl => {
      const bytes = new Uint8Array(4 * 1024 * 1024);
      bytes.set(PNG);
      const {chatId, blob} = await setup(impl, bytes);
      const config: AiModelConfig = provider === "cloudflare" ? {
        provider, model: "@cf/zai-org/glm-5.2", apiToken: "fixture",
      } : {provider, model: "cloudflare/auto", apiToken: "fixture",
        autoRouterPool: {models: ["@cf/openai/gpt-oss-20b"]}};
      const handle = getModel({CF_AI_GATEWAY: "fixture", CF_AI_GATEWAY_ACCOUNT_ID: "fixture",
        CF_AI_GATEWAY_API_TOKEN: "fixture", CF_AI_GATEWAY_PROVIDERS: "cloudflare,cloudflare-auto-router"} as Cloudflare.Env, config, USER);
      expect(handle.model.input).toEqual(["text"]);
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
            if (length > 12) bodyReads.push(length);
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
  ] as const)("recovers through the real %s provider adapter: %s (%s)", (provider, errorCode, status) => inKernel(crypto.randomUUID(), async impl => {
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
        if (provider === "openai" && status !== 200) return Response.json({error: {
          code: errorCode, message: "The supplied image could not be parsed.", type: "invalid_request_error", param: null,
        }}, {status});
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
    await runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config);
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

  it("surfaces an image-policy refusal once and omits those pixels from later turns", async () => {
    const name = crypto.randomUUID();
    let chatId: number;
    await inKernel(name, async impl => {
      ({chatId} = await setup(impl));
      await turn(impl, chatId, [[read()]]);
      impl.addChatMessages(chatId, USER, [{type: "message", message: "Describe it"}]);
      const config: AiModelConfig = {provider: "openai", model: "gpt-6-astra", apiToken: "fixture"};
      const handle = getModel({} as Cloudflare.Env, config, USER);
      const stream = handle.stream;
      let requests = 0;
      handle.stream = (model, context, options) => stream(model, context, {...options, maxRetries: 0, fetch: async () => {
        ++requests;
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
    ["invalid_image_mode: Could not process image", 200, true],
    ['OpenAI API error (400): {"code":"invalid_image_format","message":"The supplied image could not be parsed."}', 400, true],
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
