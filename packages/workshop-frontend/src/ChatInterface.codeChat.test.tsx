// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AiChatMetadata, AiChatSubscriber } from "@gadgets/workshop-shared/api";
import { makeOverseer, makeTestRoot } from "./action-test-harness";
import ChatInterface, { type ChatCodeChanges } from "./ChatInterface";

// The Workshop shows a spawned agent's chat over the chat the user works in, whose code the code
// view goes on showing: what ChatInterface reports for the code view follows `codeChatId`, while
// the transcript shows `selectedChatId`.

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({currentUser: null}),
  useOptionalAuthenticatedApi: () => null,
}));
vi.mock("./features/notifications/UnreadStateBridge", async importOriginal => ({
  ...await importOriginal<typeof import("./features/notifications/UnreadStateBridge")>(),
  useUnreadState: () => null,
}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const testRoot = makeTestRoot();
Element.prototype.scrollTo = () => {};
afterEach(() => { testRoot.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const WORKING_CHAT = 2;
const AGENT_CHAT = 5;
const agent = {type: "agent" as const, id: "model", name: "Test agent"};
const chat = (id: number, over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id, title: `Chat ${id}`, started: new Date(), lastActive: new Date(), ...over,
});
const CHATS = [
  chat(WORKING_CHAT, {proposedChangeWorkpieces: [3]}),
  chat(AGENT_CHAT, {spawnerName: "Researcher"}),
];

const setup = () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  let subscriber: AiChatSubscriber;
  const historyLoads: number[] = [];
  Object.assign(server.overseer, {
    listChats: async () => CHATS,
    listModels: async () => [],
    getChatHistory: async (chatId: number) => {
      historyLoads.push(chatId);
      return {messages: []};
    },
    onRpcBroken: () => {},
    viewChat: () => ({[Symbol.dispose]: () => {}}),
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next;
      return {[Symbol.dispose]: () => {}};
    },
  });
  const activity = vi.fn<(chatId: number | null, active: boolean) => void>();
  const changes = vi.fn<(changes: ChatCodeChanges | undefined) => void>();
  const proposed = vi.fn<(workpieceIds: readonly number[]) => void>();
  const listed = vi.fn<(chats: readonly AiChatMetadata[]) => void>();
  return {
    activity, changes, proposed, listed, historyLoads,
    render: (selectedChatId: number | null, codeChatId?: number | null,
             returnChatId?: number | null) => testRoot.render(
      <ChatInterface workspaceId="workspace" overseer={server.overseer}
        selectedChatId={selectedChatId} codeChatId={codeChatId} returnChatId={returnChatId}
        onNavigateToChat={() => {}}
        onAgentActiveChange={activity} onChatChangesChange={changes}
        onSelectedChatProposedChangesChange={proposed} onChatListChange={listed}
        pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
        onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
        onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
    ),
    metadata: (value: AiChatMetadata) => act(async () => { subscriber.metadata(value); }),
  };
};

it("reports the code chat's changes and proposals while showing another chat", async () => {
  const view = setup();
  await view.render(AGENT_CHAT, WORKING_CHAT);

  expect(view.historyLoads.toSorted()).toEqual([WORKING_CHAT, AGENT_CHAT]);
  expect(view.changes).toHaveBeenLastCalledWith(expect.objectContaining({chatId: WORKING_CHAT}));
  expect(view.proposed).toHaveBeenLastCalledWith([3]);
  expect(view.listed).toHaveBeenLastCalledWith(CHATS);
});

it("reports the code chat's agent running, not the shown chat's", async () => {
  const view = setup();
  await view.render(AGENT_CHAT, WORKING_CHAT);

  await view.metadata({...CHATS[1], activeAgent: agent});
  expect(view.activity).not.toHaveBeenCalledWith(AGENT_CHAT, expect.anything());
  expect(view.activity).toHaveBeenLastCalledWith(WORKING_CHAT, false);

  await view.metadata({...CHATS[0], activeAgent: agent});
  expect(view.activity).toHaveBeenLastCalledWith(WORKING_CHAT, true);
});

it("loads the code chat's history only while another chat is shown over it", async () => {
  const view = setup();
  await view.render(WORKING_CHAT);
  await view.render(AGENT_CHAT, WORKING_CHAT);

  expect(view.historyLoads).toEqual([WORKING_CHAT, AGENT_CHAT]);
});

it("names the chat Back returns to", async () => {
  const view = setup();
  const back = () => document.querySelector("[aria-label^='Back to']")?.getAttribute("aria-label");

  await view.render(AGENT_CHAT, WORKING_CHAT, WORKING_CHAT);
  expect(back()).toBe(`Back to Chat ${WORKING_CHAT}`);

  await view.render(AGENT_CHAT);
  expect(back()).toBe("Back to conversations");
});

// The editor takes every snapshot of a draft's chat as new code and reloads the draft's preview,
// losing its state, so another chat's history arriving must not resend one.
it("doesn't resend the code chat's snapshot when another chat's history loads", async () => {
  const view = setup();
  await view.render(WORKING_CHAT);
  expect(view.changes).toHaveBeenLastCalledWith(expect.objectContaining({chatId: WORKING_CHAT}));
  const sent = view.changes.mock.calls.length;

  await view.render(AGENT_CHAT, WORKING_CHAT);

  expect(view.historyLoads).toEqual([WORKING_CHAT, AGENT_CHAT]);
  expect(view.changes).toHaveBeenCalledTimes(sent);
});
