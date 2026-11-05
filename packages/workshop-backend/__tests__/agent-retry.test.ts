// How runAgent ends a turn. It retries a model request that failed transiently, running the pass
// again even when the failed request already streamed output, and tells clients to discard that
// output first. And it leaves the turn's last request to keep cached only when the chat's next
// request will start with it. Drives the real runAgent against a real OverseerImpl, with pi's faux
// provider standing in for the model.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";
import { runAgent, type AgentHooks } from "../src/agent";
import type { CachedRequest, ModelHandle } from "../src/ai-models.js";

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
    impl: OverseerInternals, steps: AssistantMessage[]): Promise<AiChatStreamEvent[]> {
  let events: AiChatStreamEvent[] = [];
  impl.emitChatStreamEvent = (_chatId, event) => events.push(event);
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  faux.setResponses(steps);
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" });
  return events;
}

function streamedText(events: AiChatStreamEvent[]): string {
  return events.flatMap(event => event.type === "textDelta" ? [event.delta] : []).join("");
}

describe("transient model failures", () => {
  it("retries a request that failed after streaming output, discarding that output first",
      () => withImpl(async impl => {
    seedChat(impl);

    let events = await runScriptedTurn(impl, [
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
});

describe("the request a turn leaves to keep cached", () => {
  // Runs one turn whose model answers each request with the next of `steps`, with a compaction
  // trigger at 85% of `compactionInputBudget`. Returns what runAgent left to keep cached and every
  // request the handle could have resent.
  async function runTurn(
      impl: OverseerInternals, steps: AssistantMessage[], compactionInputBudget: number) {
    let faux = createFauxCore({ models: [{ id: "faux-model" }] });
    faux.setResponses(steps);
    let requests: CachedRequest[] = [];
    let handle: ModelHandle = {
      model: faux.getModel(),
      stream: (model, context, options) => {
        handle.lastRequest = {
          sentAt: Date.now(), cacheLifetime: 5 * 60_000, resendCost: 0, expiryCost: 0,
          resend: () => Promise.reject(new Error("Not resent in this test.")),
        };
        requests.push(handle.lastRequest);
        return faux.stream(model, context, options);
      },
    };
    let kept = await runAgent(impl, handle, CHAT_ID,
        { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
        { provider: "cloudflare", model: "faux-model", apiToken: "", compactionInputBudget });
    return { kept, requests };
  }

  it("leaves the last request when the next one fits", () => withImpl(async impl => {
    seedChat(impl);
    let { kept, requests } = await runTurn(
        impl, [fauxAssistantMessage(fauxText("A short answer."))], 200_000);
    expect(requests).toHaveLength(1);
    expect(kept).toBe(requests[0]);
  }));

  // A turn that ends to wait for the user's decision leaves its tool results for the next
  // request, which compacts first if they don't fit. The model calls a tool that doesn't exist,
  // whose error result repeats the tool's name: with a 50k-token name, the call fits under the
  // trigger at 95k tokens, and the call with its result passes it.
  it.each([
    { name: "fits", tool: "lookUp", fits: true },
    { name: "would compact", tool: "x".repeat(200_000), fits: false },
  ])("leaves the last request of a turn awaiting a decision only if the next one $name",
      ({ tool, fits }) => withImpl(async impl => {
    seedChat(impl);
    impl.consumeCapturedActions =
        () => ({ actions: [], accessedGadget: false, awaitDecision: true });
    let { kept, requests } = await runTurn(
        impl, [fauxAssistantMessage(fauxToolCall(tool, {}))], 112_000);
    expect(requests).toHaveLength(1);
    expect(kept).toBe(fits ? requests[0] : undefined);
  }));
});
