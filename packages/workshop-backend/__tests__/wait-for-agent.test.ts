// Overseer.waitForAgent(): waiting on the real OverseerClientInterface for a chat's agent turn to
// end. The workspace records the turns it starts rather than running them (see recordTurns), and a
// test ends one the way the agent's teardown does: its reply logged, then `activeAgent` cleared.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  getWaitForAgentErrorCode, WAIT_FOR_AGENT_ERROR_CODES, type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "olive@example.com", name: "Olive" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };
const AI_MODEL = {
  profile: AGENT, config: { provider: "cloudflare", model: "faux-model", apiToken: "" },
};

interface Workspace {
  instance: OverseerDurableObject;
  impl: any;
  client: Overseer;
}

let counter = 0;

// Opens the real OverseerClientInterface as the owner over a fresh Overseer, with the owner's user
// DO faked. Its getChatContext answers a moment later, as a real user DO would, so a call pipelined
// after sendChatMessage() runs while the message is still being sent.
async function withWorkspace(fn: (workspace: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`wait-for-agent-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.startAgent = () => {};
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => OWNER,
      getChatContext: async (modelId: string | null) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { profile: OWNER, ...(modelId ? { aiModel: AI_MODEL } : {}) };
      },
      setWorkspaceLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    await fn({ instance, impl, client });
  });
}

// Ends the chat's turn as the agent's teardown does: the reply, then `activeAgent` cleared.
function endTurn(impl: any, chatId: number, reply: string): void {
  impl.storage.chats.put({
    chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
    author: AGENT, type: "message", message: reply,
  });
  let meta = impl.storage.chatMeta.get(chatId);
  delete meta.activeAgent;
  impl.storage.chatMeta.put(meta);
}

// Whether `promise` is still pending after the event loop has had a moment.
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let pending = Symbol("pending");
  promise.catch(() => {});
  return await Promise.race([promise, new Promise(resolve => setTimeout(resolve, 20, pending))])
      === pending;
}

describe("waitForAgent", () => {
  it("returns at once on an idle chat: null before the agent has written, then its latest message",
      () => withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Hello, humans only", null);
    expect(await client.waitForAgent(chatId)).toBeNull();

    impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(chatId), activeAgent: AGENT });
    endTurn(impl, chatId, "An earlier reply.");
    impl.storage.chats.put({
      chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
      author: OWNER, type: "message", message: "A later message of the owner's",
    });
    expect(await client.waitForAgent(chatId))
        .toMatchObject({ chatId, author: AGENT, type: "message", message: "An earlier reply." });
  }));

  it("waits for the turn newChat started, and returns its reply", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("What is 17 times 23?", "some-model");
    let waiting = client.waitForAgent(chatId);
    expect(await isPending(waiting)).toBe(true);

    endTurn(impl, chatId, "391.");
    expect(await waiting).toMatchObject({ chatId, author: AGENT, message: "391." });
  }));

  it("waits for the turn of a sendChatMessage() pipelined before it", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Hello", null);
    let sent = client.sendChatMessage(chatId, "What is 17 times 23?", "some-model");
    let waiting = client.waitForAgent(chatId);
    await sent;
    expect(impl.storage.chatMeta.get(chatId).activeAgent).toEqual(AGENT);
    expect(await isPending(waiting)).toBe(true);

    endTurn(impl, chatId, "391.");
    expect(await waiting).toMatchObject({ message: "391." });
  }));

  it("waits through a turn that hands straight on to the next", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Start", "some-model");
    let waiting = client.waitForAgent(chatId);
    expect(await isPending(waiting)).toBe(true);

    // The way #finishAgentTurn starts the turn that reads queued steers: activeAgent clears and
    // is set again in one synchronous step.
    let meta = impl.storage.chatMeta.get(chatId);
    delete meta.activeAgent;
    impl.storage.chatMeta.put(meta);
    impl.storage.chatMeta.put({ ...meta, activeAgent: AGENT });
    expect(await isPending(waiting)).toBe(true);

    endTurn(impl, chatId, "Done.");
    expect(await waiting).toMatchObject({ message: "Done." });
  }));

  it("waits through the turn that takes the calls made to the agent while it ran", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Start", "some-model");
    let waiting = client.waitForAgent(chatId);
    expect(await isPending(waiting)).toBe(true);
    await impl.deliverAgentCallback(chatId, "composeEmail", [], OWNER_USER_ID, "some-model");

    // The way the agent's teardown ends a turn with calls recorded: activeAgent clears, then
    // #finishAgentTurn kicks the drain, which awaits the user DO before it starts the next turn.
    endTurn(impl, chatId, "First reply.");
    let drained = impl.drainPendingAgentCalls(chatId);
    expect(await isPending(waiting)).toBe(true);
    await drained;
    expect(impl.storage.chatMeta.get(chatId).activeAgent).toEqual(AGENT);
    expect(await isPending(waiting)).toBe(true);

    endTurn(impl, chatId, "Email composed.");
    expect(await waiting).toMatchObject({ message: "Email composed." });
  }));

  it("returns the agent's latest message, not the note Stop logs under it", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Start", "some-model");
    impl.storage.chats.put({
      chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
      author: AGENT, type: "message", message: "Halfway there.",
    });
    let waiting = client.waitForAgent(chatId);
    expect(await isPending(waiting)).toBe(true);

    await client.stopAgent(chatId);
    expect(impl.storage.chatMeta.get(chatId).activeAgent).toBeUndefined();
    expect(await waiting).toMatchObject({ author: AGENT, type: "message", message: "Halfway there." });
  }));

  it("returns the agent's reply, not the changes its last step recorded after it", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Start", "some-model");
    endTurn(impl, chatId, "Done.");
    impl.storage.chats.put({
      chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
      author: AGENT, type: "changes",
    });
    expect(await client.waitForAgent(chatId)).toMatchObject({ author: AGENT, type: "message", message: "Done." });
  }));

  it("fails with a coded error when timeoutMs runs out with the agent still running", () =>
      withWorkspace(async ({ client }) => {
    let chatId = await client.newChat("Start", "some-model");
    for (let timeoutMs of [0, 30]) {
      let error = await client.waitForAgent(chatId, timeoutMs).catch((err: unknown) => err);
      expect(getWaitForAgentErrorCode(error)).toBe(WAIT_FOR_AGENT_ERROR_CODES.timedOut);
    }
    await expect(client.waitForAgent(chatId, -1)).rejects.toThrow("timeoutMs");
  }));

  it("counts the wait for a pipelined sendChatMessage() toward timeoutMs", () =>
      withWorkspace(async ({ impl, client }) => {
    let chatId = await client.newChat("Hello", null);
    let owner = impl.users.get();
    let { promise: answered, resolve: answer } = Promise.withResolvers<void>();
    let getChatContext = owner.getChatContext;
    owner.getChatContext = async (modelId: string | null) => {
      await answered;
      return getChatContext(modelId);
    };
    let sent = client.sendChatMessage(chatId, "What is 17 times 23?", "some-model");
    let error = await client.waitForAgent(chatId, 30).catch((err: unknown) => err);
    expect(getWaitForAgentErrorCode(error)).toBe(WAIT_FOR_AGENT_ERROR_CODES.timedOut);
    answer();
    await sent;
  }));

  it("ends when its session is closed", () => withWorkspace(async ({ instance, client }) => {
    let chatId = await client.newChat("Start", "some-model");
    let notifyClosed = new NativeRpcStub<() => void>(() => {});
    let other = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    notifyClosed[Symbol.dispose]();
    let waiting = other.waitForAgent(chatId);
    expect(await isPending(waiting)).toBe(true);

    other[Symbol.dispose]();
    await expect(waiting).rejects.toThrow("The workspace session was closed.");
  }));

  it("fails for a chat that does not exist, or is deleted while waited on", () =>
      withWorkspace(async ({ client }) => {
    await expect(client.waitForAgent(42)).rejects.toThrow("No such chatId: 42");

    let chatId = await client.newChat("Start", "some-model");
    let waiting = client.waitForAgent(chatId);
    expect(await isPending(waiting)).toBe(true);
    await client.deleteChat(chatId);
    await expect(waiting).rejects.toThrow(`No such chatId: ${chatId}`);
  }));
});
