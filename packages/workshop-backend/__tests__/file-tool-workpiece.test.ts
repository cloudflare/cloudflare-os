// The file tools record the workpiece their binding name resolved to (AiToolCall.workpieceId), so
// the UI can say which gadget a step touched without knowing the chat's bindings. Drives the real
// runAgent against a real OverseerImpl, with pi's faux provider standing in for the model.

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
  let stub = env.TEST_OVERSEER.getByName(`file-tool-workpiece-${++doCounter}`);
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

describe("file tool calls", () => {
  it("record the workpiece they touched, and a failed call records none", () => withImpl(async impl => {
    seedWorkspace(impl);

    await runScriptedTurn(impl, [
      fauxAssistantMessage([
        fauxToolCall("writeFile", { workpiece: "TIP_JAR", filename: "client.js", content: "a\n" }),
        fauxToolCall("readFile", { workpiece: "TIP_JAR", filename: "client.js" }),
        fauxToolCall("editFile",
            { workpiece: "TIP_JAR", filename: "client.js", textToReplace: "a", replacement: "b" }),
        fauxToolCall("grep", { workpiece: "TIP_JAR", pattern: "b" }),
        fauxToolCall("writeFile", { workpiece: "NOPE", filename: "x.js", content: "" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let calls = recordedCalls(impl);
    expect(calls.map(call => [call.toolName, call.workpieceId, call.error === undefined]))
        .toEqual([
          ["writeFile", 100, true],
          ["readFile", 100, true],
          ["editFile", 100, true],
          ["grep", 100, true],
          ["writeFile", undefined, false],
        ]);
  }));
});
