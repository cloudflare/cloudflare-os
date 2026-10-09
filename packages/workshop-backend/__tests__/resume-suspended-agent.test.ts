// Resuming a suspended agent turn when the thread's model stops resolving. The decision that
// triggers the resume (an accepted connection, an approved action) is recorded before the model is
// looked up, so a failed lookup has to be reported in the chat rather than fail the decision's RPC.

import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata,
} from "@gadgets/workshop-shared/api";
import { FIXTURE_EPOCH, openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const CHAT_ID = 1;
const REQUEST_ID = `${CHAT_ID}:request`;
const USER: AiChatAuthorInfo = { type: "user", id: "owner-id", name: "Test User" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "retired-model", name: "Retired Model" };

// A chat whose turn ended on a pending connection request authored by `requester`, opened by a
// user whose getChatContext() rejects with `reason`.
async function openSuspendedChat(requester: AiChatAuthorInfo, reason: string) {
  let started = new Date(FIXTURE_EPOCH);
  let meta: AiChatMetadata = { id: CHAT_ID, title: "Chat", started, lastActive: started };
  let messages: AiChatMessage[] = [{
    chatId: CHAT_ID, sequence: 0, timestamp: started, author: USER,
    type: "message", message: "Read my calendar.",
  }, {
    chatId: CHAT_ID, sequence: 1, timestamp: new Date(FIXTURE_EPOCH + 1), author: requester,
    type: "connectionRequest", requestId: REQUEST_ID, vendorId: "calendar",
    vendorName: "Calendar", reason: "To read the calendar.", state: "pending",
  }];

  let getChatContext = vi.fn(async (_modelId: string | null) => { throw new Error(reason); });
  let logError = vi.fn();
  let postAgentErrorMessage = vi.fn();
  let startAgent = vi.fn();
  let client = await openFakeOverseer({
    chatMeta: { get: () => meta },
    chats: {
      list: (options: { reverse?: boolean }) => options.reverse ? messages.toReversed() : messages,
      put: (msg: AiChatMessage) => { messages[msg.sequence] = msg; },
    },
  }, { impl: {
    logger: { error: logError },
    users: {
      idFromString: (id: string) => id,
      get: (id: string) => ({ id, whoami: async () => USER, getChatContext }),
    },
    getChatTimestamp: () => new Date(FIXTURE_EPOCH + 2),
    waitForChatMessagePreparation: () => undefined,
    postAgentErrorMessage,
    startAgent,
  } });
  return { client, meta, messages, getChatContext, logError, postAgentErrorMessage, startAgent };
}

describe("resuming a suspended agent whose model no longer resolves", () => {
  it("accepts the connection and reports the reason in the chat", async () => {
    let reason = 'The "Retired Model" model is disabled on this deployment by an administrator.';
    let { client, meta, messages, getChatContext, logError, postAgentErrorMessage, startAgent } =
        await openSuspendedChat(AGENT, reason);

    await expect(client.acceptConnectionRequest(REQUEST_ID, { gatekeeperId: 7 }))
        .resolves.toBeUndefined();

    expect(getChatContext).toHaveBeenCalledWith(AGENT.id);
    expect(postAgentErrorMessage).toHaveBeenCalledTimes(1);
    expect(postAgentErrorMessage).toHaveBeenCalledWith(
        CHAT_ID, AGENT, expect.stringContaining(reason));
    expect(logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: "agent.resume.suspended.model.resolve.failed", chatId: CHAT_ID, modelId: AGENT.id,
    }));

    // The acceptance stands, and no turn was started on the chat.
    expect(messages[1]).toMatchObject({ state: "accepted", gatekeeperId: 7 });
    expect(startAgent).not.toHaveBeenCalled();
    expect(meta.activeAgent).toBeUndefined();
  });

  it("posts nothing when another turn started during the lookup", async () => {
    let { client, meta, getChatContext, logError, postAgentErrorMessage, startAgent } =
        await openSuspendedChat(AGENT, "No such model: retired-model");
    let other: AiChatAuthorInfo = { type: "agent", id: "other-model", name: "Other Model" };
    getChatContext.mockImplementationOnce(async () => {
      meta.activeAgent = other;
      throw new Error("No such model: retired-model");
    });

    await expect(client.acceptConnectionRequest(REQUEST_ID, { gatekeeperId: 7 }))
        .resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(postAgentErrorMessage).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
    expect(meta.activeAgent).toBe(other);
  });

  it("rethrows when no agent message exists to attribute the error to", async () => {
    // No agent ever wrote in this chat, so no model is looked up and the rejection is the user
    // object's own failure.
    let { client, getChatContext, postAgentErrorMessage, startAgent } =
        await openSuspendedChat(USER, "user object unavailable");

    await expect(client.acceptConnectionRequest(REQUEST_ID, { gatekeeperId: 7 }))
        .rejects.toThrow("user object unavailable");

    expect(getChatContext).toHaveBeenCalledWith(null);
    expect(postAgentErrorMessage).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
  });
});
