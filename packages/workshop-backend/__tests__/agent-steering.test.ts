// A Stop that lands while a step is being saved: pi asks for steering messages next, and the turn
// must leave them waiting rather than log them as read by a turn that will never answer them.
// Drives the real runAgent against a real OverseerImpl, with pi's faux provider standing in for the
// model.

import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { PendingSteerRecord } from "../src/storage-schema/overseer-storage.js";
import { runAgent, type AgentHooks } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The OverseerImpl members this test drives; the class itself is private to overseer.ts.
interface OverseerInternals extends AgentHooks {
  storage: {
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void, list(): Iterable<AiChatMessage> };
    pendingSteers: { put(record: PendingSteerRecord): void, list(): Iterable<PendingSteerRecord> };
  };
  nextChatSequence(chatId: number): number;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const COLLABORATOR: AiChatAuthorInfo = { type: "user", id: "bob@example.com", name: "Bob" };
const CHAT_ID = 1;

it("a turn stopped while it saves a step leaves the steers sent meanwhile unread", async () => {
  let stub = env.TEST_OVERSEER.getByName("agent-steering");
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // OverseerImpl is private to overseer.ts; OverseerInternals names the parts driven here.
    let internals = instance as unknown as { impl: OverseerInternals };
    let impl = internals.impl;
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
      author: OWNER, type: "message", message: "Build a habit tracker.",
    });

    let controller = new AbortController();
    let commitAgentStep = impl.commitAgentStep.bind(impl);
    impl.commitAgentStep = (...args) => {
      impl.storage.pendingSteers.put(
          { chatId: CHAT_ID, steerId: 1, text: "Use blue.", author: COLLABORATOR });
      controller.abort(new Error("User requested to stop agent."));
      return commitAgentStep(...args);
    };
    let faux = createFauxCore({ models: [{ id: "faux-model" }] });
    faux.setResponses([fauxAssistantMessage(fauxText("Built it."))]);
    await expect(runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
        { type: "agent", id: "faux-model", name: "Faux" }, controller.signal, OWNER,
        { provider: "cloudflare", model: "faux-model", apiToken: "" }))
        .rejects.toThrow("User requested to stop agent.");

    expect([...impl.storage.pendingSteers.list()].map(steer => steer.text)).toEqual(["Use blue."]);
    expect([...impl.storage.chats.list()].flatMap(msg => msg.type === "message" ? [msg.message] : []))
        .toEqual(["Build a habit tracker.", "Built it."]);
  });
});
