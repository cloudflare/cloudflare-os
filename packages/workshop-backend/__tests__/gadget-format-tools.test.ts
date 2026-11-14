// The agent says what a gadget is (its format: a noun and an icon) when creating it, or later
// with setGadgetFormat. Drives the real runAgent against a real OverseerImpl, with pi's faux
// provider standing in for the model.

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
  let stub = env.TEST_OVERSEER.getByName(`gadget-format-tools-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    await fn(impl);
  });
}

// One gadget with no committed code, whose content builds up from the turn's own changes.
function seedWorkspace(impl: any): void {
  impl.storage.gadgets.put({
    type: "gadget", id: 100, title: "Tip Jar", created: new Date(0), bindingName: "TIP_JAR",
    bindings: {},
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

function recordedCalls(impl: any): AiToolCall[] {
  return ([...impl.storage.chats.list()] as AiChatMessage[])
      .flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
}

describe("gadget format tools", () => {
  it("createGadget records the format it is given", () => withImpl(async impl => {
    seedWorkspace(impl);

    await runScriptedTurn(impl, [
      fauxAssistantMessage(fauxToolCall("createGadget", {
        title: "Sales", bindingName: "SALES", format: { noun: "Dashboard", icon: "chartBar" },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let [call] = recordedCalls(impl);
    expect(call.error).toBeUndefined();
    let gadgetId = (call as any).output.gadgetId;
    expect(impl.getGadgetRecord(gadgetId).output).toEqual(
        { id: "dashboard", noun: "Dashboard", plural: "Dashboards", icon: "chartBar" });
  }));

  it("createGadget refuses a format beside a blueprint", () => withImpl(async impl => {
    seedWorkspace(impl);

    await runScriptedTurn(impl, [
      fauxAssistantMessage(fauxToolCall("createGadget", {
        title: "Sales", bindingName: "SALES", blueprintId: "anything",
        format: { noun: "Dashboard", icon: "chartBar" },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    expect(recordedCalls(impl)[0].error).toContain("not both");
  }));

  it("setGadgetFormat sets and clears an existing gadget's format", () => withImpl(async impl => {
    seedWorkspace(impl);

    await runScriptedTurn(impl, [
      fauxAssistantMessage(fauxToolCall("setGadgetFormat", {
        gadget: "TIP_JAR", format: { noun: "Library", plural: "Libraries", icon: "notebook" },
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    expect(impl.getGadgetRecord(100).output).toEqual(
        { id: "library", noun: "Library", plural: "Libraries", icon: "notebook" });
    expect(recordedCalls(impl)[0].workpieceId).toBe(100);

    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(),
      author: OWNER, type: "message", message: "Make it a plain app",
    });
    await runScriptedTurn(impl, [
      fauxAssistantMessage(fauxToolCall("setGadgetFormat", { gadget: "TIP_JAR", format: null }),
          { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    expect(impl.getGadgetRecord(100).output).toBeUndefined();
  }));

  it("setGadgetFormat refuses a name that is not a gadget, and a blank noun", () => withImpl(async impl => {
    seedWorkspace(impl);

    await runScriptedTurn(impl, [
      fauxAssistantMessage([
        fauxToolCall("setGadgetFormat",
            { gadget: "NOPE", format: { noun: "Doc", icon: "fileText" } }),
        fauxToolCall("setGadgetFormat",
            { gadget: "TIP_JAR", format: { noun: "  ", icon: "fileText" } }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    expect(recordedCalls(impl).map(call => call.error)).toEqual([
      expect.stringContaining("no gadget named"),
      expect.stringContaining("needs a noun"),
    ]);
    expect(impl.getGadgetRecord(100).output).toBeUndefined();
  }));
});
