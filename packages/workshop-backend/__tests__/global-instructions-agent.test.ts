import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { OverseerDurableObject } from "../src/overseer";
import { runAgent } from "../src/agent";
import type { PersonalInstructions } from "../src/global-instructions";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const USER = {type: "user" as const, id: "test-user", name: "Test"};
const AUTHOR = {type: "agent" as const, id: "faux-model", name: "Faux"};

async function turn(impl: Impl, chatId: number, personal?: PersonalInstructions,
                    compact: boolean = false) {
  const faux = createFauxCore({models: [{id: "faux-model"}]});
  // A second model request within one turn must keep the same personal snapshot.
  faux.setResponses(compact ? [fauxAssistantMessage(fauxText("Task handoff."))] : [
    fauxAssistantMessage(fauxToolCall("listBlueprints", {}), {stopReason: "toolUse"}),
    fauxAssistantMessage(fauxText("Done.")),
  ]);
  const prompts: {static: string; environment: string}[] = [];
  await runAgent(impl, {
    model: faux.getModel(),
    stream: (model, context, options) => {
      const system = context.messages.find(message => message.role === "system");
      if (compact) {
        prompts.push({static: context.systemPrompt ?? "", environment: JSON.stringify(context)});
      } else {
        if (!system || system.role !== "system") throw new Error("Missing system prompt");
        prompts.push({static: system.content, environment: getSystemMessageText(system)});
      }
      return faux.stream(model, context, options);
    },
  }, chatId, AUTHOR, new AbortController().signal, USER,
  {provider: "cloudflare", model: "faux-model", apiToken: ""}, personal);
  return prompts;
}

describe("transient personal agent context", () => {
  it("refreshes defaults in existing/new chats without persisting them in workspace history", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl;
      impl.getInstanceInstructions = async () => "Deployment policy wins.";
      impl.describeStandardFormats = async () => [];
      impl.listConnectableVendors = async () => [];
      const seed = (id: number) => {
        const timestamp = impl.getChatTimestamp();
        impl.storage.chatMeta.put({id, title: "Test", started: timestamp, lastActive: timestamp});
        impl.addChatMessages(id, USER, [{type: "message", message: "Help with a task."}]);
      };
      seed(1);
      const personal = {instructions: "private-sentinel-alice", cacheSalt: "private-alice-salt"};
      const first = await turn(impl, 1, personal);
      expect(first).toHaveLength(2);
      for (const prompt of first) {
        expect(prompt.static).not.toContain(personal.instructions);
        expect(prompt.static).not.toContain(personal.cacheSalt);
        expect(prompt.static).toContain("Deployment policy wins.");
        expect(prompt.environment).toContain(personal.instructions);
        expect(prompt.environment.indexOf("Prompt cache salt (ignore):"))
            .toBeLessThan(prompt.environment.indexOf(personal.cacheSalt));
      }
      impl.addChatMessages(1, USER, [{type: "message", message: "Continue."}]);
      const bob = {instructions: "private-sentinel-bob", cacheSalt: "private-bob-salt"};
      const second = await turn(impl, 1, bob);
      expect(second[0]?.environment).toContain(bob.instructions);
      expect(second[0]?.environment).not.toContain(personal.instructions);
      seed(2);
      expect((await turn(impl, 2, bob))[0]?.environment).toContain(bob.instructions);
      impl.addChatMessages(1, USER, [{type: "message", message: "Continue without defaults."}]);
      const cleared = await turn(impl, 1);
      expect(cleared[0]?.environment).not.toContain("# Personal global instructions");
      // A durable summary must come from the transcript, not from the personal system block.
      impl.addChatMessages(1, USER, [{
        type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""},
      }]);
      const compaction = await turn(impl, 1, personal, true);
      expect(compaction).toHaveLength(1);
      expect(compaction[0]?.environment).not.toContain(personal.instructions);
      expect(compaction[0]?.environment).not.toContain(personal.cacheSalt);
      expect(impl.loadChatHistory(1).checkpoint?.summary).toBe("Task handoff.");
      const durable = JSON.stringify({
        messages: [...impl.storage.chats.list()],
        contexts: [...impl.storage.chatContext.list()],
        checkpoints: [...impl.storage.chatCompactions.list()],
      });
      for (const value of [...Object.values(personal), ...Object.values(bob)]) {
        expect(durable).not.toContain(value);
      }
    });
  });
});
