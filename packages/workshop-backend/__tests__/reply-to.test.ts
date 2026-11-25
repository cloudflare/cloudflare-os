// A reply names the message it answers (`replyToSequence`): through the real
// OverseerClientInterface, sent to an idle chat or as a steer to a running turn, it is kept on the
// message the chat logs, and a sequence that names no message in the chat is refused.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "olive@example.com", name: "Olive" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const AI_MODEL = {
  profile: AGENT, config: { provider: "cloudflare", model: "faux-model", apiToken: "" },
};

let counter = 0;

// Opens the real OverseerClientInterface as the owner over a fresh Overseer, with the owner's user
// DO faked. A turn the workspace starts runs for real but holds before its first step until
// `release` is called, so that what is sent meanwhile steers it.
async function withWorkspace(
    fn: (workspace: { impl: Impl, client: Overseer, release: () => void }) => Promise<void>) {
  let stub = env.TEST_OVERSEER.getByName(`reply-to-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = instance.impl;
    let held = Promise.withResolvers<void>();
    Object.assign(impl, {
      ownerId: OWNER_USER_ID,
      ensureAmbientCapsules: async () => {},
      markListingDirty: () => {},
      reconcilePendingGadgets: () => held.promise,
    });
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => OWNER,
      getChatContext: async (modelId: string | null) =>
        ({ profile: OWNER, ...(modelId ? { aiModel: AI_MODEL } : {}) }),
      setWorkspaceLastActive: async () => {},
      syncWorkspaceListing: () => {},
    };
    Object.assign(impl, {
      users: { idFromString: (id: string) => id, idFromName: () => OWNER_USER_ID, get: () => owner },
    });
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    await fn({ impl, client, release: () => held.resolve() });
  });
}

const messages = (impl: Impl, chatId: number) =>
  [...impl.storage.chats.list()].filter(message => message.chatId === chatId);

describe("replyToSequence", () => {
  it("is kept on a reply sent to an idle chat", () => withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("The chart covers 12 weeks.", null);
    await client.sendChatMessage(chatId, "> The chart covers 12 weeks.\n\nMake it 24.", null,
        undefined, undefined, undefined, 0);
    expect(await client.getChatMessage(chatId, 1))
        .toMatchObject({ type: "message", message: "> The chart covers 12 weeks.\n\nMake it 24.", replyToSequence: 0 });
    expect(await client.getChatMessage(chatId, 0)).toMatchObject({ type: "message", replyToSequence: undefined });
    expect(messages(impl, chatId)).toHaveLength(2);
  }));

  it("is kept by a reply that steers a running turn, queued and then read", () =>
      withWorkspace(async ({ impl, client, release }) => {
    let chatId = await client.newChat("Draw the chart.", "some-model");
    await client.sendChatMessage(chatId, "> Draw the chart.\n\nIn blue.", "some-model",
        undefined, undefined, undefined, 0);
    expect(impl.storage.chatMeta.get(chatId)?.queuedSteers)
        .toEqual([{ text: "> Draw the chart.\n\nIn blue.", author: OWNER, replyToSequence: 0 }]);

    // As the agent reads steers before its next model request.
    expect(impl.takeSteers(chatId)).toEqual(["> Draw the chart.\n\nIn blue."]);
    expect(messages(impl, chatId).at(-1)).toMatchObject(
        { type: "message", author: OWNER, steered: true, replyToSequence: 0 });

    await client.stopAgent(chatId);
    release();
    await impl.waitForAllAgentsToComplete();
  }));

  it("refuses a sequence that names no message in the chat, sent or steered", () =>
      withWorkspace(async ({ impl, client, release }) => {
    let other = await client.newChat("Elsewhere.", null);
    await client.sendChatMessage(other, "Still elsewhere.", null);
    let chatId = await client.newChat("Here.", null);
    // Sequence 1 is a message of the other chat's, and none yet of this one's.
    for (let replyToSequence of [1, 7, -1, 0.5]) {
      await expect(client.sendChatMessage(chatId, "Which one?", null,
          undefined, undefined, undefined, replyToSequence))
          .rejects.toThrow(`Chat ${chatId} has no message ${replyToSequence} to reply to.`);
    }
    expect(messages(impl, chatId)).toHaveLength(1);

    let running = await client.newChat("Draw the chart.", "some-model");
    await expect(client.sendChatMessage(running, "In blue.", "some-model",
        undefined, undefined, undefined, 1))
        .rejects.toThrow(`Chat ${running} has no message 1 to reply to.`);
    expect(impl.storage.chatMeta.get(running)?.queuedSteers).toBeUndefined();

    await client.stopAgent(running);
    release();
    await impl.waitForAllAgentsToComplete();
  }));
});
