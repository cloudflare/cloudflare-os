import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyString } from "@gadgets/typed-storage";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// A turn a user starts ends by accepting what its chat proposes (see Overseer.mergeChanges's
// `automatic`), run through a real agent turn whose model answers at once.

const CHAT = 1;
const USER = {type: "user" as const, id: "alice@example.com", name: "Alice"};
const MODEL = {
  profile: {type: "agent" as const, id: "accept-model", name: "Accept model"},
  config: {provider: "anthropic" as const, model: "accept-model", apiToken: "test-key",
    apiUrl: "https://auto-accept.test"},
};
type Impl = OverseerDurableObject["impl"];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// The model requests the stub answered, as sent.
const requests: string[] = [];

function answerDone() {
  const fetch = globalThis.fetch;
  requests.length = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== MODEL.config.apiUrl) return fetch(input, init);
    if (typeof init?.body === "string") requests.push(init.body);
    const events = [
      {type: "message_start", message: {id: "accept", type: "message", role: "assistant",
        model: MODEL.profile.id, content: [], stop_reason: null, stop_sequence: null,
        usage: {input_tokens: 1, output_tokens: 1}}},
      {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "Done."}},
      {type: "content_block_stop", index: 0},
      {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage: {output_tokens: 1}},
      {type: "message_stop"},
    ];
    return Promise.resolve(new Response(events.map(e =>
      `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      {headers: {"content-type": "text/event-stream"}}));
  });
}

// A workspace whose chat proposes an edit to gadget 1, ready for a turn.
async function proposingChat() {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => {
    instance["storage"].profile.put(USER);
    instance["storage"].aiModels.put(MODEL);
  });
  await user.newWorkspace(stub.id.toString(), "Accept");
  const userId = user.id.toString();
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => fn(impl));
  await visit(async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(userId);
    impl.ownerId = userId;
    const head = await impl.gitCache.writeFilesAsCommit(new Map([["a.txt", "one\n"]]), {
      parents: [], author: {name: "Alice", email: "alice@example.com"}, message: "start",
      timestamp: new Date(0)});
    impl.storage.gadgets.put({type: "gadget", id: 1, title: "App", created: new Date(0),
      bindingName: "APP", bindings: {}, commitId: head});
    const timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: CHAT, title: "Accept", started: timestamp, lastActive: timestamp});
    impl.storage.chatContext.put({chatId: CHAT, bindings: {}, alwaysAvailableCapsuleIds: []});
    await impl.submitCodeChange(CHAT, {generation: 0, revision: 0, clientId: "cli", seq: 1,
      pins: [{gadgetId: 1, baseCommit: head}],
      change: diffFiles(new Map([[1, new Map([["a.txt", "one\n"]])]]),
                        new Map([[1, new Map([["a.txt", "two\n"]])]]))}, USER, userId);
    impl.addChatMessages(CHAT, USER, [{type: "message", message: "Do the work"}]);
  });
  // Starts a turn, and resolves once it and whatever follows it have finished.
  const runTurn = (initiator: AiChatAuthorInfo = USER, callbackInitiated = false, chatId = CHAT) => visit(async impl => {
    quiet = 0;
    const meta = impl.storage.chatMeta.get(chatId)!;
    impl.storage.chatMeta.put({...meta, activeAgent: MODEL.profile});
    impl.startAgent(chatId, MODEL, initiator, userId, callbackInitiated);
    for (let i = 0; i < 200 && (impl.storage.chatMeta.get(chatId)?.activeAgent || !settledFor(impl)); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  let quiet = 0;
  const settledFor = (_impl: Impl) => ++quiet > 20;
  const messages = () => visit(impl =>
    [...impl.storage.chats.list({prefix: `${keyString(CHAT)}.`})] as AiChatMessage[]);
  return {visit, runTurn, messages};
}

describe("accepting a turn's changes as it ends", () => {
  it("merges what the chat proposes, marked automatic", async () => {
    answerDone();
    const {visit, runTurn, messages} = await proposingChat();
    await runTurn();

    const merge = (await messages()).find(msg => msg.type === "merge");
    expect(merge).toMatchObject({automatic: true, author: USER});
    await visit(impl => {
      expect(impl.gitCache.readCommitFiles(impl.storage.gadgets.get(1)!.commitId!))
          .toEqual(new Map([["a.txt", "two\n"]]));
      expect(impl.proposedChangeWorkpieceIds(CHAT, impl.storage.chatMeta.get(CHAT)!)).toEqual([]);
    });
  });

  it("leaves a turn a gadget started for the user to accept", async () => {
    answerDone();
    const {runTurn, messages} = await proposingChat();
    await runTurn({type: "gadget", id: USER.id, name: "Some gadget"}, true);
    expect((await messages()).some(msg => msg.type === "merge")).toBe(false);
  });

  it("leaves a proposal that adds a binding for the user to accept", async () => {
    answerDone();
    const {visit, runTurn, messages} = await proposingChat();
    await visit(impl => {
      // As binding a connection with the chat open leaves it (see GadgetClient.bind).
      const sequence = impl.nextChatSequencePeek(CHAT);
      impl.addChatMessages(CHAT, USER, [{type: "changes", addedBindings: [{gadgetId: 1, name: "CAL", target: 31}]}]);
      const record = impl.storage.gadgets.get(1)!;
      impl.storage.gadgets.put({...record, bindings: {CAL: {target: 31, pending: {chatId: CHAT, sequence}}}} as never);
    });
    await runTurn();
    expect((await messages()).some(msg => msg.type === "merge")).toBe(false);
  });

  it("merges a binding to a connection the user accepted in the chat", async () => {
    answerDone();
    const {visit, runTurn, messages} = await proposingChat();
    await visit(impl => {
      impl.addChatMessages(CHAT, USER, [{type: "connectionRequest", requestId: "1:1", vendorId: "cal",
        vendorName: "Calendar", reason: "To read your calendar", state: "accepted", gatekeeperId: 31}]);
      const sequence = impl.nextChatSequencePeek(CHAT);
      impl.addChatMessages(CHAT, USER, [{type: "changes", addedBindings: [{gadgetId: 1, name: "CAL", target: 31}]}]);
      const record = impl.storage.gadgets.get(1)!;
      impl.storage.gadgets.put({...record, bindings: {CAL: {target: 31, pending: {chatId: CHAT, sequence}}}} as never);
    });
    await runTurn();
    expect((await messages()).find(msg => msg.type === "merge")).toMatchObject({automatic: true});
    await visit(impl => expect(impl.storage.gadgets.get(1)!.bindings.CAL).toEqual({target: 31}));
  });
});

describe("a spawned agent's result", () => {
  it("is posted in the chat its spawner reports to, starting no turn there", async () => {
    answerDone();
    const {visit, runTurn} = await proposingChat();
    const PARENT = 2;
    await visit(impl => {
      const timestamp = impl.getChatTimestamp();
      impl.storage.chatMeta.put({id: PARENT, title: "Parent", started: timestamp, lastActive: timestamp});
      impl.storage.chatContext.put({chatId: CHAT, bindings: {}, alwaysAvailableCapsuleIds: [],
        spawnerConfig: {displayName: "Summarizer", modelId: MODEL.profile.id, env: {}, reportsToChatId: PARENT}});
    });
    await runTurn({type: "gadget", id: USER.id, name: "Scheduler"}, true);
    await visit(impl => {
      const posted = [...impl.storage.chats.list({prefix: `${keyString(PARENT)}.`})] as AiChatMessage[];
      expect(posted).toEqual([expect.objectContaining({
        type: "agentReport", runChatId: CHAT, agentName: "Summarizer", message: "Done.",
      })]);
      expect(impl.storage.chatMeta.get(PARENT)?.activeAgent).toBeUndefined();
    });

    // The parent's agent reads it with the user's next message there.
    await visit(impl => {
      impl.storage.chatContext.put({chatId: PARENT, bindings: {}, alwaysAvailableCapsuleIds: []});
      impl.addChatMessages(PARENT, USER, [{type: "message", message: "What did it find?"}]);
    });
    requests.length = 0;
    await runTurn(USER, false, PARENT);
    expect(requests[0]).toContain("Summarizer, an agent set up in this chat, finished a run");
    expect(requests[0]).toContain("Done.)\\n\\nWhat did it find?");
  });
});
