// Retrying a model request that failed transiently: runAgent runs the pass again even when the
// failed request already streamed output, and tells clients to discard that output first. Drives
// the real runAgent against a real OverseerImpl, with pi's faux provider standing in for the model.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
  type AssistantMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";
import { runAgent, type AgentHooks } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The OverseerImpl members this test drives; the class itself is private to overseer.ts.
interface OverseerInternals extends AgentHooks {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void, list(): Iterable<AiChatMessage> };
  };
  nextChatSequence(chatId: number): number;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;

let doCounter = 0;

async function withImpl(fn: (impl: OverseerInternals) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`agent-retry-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: OverseerInternals }).impl);
  });
}

function seedChat(impl: OverseerInternals): void {
  impl.storage.gadgets.put({
    type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
    bindings: {},
  });
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
    author: OWNER, type: "message", message: "Hi",
  });
}

// Runs one agent turn whose model answers each request with the next scripted response,
// returning the stream events sent to clients.
async function runScriptedTurn(
    impl: OverseerInternals,
    steps: AssistantMessage[],
): Promise<{events: AiChatStreamEvent[]; contexts: TranscriptContext[]}> {
  let events: AiChatStreamEvent[] = [];
  let contexts: TranscriptContext[] = [];
  impl.emitChatStreamEvent = (_chatId, event) => events.push(event);
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" });
  return {events, contexts};
}

function streamedText(events: AiChatStreamEvent[]): string {
  return events.flatMap(event => event.type === "textDelta" ? [event.delta] : []).join("");
}

function toolResultImages(context: TranscriptContext) {
  return context.messages.flatMap(message => message.role === "toolResult"
    ? message.content.flatMap(part => part.type === "image" ? [part] : [])
    : []);
}

describe("transient model failures", () => {
  it("retries a request that failed after streaming output, discarding that output first",
      () => withImpl(async impl => {
    seedChat(impl);

    let {events} = await runScriptedTurn(impl, [
      fauxAssistantMessage([fauxThinking("Planning the answer"), fauxText("A partial ans")],
          { stopReason: "error", errorMessage: "503 Service Unavailable" }),
      fauxAssistantMessage(fauxText("The full answer.")),
    ]);

    // The failed attempt's output streamed, then clients were told to drop it before the retry
    // streamed its own.
    let reset = events.findIndex(event => event.type === "streamReset");
    expect(reset).toBeGreaterThan(0);
    expect(events.filter(event => event.type === "streamReset")).toHaveLength(1);
    expect(streamedText(events.slice(0, reset))).toBe("A partial ans");
    expect(streamedText(events.slice(reset + 1))).toBe("The full answer.");

    // Only the retry's answer is persisted, and the turn ended without an error.
    let messages = [...impl.storage.chats.list()].filter(msg => msg.chatId === CHAT_ID);
    expect(messages.filter(msg => msg.type === "error")).toEqual([]);
    expect(messages.flatMap(msg => msg.type === "message" ? [msg.message] : []))
        .toEqual(["Hi", "The full answer."]);
  }));

  it("does not retry a failure that isn't transient", () => withImpl(async impl => {
    seedChat(impl);

    await expect(runScriptedTurn(impl, [
      fauxAssistantMessage(fauxText("A partial ans"),
          { stopReason: "error", errorMessage: "400 Invalid request" }),
      fauxAssistantMessage(fauxText("Never requested.")),
    ])).rejects.toThrow("400 Invalid request");
  }));

  it("replays executeCode images after a transient failure reload", () => withImpl(async impl => {
    seedChat(impl);
    impl.executeCodeMode = async () => ({
      output: "captured screenshot",
      images: [{
        data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        mimeType: "image/png",
      }],
    });

    let {contexts} = await runScriptedTurn(impl, [
      fauxAssistantMessage([
        fauxToolCall("executeCode", {code: "capture()"}),
      ], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Retry me"), {
        stopReason: "error",
        errorMessage: "503 Service Unavailable",
      }),
      fauxAssistantMessage(fauxText("Screenshot received.")),
    ]);

    expect(toolResultImages(contexts[1])).toEqual([{
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    }]);
    expect(toolResultImages(contexts[2])).toEqual(toolResultImages(contexts[1]));
  }));

  it("bounds image bytes across all executeCode calls in one persisted step",
      () => withImpl(async impl => {
    seedChat(impl);
    impl.executeCodeMode = async () => ({
      output: "captured screenshot",
      images: [{
        data: new Uint8Array(7 * 1024 * 1024 / 2),
        mimeType: "image/png",
      }],
    });

    let {contexts} = await runScriptedTurn(impl, [
      fauxAssistantMessage([
        fauxToolCall("executeCode", {code: "captureFirst()"}),
        fauxToolCall("executeCode", {code: "captureSecond()"}),
      ], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let results = contexts[1].messages.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results[0].isError).toBe(false);
    expect(results[0].content.filter(part => part.type === "image")).toHaveLength(1);
    expect(results[1].isError).toBe(true);
    expect(results[1].content).toContainEqual({
      type: "text",
      text: "Image output exceeds 6 MiB for this agent step.",
    });
  }));

  it("elides older executeCode images before the provider request becomes too large",
      () => withImpl(async impl => {
    seedChat(impl);
    let imageIndex = 0;
    let mimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
    let headers = [
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      Uint8Array.of(0xff, 0xd8, 0xff),
      Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
    ];
    impl.executeCodeMode = async () => {
      let data = new Uint8Array(4 * 1024 * 1024 + 1);
      data.set(headers[imageIndex]);
      return {
        output: "captured screenshot",
        images: [{data, mimeType: mimeTypes[imageIndex++]}],
      };
    };

    let {contexts} = await runScriptedTurn(impl, [
      fauxAssistantMessage(fauxToolCall("executeCode", {code: "captureFirst()"}),
          {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxToolCall("executeCode", {code: "captureSecond()"}),
          {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxToolCall("executeCode", {code: "captureThird()"}),
          {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    expect(toolResultImages(contexts[2]).map(image => image.mimeType))
        .toEqual(["image/png", "image/jpeg"]);
    expect(toolResultImages(contexts[3]).map(image => image.mimeType))
        .toEqual(["image/jpeg", "image/webp"]);
    let oldestResult = contexts[3].messages.find(message => message.role === "toolResult");
    expect(oldestResult?.content).toContainEqual({
      type: "text",
      text: "[Earlier image output omitted to keep this model request within its size limit. " +
          "Capture it again with executeCode if needed.]",
    });
  }));

  it("retains only the newest four executeCode images",
      () => withImpl(async impl => {
    seedChat(impl);
    let imageIndex = 0;
    impl.executeCodeMode = async () => ({
      output: "captured screenshot",
      images: [{
        data: Uint8Array.of(++imageIndex),
        mimeType: "image/png" as const,
      }],
    });

    let toolSteps = Array.from({length: 5}, (_, index) =>
      fauxAssistantMessage(fauxToolCall("executeCode", {code: `capture${index}()`}),
          {stopReason: "toolUse"}));
    let {contexts} = await runScriptedTurn(impl, [
      ...toolSteps,
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    expect(toolResultImages(contexts[4]).map(image => image.data))
        .toEqual(["AQ==", "Ag==", "Aw==", "BA=="]);
    expect(toolResultImages(contexts[5]).map(image => image.data))
        .toEqual(["Ag==", "Aw==", "BA==", "BQ=="]);
    let oldestResult = contexts[5].messages.find(message => message.role === "toolResult");
    expect(oldestResult?.content).toContainEqual({
      type: "text",
      text: "[Earlier image output omitted to keep this model request within its size limit. " +
          "Capture it again with executeCode if needed.]",
    });
  }));

  it("includes chat attachments in the request media budget",
      () => withImpl(async impl => {
    seedChat(impl);
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(1),
      author: OWNER, type: "message", message: "Use this reference image.",
      attachments: [{
        id: "reference-image", mimeType: "image/png", size: 9 * 1024 * 1024,
      }],
    });
    // Budget from canonical metadata; the backing bytes can stay tiny in this focused test.
    impl.getChatAttachmentData = async () => Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
    impl.executeCodeMode = async () => ({
      output: "captured screenshot",
      images: [{
        data: new Uint8Array(4 * 1024 * 1024),
        mimeType: "image/png",
      }],
    });

    let {contexts} = await runScriptedTurn(impl, [
      fauxAssistantMessage(fauxToolCall("executeCode", {code: "capture()"}),
          {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let result = contexts[1].messages.find(message => message.role === "toolResult");
    expect(result?.isError).toBe(true);
    expect(result?.content).toContainEqual({
      type: "text",
      text: "Image output cannot fit in this model request alongside the chat's attachments. " +
          "Start a new chat without those attachments and try again.",
    });
    expect(toolResultImages(contexts[1])).toEqual([]);
  }));
});
