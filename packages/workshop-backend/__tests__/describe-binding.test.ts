// The describeBinding tool: describing a binding in the agent's own env or, via `gadget`, in a
// gadget's own env, recording what the binding resolved to so replay describes the same target
// even after the binding changes. Drives the real runAgent against a real OverseerImpl, with pi's
// faux provider standing in for the model.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt,
  type Context, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { runAgent } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;

let doCounter = 0;

async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`describe-binding-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    // Gatekeeper descriptions come from the gatekeeper's facet; name the target instead.
    impl.describeGatekeeper = async (name: string, gatekeeper: { id: number }) =>
        `${name} is gatekeeper ${gatekeeper.id}`;
    await fn(impl);
  });
}

// Two gadgets whose bindings share the name DB, so the chat's default env holds only APP's
// (the lower gadget id wins): OTHER's DB has no counterpart in the agent's env.
function seedWorkspace(impl: any): void {
  impl.storage.gatekeepers.put({ id: 5, resourceTitle: "App DB", class: {} as any });
  impl.storage.gatekeepers.put({ id: 6, resourceTitle: "Other DB", class: {} as any });
  impl.storage.gadgets.put({
    type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
    bindings: { DB: { target: 5 } },
  });
  impl.storage.gadgets.put({
    type: "gadget", id: 101, title: "Other", created: new Date(0), bindingName: "OTHER",
    bindings: { DB: { target: 6 } },
  });
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
    author: OWNER, type: "message", message: "Hi",
  });
}

// Runs one agent turn whose model answers each step with the next scripted response, returning
// the context the model saw at each step.
async function runScriptedTurn(
    impl: any, steps: ReturnType<typeof fauxAssistantMessage>[]): Promise<Context[]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let contexts: Context[] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    // pi carries the prompt in the transcript's system messages; replay them into one string.
    contexts.push({
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages),
    });
    return step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return contexts;
}

function describeCalls(impl: any): Extract<AiToolCall, { toolName: "describeBinding" }>[] {
  return ([...impl.storage.chats.list()] as AiChatMessage[])
      .flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : [])
      .filter(call => call.toolName === "describeBinding");
}

// The text of each tool result the model was shown, in order.
function toolResultTexts(context: Context): string[] {
  return context.messages.flatMap(message => message.role === "toolResult"
      ? [message.content.map(part => part.type === "text" ? part.text : "").join("")]
      : []);
}

const CALLS = [
  { name: "DB" },
  { gadget: "OTHER", name: "DB" },
  { gadget: "OTHER", name: "GIT" },
  { gadget: "OTHER", name: "GADGET" },
  { gadget: "OTHER", name: "MISSING" },
  { gadget: "NOPE", name: "DB" },
];

// Appends a user message, so another turn can be run.
function addUserMessage(impl: any, message: string): void {
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID),
    // Workers clocks don't advance without I/O, and timestamps are indexed uniquely per chat.
    timestamp: new Date(Date.now() + 60_000),
    author: OWNER, type: "message", message,
  });
}

// Runs a turn making every call in CALLS, returning the context of its final step.
async function runDescribeTurn(impl: any): Promise<Context> {
  let contexts = await runScriptedTurn(impl, [
    fauxAssistantMessage(CALLS.map(input => fauxToolCall("describeBinding", input)),
        { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Done.")),
  ]);
  return contexts[1];
}

describe("describeBinding", () => {
  it("describes bindings in a gadget's env and records the descriptions",
      () => withImpl(async impl => {
    seedWorkspace(impl);

    let context = await runDescribeTurn(impl);

    // The system prompt points the agent at the tool for the binding it can't reach by name.
    expect(context.systemPrompt).toContain(
        `* DB: Other DB — (no binding for this in your env; describeBinding with ` +
        `\`gadget: "OTHER"\` describes it)`);
    expect(context.systemPrompt).toContain("* DB: App DB — in your env as `env.DB`");

    let texts = toolResultTexts(context);
    expect(texts[0]).toBe("env.DB is gatekeeper 5");
    expect(texts[1]).toBe("env.DB (in gadget OTHER's env) is gatekeeper 6");
    expect(texts[2]).toContain("Binding: env.GIT (in gadget OTHER's env)");
    expect(texts[3]).toContain("Binding: env.GADGET (in gadget OTHER's env)");
    expect(texts[3]).toContain(`the Gadget "Other"`);

    let calls = describeCalls(impl);
    expect(calls.map(call => call.output)).toEqual([...texts.slice(0, 4), undefined, undefined]);
    expect(calls[4].error).toMatch(/Gadget OTHER has no binding named "MISSING"/);
    expect(calls[5].error).toMatch(/There is no gadget named "NOPE" in your env/);
  }));

  it("replays recorded descriptions without describing again", () => withImpl(async impl => {
    seedWorkspace(impl);
    let live = await runDescribeTurn(impl);

    // Rebind OTHER's DB, and make describing any gatekeeper fail: replay must return exactly
    // what was recorded.
    impl.storage.gatekeepers.put({ id: 7, resourceTitle: "New DB", class: {} as any });
    impl.storage.gadgets.put({
      type: "gadget", id: 101, title: "Other", created: new Date(0), bindingName: "OTHER",
      bindings: { DB: { target: 7 } },
    });
    impl.describeGatekeeper = async () => { throw new Error("replay described a gatekeeper"); };
    addUserMessage(impl, "Again");

    let replayed = await runScriptedTurn(impl, [fauxAssistantMessage(fauxText("Done."))]);

    expect(toolResultTexts(replayed[0])).toEqual(toolResultTexts(live));
  }));

  it("elides descriptions from logs that predate recording them", () => withImpl(async impl => {
    seedWorkspace(impl);
    await runDescribeTurn(impl);

    // Strip the recorded descriptions, as in a log persisted before they were recorded.
    for (let msg of [...impl.storage.chats.list()] as AiChatMessage[]) {
      if (msg.type !== "message" || !msg.toolCalls) continue;
      for (let call of msg.toolCalls) {
        if (call.toolName === "describeBinding") delete call.output;
      }
      impl.storage.chats.put(msg);
    }
    addUserMessage(impl, "Again");

    let replayed = await runScriptedTurn(impl, [fauxAssistantMessage(fauxText("Done."))]);

    let texts = toolResultTexts(replayed[0]);
    for (let text of texts.slice(0, 4)) {
      expect(text).toMatch(/no longer available\. Call describeBinding again/);
    }
    // Failed calls replay their recorded errors as before.
    expect(texts[4]).toMatch(/Gadget OTHER has no binding named "MISSING"/);
  }));
});
