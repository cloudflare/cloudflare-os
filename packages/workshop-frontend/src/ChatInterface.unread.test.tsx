// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AiChatMetadata, Overseer } from "@gadgets/workshop-shared/api";
import type { useUnreadState } from "./features/notifications/UnreadStateBridge";
import { makeOverseer, makeTestRoot } from "./action-test-harness";
import ChatInterface from "./ChatInterface";

const mock = vi.hoisted(() => ({unread: null as ReturnType<typeof useUnreadState>}));
vi.mock("./features/notifications/UnreadStateBridge", () => ({useUnreadState: () => mock.unread}));
vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({currentUser: null}),
  useOptionalAuthenticatedApi: () => null,
}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const testRoot = makeTestRoot();
afterEach(() => { testRoot.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([10, 0, undefined])("only offers the useful thread read action (unread count: %s)", async count => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  const chat: AiChatMetadata = {id: 1, title: "Unread test", started: new Date(), lastActive: new Date()};
  Object.assign(server.overseer, {
    listChats: async () => [chat],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: () => ({[Symbol.dispose]: () => {}}),
  });
  const markRead = vi.fn<NonNullable<ReturnType<typeof useUnreadState>>["markRead"]>().mockResolvedValue(undefined);
  const markUnread = vi.fn<NonNullable<ReturnType<typeof useUnreadState>>["markUnread"]>().mockResolvedValue(true);
  mock.unread = {
    chats: count === undefined ? undefined : [{workspaceId: "workspace", chatId: 1,
      readThroughSequence: 0, unreadMessageCount: count}],
    subscribeToUpdates: () => () => {},
    markRead, markUnread,
    markAllRead: async () => {}, markWorkspaceRead: async () => {},
  };
  await testRoot.render(
    <ChatInterface workspaceId="workspace" overseer={server.overseer}
      selectedChatId={null} onNavigateToChat={() => {}}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
  );
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for Unread test"]')!;
  await act(async () => trigger.click());
  const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent === label)!;
  expect(item("Mark thread read").getAttribute("aria-disabled")).toBe(count ? null : "true");
  expect(item("Mark thread unread").getAttribute("aria-disabled")).toBe(count === 0 ? null : "true");
  // Trying the disabled action cannot rewind an unread thread past unseen messages.
  await act(async () => item(count ? "Mark thread unread" : "Mark thread read").click());
  expect(markRead).not.toHaveBeenCalled();
  expect(markUnread).not.toHaveBeenCalled();
  if (count !== undefined) {
    await act(async () => item(count ? "Mark thread read" : "Mark thread unread").click());
  }
  expect(markRead.mock.calls).toEqual(count ? [[server.overseer, 1]] : []);
  expect(markUnread.mock.calls).toEqual(count === 0 ? [[server.overseer, 1]] : []);
});

// The same thread menu handles normal and spawned chats, including saved overrides.
it.each([
  {spawned: false, enabled: undefined, expectedEnabled: true},
  {spawned: true, enabled: undefined, expectedEnabled: false},
  {spawned: true, enabled: true, expectedEnabled: true},
  {spawned: false, enabled: false, expectedEnabled: false},
])("toggles chat notifications (spawned: $spawned, override: $enabled)", async ({spawned, enabled, expectedEnabled}) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  const setNotifications = vi.fn<Overseer["setChatNotificationsEnabled"]>().mockResolvedValue(undefined);
  const chat: AiChatMetadata = {id: 1, title: "Notification test", started: new Date(), lastActive: new Date(),
    ...(spawned ? {spawnerName: "Spawner"} : {})};
  Object.assign(server.overseer, {
    listChats: async () => [chat], listModels: async () => [], onRpcBroken: () => {},
    subscribeToChat: () => ({[Symbol.dispose]: () => {}}),
    setChatNotificationsEnabled: setNotifications,
  });
  mock.unread = {
    chats: [{workspaceId: "workspace", chatId: 1, readThroughSequence: 0, unreadMessageCount: 0,
      notificationsEnabled: enabled}],
    subscribeToUpdates: () => () => {}, markRead: async () => {}, markUnread: async () => true,
    markAllRead: async () => {}, markWorkspaceRead: async () => {},
  };
  await testRoot.render(
    <ChatInterface workspaceId="workspace" overseer={server.overseer}
      selectedChatId={null} onNavigateToChat={() => {}}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
  );
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for Notification test"]')!;
  await act(async () => trigger.click());
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.find(item => item.textContent === "Mark thread unread")?.getAttribute("aria-disabled"))
    .toBe(expectedEnabled ? null : "true");
  const toggle = items.find(item => item.textContent === (expectedEnabled ? "Mute notifications" : "Unmute notifications"))!;
  await act(async () => toggle.click());
  expect(setNotifications).toHaveBeenCalledWith(1, !expectedEnabled);
});
