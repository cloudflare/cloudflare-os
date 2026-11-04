import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatMessageBody, Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer";
import { openFakeOverseer } from "./fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

let counter = 0;
const withChat = async (test: (impl: any, client: Overseer) => Promise<void>) => {
  const stub = env.TEST_OVERSEER.getByName(`chat-bindings-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = (instance as unknown as {impl: any}).impl;
    impl.storage.chatMeta.put({id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0)});
    for (const id of [5, 6, 7, 8]) {
      impl.storage.gatekeepers.put({id, resourceTitle: `Slack ${id}`, class: {} as any,
        creationSpec: {type: "gatekeeper", vendorId: "slack", resourceUrl: "slack://test", typeUrlPattern: "slack://*"}});
    }
    const client = await openFakeOverseer(impl.storage, {impl: {
      loadChatHistory: impl.loadChatHistory.bind(impl),
      getChatAgentContext: impl.getChatAgentContext.bind(impl),
      gatekeeperUsable: (id: number) => id !== 8,
    }});
    await test(impl, client);
  });
};

const append = (impl: any, sequence: number, body: AiChatMessageBody, chatId = 1) => {
  impl.storage.chats.put({chatId, sequence, timestamp: new Date(sequence),
    author: {type: "user", id: "owner", name: "Owner"}, ...body});
};

it("lists a chat's saved aliases independently of current gadget bindings and filters missing or quarantined resources", async () => {
  await withChat(async (impl, client) => {
    impl.storage.chatContext.put({chatId: 1, bindings: {SLACK_CTO: 5, SLACK_SUCCESS: 6, GONE: 99, BLOCKED: 8, APP: 10}});
    impl.storage.gadgets.put({type: "gadget", id: 10, title: "Megamind", bindingName: "APP",
      created: new Date(0), bindings: {SLACK_WORKSPACE: {target: 5}, LATER: {target: 7}}});
    expect(await client.listChatBindings(1)).toEqual([
      {name: "SLACK_CTO", target: 5, resourceTitle: "Slack 5", vendorId: "slack"},
      {name: "SLACK_SUCCESS", target: 6, resourceTitle: "Slack 6", vendorId: "slack"},
    ]);
  });
});

it("replays accepted requests, pasted resources and successful creations without including other chats, failed tools or pending requests", async () => {
  await withChat(async (impl, client) => {
    impl.storage.chatContext.put({chatId: 1, bindings: {}});
    append(impl, 1, {type: "connectionRequest", requestId: "accepted", vendorId: "slack", vendorName: "Slack", reason: "Read Slack",
      state: "accepted", gatekeeperId: 5, bindingName: "ACCEPTED"});
    append(impl, 2, {type: "connectionRequest", requestId: "pending", vendorId: "slack", vendorName: "Slack", reason: "Read Slack",
      state: "pending", bindingName: "PENDING"});
    append(impl, 3, {type: "message", message: "Use this", capsules: [{position: 0, length: 4,
      gatekeeperId: 6, bindingName: "PASTED", description: {url: "slack://test", title: "Slack", snippet: "",
        suggestedBindingName: "SLACK", tsType: "Slack"}}]});
    append(impl, 4, {type: "message", message: "", toolCalls: [{toolName: "createExternalResource", toolCallId: "made",
      input: {bindingName: "CREATED", vendorId: "slack", resourceUrlPattern: "slack://*", title: "Created"},
      output: {gatekeeperId: 7}}]});
    append(impl, 5, {type: "connectionRequest", requestId: "denied", vendorId: "slack", vendorName: "Slack", reason: "Read Slack",
      state: "denied", gatekeeperId: 5, bindingName: "DENIED"});
    append(impl, 6, {type: "message", message: "", toolCalls: [{toolName: "createExternalResource", toolCallId: "failed",
      input: {bindingName: "FAILED", vendorId: "slack", resourceUrlPattern: "slack://*", title: "Failed"},
      output: {gatekeeperId: 7}, error: "Failed"}]});
    append(impl, 7, {type: "agentCallback", methodName: "run", argsSummary: "", bindingName: "ARGS"});
    append(impl, 8, {type: "connectionRequest", requestId: "other", vendorId: "slack", vendorName: "Slack", reason: "Read Slack",
      state: "accepted", gatekeeperId: 5, bindingName: "OTHER_CHAT"}, 2);
    expect((await client.listChatBindings(1)).map(binding => binding.name)).toEqual(["ACCEPTED", "PASTED", "CREATED"]);
  });
});

it("retains bindings across compaction, honoring checkpoint aliases over the seed", async () => {
  await withChat(async (impl, client) => {
    impl.storage.chatContext.put({chatId: 1, bindings: {SLACK: 5}});
    impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1), compactedTo: 10});
    impl.storage.chatCompactions.put({chatId: 1, compactedTo: 10, summary: "Earlier", nextChangeId: 0,
      chatBindings: [["SLACK", {type: "workpiece", id: 6}]]});
    // This earlier record must not overwrite the checkpoint when the tail is replayed.
    append(impl, 1, {type: "message", message: "", toolCalls: [{toolName: "createExternalResource", toolCallId: "old",
      input: {bindingName: "SLACK", vendorId: "slack", resourceUrlPattern: "slack://*", title: "Old"}, output: {gatekeeperId: 5}}]});
    expect(await client.listChatBindings(1)).toEqual([{name: "SLACK", target: 6, resourceTitle: "Slack 6", vendorId: "slack"}]);
  });
});

it("does not initialize an unstarted chat or provide chat metadata to use-only collaborators", async () => {
  await withChat(async (impl, client) => {
    expect(await client.listChatBindings(1)).toEqual([]);
    expect(impl.storage.chatContext.get(1)).toBeUndefined();
    const viewer = await openFakeOverseer(impl.storage, {role: "use"});
    await expect(viewer.listChatBindings(1)).rejects.toThrow();
    await expect(client.listChatBindings(999)).rejects.toThrow();
  });
});
