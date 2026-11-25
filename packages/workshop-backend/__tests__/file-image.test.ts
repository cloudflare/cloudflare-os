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

function recordReads(impl: Impl, chatId: number, oid: string, count: number, byteLength = PNG.length) {
  impl.addChatMessages(chatId, AUTHOR, [{type: "message", message: "", toolCalls: Array.from({length: count}, () => ({
    toolName: "readFile", toolCallId: crypto.randomUUID(),
    input: {workpiece: "IMAGES", filename: "image.png"}, image: {oid, byteLength},
  }))}]);
}

describe("images read from a worktree", () => {
  it("keeps a turn's gadget snapshot across an image reload and rejects stale edits", () => inKernel(crypto.randomUUID(), async impl => {
    const commitId = await impl.gitCache.writeFilesAsCommit(new Map([
      ["client.js", "client-v1"], ["server.js", "server-v1"],
    ]), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Initial", timestamp: new Date(0)});
    const gadget = impl.createGadget("App", "APP", undefined, undefined, commitId);
    const {chatId} = await setup(impl);
    const next = await impl.gitCache.writeFilesAsCommit(new Map([
      ["client.js", "client-v2"], ["server.js", "server-v2"],
    ]), {parents: [commitId], author: {name: "Test", email: "test@example.com"}, message: "Concurrent accept", timestamp: new Date(1)});
    const commit = impl.commitAgentStep.bind(impl);
    const barrier = vi.spyOn(impl, "commitAgentStep").mockImplementationOnce(async (...args) => {
      const result = await commit(...args);
      impl.storage.gadgets.put({...gadget, commitId: next});
      return result;
    });
    try {
      const {requests} = await turn(impl, chatId, [
        [fauxToolCall("readFile", {workpiece: "APP", filename: "client.js"}), read()],
        [fauxToolCall("readFile", {workpiece: "APP", filename: "server.js"})],
        [fauxToolCall("editFile", {workpiece: "APP", filename: "server.js", textToReplace: "server-v1", replacement: "edited"})],
      ]);
      const reads = results(requests.at(-1)!).flatMap(result => result.content);
      expect(reads).toContainEqual({type: "text", text: expect.stringContaining("server-v1")});
      expect(reads).not.toContainEqual({type: "text", text: expect.stringContaining("server-v2")});
      const calls = impl.loadChatHistory(chatId).chatMessages.flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
      expect(calls.find(call => call.toolName === "editFile")?.error).toContain("changed since you read it");
      expect(impl.getGadgetHead(gadget.id)).toBe(next);
    } finally { barrier.mockRestore(); }
  }));

  it("shows pixels immediately and replays the immutable blob after file removal and eviction", async () => {
    const name = crypto.randomUUID();
    let chatId: number;
    await inKernel(name, async impl => {
      ({chatId} = await setup(impl));
      const encode = vi.spyOn(Uint8Array.prototype, "toBase64");
      const {requests} = await turn(impl, chatId, [[read()]]);
      const encodings = encode.mock.instances.filter(bytes => bytes.length === PNG.length).length;
      encode.mockRestore();
      expect(encodings).toBe(1);
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

  it.each(["late-steer", "prompt", "steer-after-tool"])("keeps an unanswered instruction on Retry before any image read: %s", trigger => inKernel(crypto.randomUUID(), async impl => {
    const text = new TextEncoder().encode("Before edit");
    const {chatId} = await setup(impl, PNG, [["note.txt", text]]);
    const steered = trigger !== "prompt";
    if (trigger === "steer-after-tool") {
      impl.addChatMessages(chatId, AUTHOR, [{type: "message", message: "", toolCalls: [{
        toolName: "readFile", toolCallId: crypto.randomUUID(),
        input: {workpiece: "IMAGES", filename: "note.txt"}, observedOid: impl.gitCache.writeBlob(text).oid,
      }]}]);
    } else await turn(impl, chatId, []);
    const creation = impl.loadChatHistory(chatId).chatMessages.flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : [])
      .find(call => call.toolName === "createWorktree");
    if (creation?.toolName !== "createWorktree" || creation.output?.worktreeId === undefined) throw new Error("Expected worktree");
    impl.addChatMessages(chatId, USER, [
      {type: "message", message: "Still-unanswered instruction", steered},
      {type: "changes", change: {[creation.output.worktreeId]: [["note.txt", {set: "Manual edit"}]]}},
      {type: "agentNudge", text: steered ? undefined : "The previous turn was interrupted repeatedly. Retry."},
    ]);
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, totalTokens: 8_000_000});
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage(fauxText("Summary")), fauxAssistantMessage(fauxText("Done")),
    ]);
    expect(requests.at(-1)).toContainEqual({role: "user", content: "Still-unanswered instruction", timestamp: expect.any(Number)});
    expect(results(requests.at(-1)!).flatMap(result => result.content.filter(part => part.type === "image"))).toEqual([]);
  }));

  it.each(["chat", "callback", "steer"])("keeps the active %s prompt verbatim when file images exceed the media limit", trigger => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    if (trigger !== "chat") {
      await turn(impl, chatId, []);
      if (trigger === "callback") {
        impl.addChatMessages(chatId, AUTHOR, [{type: "agentCallback", methodName: "inspect", argsSummary: "callback-argument-note", bindingName: "INSPECT_ARGS"}]);
      } else {
        impl.addChatMessages(chatId, USER, [{type: "message", message: "Still-active steer", steered: true}]);
      }
    }
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage(Array.from({length: 20}, () => read()), {stopReason: "toolUse"}),
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done")), fauxAssistantMessage(fauxText("Done")),
    ]);
    const last = requests.at(-1)!;
    expect(last).toContainEqual({role: "user", content: trigger === "callback" ? expect.stringContaining("callback-argument-note")
      : trigger === "steer" ? "Still-active steer" : "Read the image", timestamp: expect.any(Number)});
    expect(last.flatMap(msg => Array.isArray(msg.content) ? msg.content.filter(part => part.type === "image") : [])).toHaveLength(1);
  }));

  it.each(["direct", "approval", "callback"])("reserves only the current turn's reference slots: %s", trigger => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId,
      "Compare these references", {attachments: Array.from({length: 5}, (_, index) =>
        ({oid: blob.oid, mimeType: "image/png", name: `${index}.png`}))});
    if (trigger === "approval") impl.addChatMessages(chatId, USER, [{type: "agentNudge", text: "The user approved the pending action; continue."}]);
    if (trigger === "callback") {
      recordReads(impl, chatId, blob.oid, 1); // The preceding turn stopped after an image step.
      impl.addChatMessages(chatId, AUTHOR, ["first-callback-note", "second-callback-note"].map(argsSummary =>
        ({type: "agentCallback", methodName: "inspect", argsSummary, bindingName: "INSPECT_ARGS"})));
    }
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage(Array.from({length: 16}, () => read()), {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done")), fauxAssistantMessage(fauxText("Done")),
    ]);
    const last = requests.at(-1)!;
    const currentReads = results(last).slice(-16);
    expect(currentReads.filter(result => !result.isError)).toHaveLength(trigger === "callback" ? 16 : 15);
    expect(currentReads.filter(result => result.isError)).toHaveLength(trigger === "callback" ? 0 : 1);
    expect(last.flatMap(msg => Array.isArray(msg.content) ? msg.content.filter(part => part.type === "image") : [])).toHaveLength(trigger === "callback" ? 17 : 20); // The previous read still fits in replay.
    if (trigger === "callback") for (const note of ["first-callback-note", "second-callback-note"]) {
      expect(last.some(msg => msg.role === "user" && typeof msg.content === "string" && msg.content.includes(note))).toBe(true);
    }
  }));

  it("compacts a stopped callback turn while keeping the next callback batch", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    impl.addChatMessages(chatId, AUTHOR, [{type: "agentCallback", methodName: "inspect", argsSummary: "old-callback", bindingName: "OLD_ARGS"}]);
    recordReads(impl, chatId, blob.oid, 20);
    const oldReadSequence = impl.loadChatHistory(chatId).chatMessages.at(-1)!.sequence;
    impl.addChatMessages(chatId, AUTHOR, ["first-new-callback", "second-new-callback"].map(argsSummary =>
      ({type: "agentCallback", methodName: "inspect", argsSummary, bindingName: "NEW_ARGS"})));
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Summary")), fauxAssistantMessage(fauxText("Done")),
    ]);
    expect(impl.loadChatHistory(chatId).checkpoint?.compactedTo).toBeGreaterThan(oldReadSequence);
    const last = requests.at(-1)!;
    expect(results(last).flatMap(result => result.content.filter(part => part.type === "image"))).toHaveLength(1);
    for (const note of ["first-new-callback", "second-new-callback"]) {
      expect(last.some(msg => msg.role === "user" && typeof msg.content === "string" && msg.content.includes(note))).toBe(true);
    }
  }));

  it("keeps the original prompt and reference uploads through an approval handoff", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId,
      "Compare these references", {attachments: Array.from({length: 5}, (_, index) =>
        ({oid: blob.oid, mimeType: "image/png", name: `${index}.png`}))});
    impl.addChatMessages(chatId, USER, [{type: "agentNudge", text: "The user approved the pending action; continue."}]);
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage(Array.from({length: 10}, () => read()), {stopReason: "toolUse"}),
      fauxAssistantMessage(Array.from({length: 6}, () => read()), {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done")), fauxAssistantMessage(fauxText("Done")),
    ]);
    const last = requests.at(-1)!;
    const prompt = last.find(msg => msg.role === "user" && Array.isArray(msg.content) &&
      msg.content.some(part => part.type === "text" && part.text === "Compare these references"));
    expect(prompt?.content).toHaveLength(11); // Original text plus five image/label pairs.
    expect(results(last).flatMap(msg => msg.content.filter(part => part.type === "image"))).toHaveLength(6);
  }));

  it.each(["reload", "restart"])("keeps active reference uploads ahead of older tool images after %s", mode => inKernel(crypto.randomUUID(), async impl => {
    const screenshot = new Uint8Array(6 * 1024 * 1024); screenshot.set(PNG);
    const reference = new Uint8Array(4.5 * 1024 * 1024); reference.set(PNG);
    const {chatId, blob: screenshotBlob} = await setup(impl, screenshot);
    const blob = impl.gitCache.writeBlob(reference);
    await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId,
      "Compare against these references", {attachments: ["first.png", "second.png"].map(name =>
        ({oid: blob.oid, mimeType: "image/png", name}))});
    if (mode === "restart") {
      // A fresh runAgent must recover the unfinished turn from its durable tool steps alone.
      recordReads(impl, chatId, screenshotBlob.oid, 1, screenshot.length);
      recordReads(impl, chatId, screenshotBlob.oid, 1, screenshot.length);
    }
    const {requests} = await scriptedTurn(impl, chatId, [
      ...(mode === "reload" ? [fauxAssistantMessage([read()], {stopReason: "toolUse"}), fauxAssistantMessage([read()], {stopReason: "toolUse"})] : []),
      fauxAssistantMessage(fauxText("Done")), fauxAssistantMessage(fauxText("Done")),
    ]);
    const last = requests.at(-1)!;
    const images = last.flatMap(msg => Array.isArray(msg.content) ? msg.content.filter(part => part.type === "image") : []);
    expect(images.map(image => Uint8Array.fromBase64(image.data).length)).toEqual([reference.length, reference.length, screenshot.length]);
    expect(results(last)[0].content.every(part => part.type === "text")).toBe(true);
    expect(results(last)[1].content.some(part => part.type === "image")).toBe(true);
  }));

  it("encodes only the retained image tail of a long unfinished turn", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    for (let step = 0; step < 6; ++step) recordReads(impl, chatId, blob.oid, 20);
    const encode = vi.spyOn(Uint8Array.prototype, "toBase64");
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage(fauxText("Summary")), fauxAssistantMessage(fauxText("Done")),
    ]);
    const encodings = encode.mock.instances.filter(bytes => bytes.length === PNG.length).length;
    encode.mockRestore();
    expect(results(requests.at(-1)!).flatMap(result => result.content.filter(part => part.type === "image"))).toHaveLength(20);
    expect(encodings).toBe(20);
  }));

  it("lets explicit compaction summarize a stopped image turn", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    recordReads(impl, chatId, blob.oid, 1);
    const firstRead = impl.loadChatHistory(chatId).chatMessages.at(-1)!.sequence;
    recordReads(impl, chatId, blob.oid, 1);
    impl.addChatMessages(chatId, USER, [{type: "slashCommand",
      request: {id: {builtin: true, commandId: "compact"}, args: ""}}]);
    await scriptedTurn(impl, chatId, [fauxAssistantMessage(fauxText("Summarized the image observations."))]);
    expect(impl.loadChatHistory(chatId).checkpoint?.compactedTo).toBeGreaterThan(firstRead);
  }));

  it.each([false, true])("loads pixels only for an eligible native-compaction prefix (over limit: %s)", overLimit => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    recordReads(impl, chatId, blob.oid, overLimit ? 20 : 1);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "More images"}]);
    recordReads(impl, chatId, blob.oid, 5);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Finish"}]);
    // A long retained reply puts the native cut after both image batches.
    impl.addChatMessages(chatId, AUTHOR, [{type: "message", message: "Done ".repeat(20_000)}]);
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(chatId)!, totalTokens: 40_000});
    impl.addChatMessages(chatId, USER, [{type: "slashCommand",
      request: {id: {builtin: true, commandId: "compact"}, args: ""}}]);
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([fauxAssistantMessage(fauxText("Summarized the image observations."))]);
    const requests: Message[][] = [];
    const encode = vi.spyOn(Uint8Array.prototype, "toBase64");
    const run = runAgent(impl, {model: getModel({} as Cloudflare.Env,
      {provider: "anthropic", model: "claude-sonnet-5-5", apiToken: "fixture"}, USER).model,
      stream: (_model, context, options) => {
        requests.push(structuredClone(context.messages));
        return faux.stream(faux.getModel(), context, options);
      }}, chatId, AUTHOR, new AbortController().signal, USER,
      {provider: "anthropic", model: "claude-sonnet-5-5", apiToken: "fixture"});
    if (overLimit) await run;
    else await expect(run).rejects.toThrow("Compaction produced no summary"); // Faux returns no native block.
    const encodings = encode.mock.instances.filter(bytes => bytes.length === PNG.length).length;
    encode.mockRestore();
    expect(requests).toHaveLength(1);
    const images = requests[0].flatMap(msg => Array.isArray(msg.content)
      ? msg.content.filter(part => part.type === "image") : []);
    expect(images).toHaveLength(overLimit ? 0 : 6);
    expect(encodings).toBe(overLimit ? 0 : 6);
    for (const image of images) expect(image.data).toBe(PNG.toBase64());
    if (overLimit) {
      expect(impl.loadChatHistory(chatId).checkpoint).toMatchObject({summary: "Summarized the image observations."});
      expect(impl.loadChatHistory(chatId).checkpoint?.anthropicCompactionBlock).toBeUndefined();
    }
  }));

  it("does not refuse file images that admission omitted from the failing request", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    recordReads(impl, chatId, blob.oid, 20);
    await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId,
      "New upload", {attachments: [{oid: blob.oid, mimeType: "image/png", name: "new.png"}]});
    await expect(scriptedTurn(impl, chatId, [fauxAssistantMessage(fauxText("")),
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 Invalid image"}),
    ])).rejects.toThrow("400 Invalid image");
    const reads = impl.loadChatHistory(chatId).chatMessages.flatMap(msg =>
      msg.type === "message" ? msg.toolCalls ?? [] : []).filter(call => call.toolName === "readFile");
    expect(reads).toHaveLength(20);
    expect(reads.every(call => !call.image?.rejected)).toBe(true);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0]).flatMap(msg => msg.content.filter(part => part.type === "image"))).toHaveLength(20);
  }));

  it("keeps an accepted reference upload when the provider refuses a subsequent file image", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId,
      "Compare this reference", {attachments: [{oid: blob.oid, mimeType: "image/png", name: "reference.png"}]});
    await expect(scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 Invalid image"}),
    ])).rejects.toThrow("400 Invalid image");
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(requests[0].flatMap(msg => msg.role === "user" && Array.isArray(msg.content)
      ? msg.content.filter(part => part.type === "image") : [])).toHaveLength(1);
    expect(results(requests[0])[0].content.every(part => part.type === "text")).toBe(true);
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

  it.each(["400 Invalid image", "Error Code image_parse_error: Could not process image", "invalid_image_data", "Images are unsupported"])(
    "surfaces a permanent failure without repeating effects and leaves the chat usable: %s", failure => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await expect(scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read(), fauxToolCall("writeFile", {workpiece: "IMAGES", filename: "note.txt", content: "Saved"})], {stopReason: "toolUse"}),
      fauxAssistantMessage([], {stopReason: "error", errorMessage: failure}),
    ])).rejects.toThrow(failure);
    const calls = impl.loadChatHistory(chatId).chatMessages.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    expect(calls.filter(call => call.toolName === "writeFile")).toHaveLength(1);
    expect(calls.find(call => call.toolName === "readFile")).toHaveProperty("image.rejected", true);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0])[0].content.every(part => part.type === "text")).toBe(true);
  }));

  it.each(["400 You have reached your specified API usage limits", "401 Unauthorized", "402 Billing required", "403 Forbidden", "404 Unknown model", "Policy refused this request"])(
    "keeps valid pixels available after a non-image failure: %s", failure => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await expect(scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage([], {stopReason: "error", errorMessage: failure}),
    ])).rejects.toThrow(failure);
    const calls = impl.loadChatHistory(chatId).chatMessages.flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
    expect(calls.find(call => call.toolName === "readFile")).not.toHaveProperty("image.rejected");
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Credentials repaired; retry"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0])[0].content).toContainEqual({type: "image", data: PNG.toBase64(), mimeType: "image/png"});
  }));

  it("recovers from historical image rejection after a model switch and drops dependent thinking", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await scriptedTurn(impl, chatId, [fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage([fauxThinking("I saw the original pixels."), fauxText("Seen")])]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Unrelated follow-up on another model"}]);
    const config = {provider: "openai" as const, model: "gpt-6-astra", apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const stream = handle.stream;
    handle.stream = (model, context, options) => stream(model, context, {...options, maxRetries: 0,
      fetch: async () => new Response(JSON.stringify({error: {message: "Image exceeds patch limit", type: "invalid_request_error"}}),
        {status: 400, headers: {"content-type": "application/json"}}),
    });
    await expect(runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config)).rejects.toThrow("Image exceeds patch limit");
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Retry"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0])[0].content.every(part => part.type === "text")).toBe(true);
    expect(requests[0].flatMap(msg => msg.role === "assistant" ? msg.content.filter(part => part.type === "thinking") : [])).toEqual([]);
  }));

  it("preserves saved pixels when an HTTP 200 stream reports invalid credentials", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    await turn(impl, chatId, [[read()]]);
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Continue"}]);
    const config = {provider: "openai" as const, model: "gpt-6-astra", apiToken: "fixture"};
    const handle = getModel({} as Cloudflare.Env, config, USER);
    const stream = handle.stream;
    handle.stream = (model, context, options) => stream(model, context, {...options, maxRetries: 0,
      fetch: async () => new Response('event: error\ndata: {"type":"error","code":"invalid_api_key","message":"Invalid API key provided","param":null,"sequence_number":0}\n\n',
        {headers: {"content-type": "text/event-stream"}}),
    });
    await expect(runAgent(impl, handle, chatId, AUTHOR, new AbortController().signal, USER, config)).rejects.toThrow("Invalid API key provided");
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Credentials repaired; retry"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(results(requests[0])[0].content).toContainEqual({type: "image", data: PNG.toBase64(), mimeType: "image/png"});
  }));

  it("names both uploads and saved images when both are refused", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId, blob} = await setup(impl);
    await turn(impl, chatId, [[read()]]);
    await impl.sendChatMessage(env.TEST_USER.getByName(crypto.randomUUID()), {profile: USER}, chatId,
      "Uploaded", {attachments: [{oid: blob.oid, mimeType: "image/png", name: "upload.png"}]});
    await expect(scriptedTurn(impl, chatId, [
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "400 Invalid image"}),
    ])).rejects.toThrow("Retrying sends this message's images and PDFs as workspace files instead. Saved file images are omitted too.");
    impl.addChatMessages(chatId, USER, [{type: "message", message: "Retry"}]);
    const {requests} = await turn(impl, chatId, []);
    expect(requests[0].flatMap(msg => Array.isArray(msg.content) ? msg.content.filter(part => part.type === "image") : [])).toEqual([]);
  }));

  it("retains unread pixels across transient provider retries", () => inKernel(crypto.randomUUID(), async impl => {
    const {chatId} = await setup(impl);
    const {requests} = await scriptedTurn(impl, chatId, [
      fauxAssistantMessage([read()], {stopReason: "toolUse"}),
      fauxAssistantMessage([], {stopReason: "error", errorMessage: "503 Unavailable"}),
      fauxAssistantMessage(fauxText("Recovered")),
    ]);
    expect(results(requests.at(-1)!)[0].content.some(part => part.type === "image")).toBe(true);
    const calls = impl.loadChatHistory(chatId).chatMessages.flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
    expect(calls.find(call => call.toolName === "readFile")).not.toHaveProperty("image.rejected");
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
