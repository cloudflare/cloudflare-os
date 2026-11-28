// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import { makeOverseer, makeTestRoot } from "./action-test-harness";
import ChatInterface from "./ChatInterface";

const mock = vi.hoisted(() => ({
  addToast: vi.fn<(toast: {title: string, variant?: string}) => void>(),
  reportIssue: vi.fn<typeof import("./errorReporting").reportIssue>(),
}));
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
  useKumoToastManager: () => ({add: mock.addToast}),
}));
vi.mock("./errorReporting", async importOriginal => ({
  ...await importOriginal<typeof import("./errorReporting")>(),
  reportIssue: mock.reportIssue,
}));

const testRoot = makeTestRoot();
Element.prototype.scrollTo = () => {};
afterEach(() => { testRoot.cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const chat: AiChatMetadata = {id: 3, title: "Long thread", started: new Date(), lastActive: new Date()};

const openChatWhoseHistoryFails = async (failure: Error) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const server = makeOverseer();
  Object.assign(server.overseer, {
    listChats: async () => [chat],
    listModels: async () => [],
    getChatHistory: async () => { throw failure; },
    onRpcBroken: () => {},
    viewChat: () => ({[Symbol.dispose]: () => {}}),
    subscribeToChat: () => ({[Symbol.dispose]: () => {}}),
  });
  const onNavigateToChat = vi.fn<ComponentProps<typeof ChatInterface>["onNavigateToChat"]>();
  await testRoot.render(
    <ChatInterface workspaceId="workspace" overseer={server.overseer}
      selectedChatId={chat.id} onNavigateToChat={onNavigateToChat}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
  );
  return onNavigateToChat;
};

it("says so, and reports it, when a chat's history fails to load", async () => {
  const failure = new Error("Serialized RPC arguments or return values are limited to 32MiB, " +
    "but the size of this value was: 40000000 bytes.");
  const onNavigateToChat = await openChatWhoseHistoryFails(failure);

  expect(onNavigateToChat).toHaveBeenCalledWith(null, {replace: true});
  expect(mock.addToast).toHaveBeenCalledWith(
    expect.objectContaining({title: "Failed to open this chat", variant: "error"}));
  expect(mock.reportIssue).toHaveBeenCalledWith("chat.history-load", failure);
});

it("returns to the list quietly when the connection drops during the load", async () => {
  const onNavigateToChat = await openChatWhoseHistoryFails(new Error("Peer closed WebSocket"));

  expect(onNavigateToChat).toHaveBeenCalledWith(null, {replace: true});
  expect(mock.addToast).not.toHaveBeenCalledWith(
    expect.objectContaining({title: "Failed to open this chat"}));
  expect(mock.reportIssue).not.toHaveBeenCalledWith("chat.history-load", expect.anything());
});
