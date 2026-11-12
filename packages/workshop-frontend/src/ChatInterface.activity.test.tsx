// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AiChatMetadata, AiChatSubscriber } from "@gadgets/workshop-shared/api";
import { makeOverseer, makeTestRoot } from "./action-test-harness";
import ChatInterface from "./ChatInterface";

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({currentUser: null}),
  useOptionalAuthenticatedApi: () => null,
}));
vi.mock("./features/notifications/UnreadStateBridge", () => ({useUnreadState: () => null}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const testRoot = makeTestRoot();
Element.prototype.scrollTo = () => {};
afterEach(() => { testRoot.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const agent = {type: "agent" as const, id: "model", name: "Test agent"};
const chat = (id: number, over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id, title: `Chat ${id}`, started: new Date(), lastActive: new Date(), ...over,
});

const setup = () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  let subscriber: AiChatSubscriber;
  Object.assign(server.overseer, {
    listChats: async () => [chat(1), chat(2)],
    listModels: async () => [],
    getChatHistory: async () => ({messages: []}),
    onRpcBroken: () => {},
    viewChat: () => ({[Symbol.dispose]: () => {}}),
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next;
      return {[Symbol.dispose]: () => {}};
    },
  });
  const activity = vi.fn<(chatId: number | null, active: boolean) => void>();
  return {
    activity,
    render: (selectedChatId: number | null) => testRoot.render(
      <ChatInterface workspaceId="workspace" overseer={server.overseer}
        selectedChatId={selectedChatId} onNavigateToChat={() => {}}
        onAgentActiveChange={activity}
        pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
        onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
        onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
    ),
    metadata: (value: AiChatMetadata) => act(async () => { subscriber.metadata(value); }),
    deleted: (id: number) => act(async () => { subscriber.deleted(id); }),
  };
};

it.each([false, true])("stops activity after backing out of a running chat (spawned: %s)", async spawned => {
  const view = setup();
  await view.render(1);
  const metadata = chat(1, spawned ? {spawnerName: "Spawner"} : {});
  await view.metadata({...metadata, activeAgent: agent});
  expect(view.activity).toHaveBeenLastCalledWith(1, true);
  await view.render(null);
  expect(view.activity).toHaveBeenLastCalledWith(null, true);
  await view.metadata(metadata);
  expect(view.activity).toHaveBeenLastCalledWith(null, false);
});

it("tracks every running chat in the list and only the selected chat in a thread", async () => {
  const view = setup();
  await view.render(1);
  await view.metadata(chat(1, {activeAgent: agent}));
  await view.metadata(chat(2, {activeAgent: agent, spawnerName: "Spawner"}));
  await view.metadata(chat(1));
  expect(view.activity).toHaveBeenLastCalledWith(1, false);
  await view.render(null);
  expect(view.activity).toHaveBeenLastCalledWith(null, true);
  await view.metadata(chat(1, {activeAgent: agent}));
  await view.metadata(chat(2));
  expect(view.activity).toHaveBeenLastCalledWith(null, true);
  await view.metadata(chat(1));
  expect(view.activity).toHaveBeenLastCalledWith(null, false);
});

it("clears list activity when the last running chat is deleted", async () => {
  const view = setup();
  await view.render(null);
  await view.metadata(chat(2, {activeAgent: agent}));
  expect(view.activity).toHaveBeenLastCalledWith(null, true);
  await view.deleted(2);
  expect(view.activity).toHaveBeenLastCalledWith(null, false);
});
