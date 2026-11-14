// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { AiChatMetadata, Overseer } from "@gadgets/workshop-shared/api";
import type { useUnreadState } from "./features/notifications/UnreadStateBridge";
import { makeOverseer, makeTestRoot } from "./action-test-harness";
import ChatInterface from "./ChatInterface";

const mock = vi.hoisted(() => ({unread: null as ReturnType<typeof useUnreadState>}));
vi.mock("./features/notifications/UnreadStateBridge", async importOriginal => ({
  ...await importOriginal<typeof import("./features/notifications/UnreadStateBridge")>(),
  useUnreadState: () => mock.unread,
}));
vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({currentUser: null}),
  useOptionalAuthenticatedApi: () => null,
}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const testRoot = makeTestRoot();
const scrolling = (["scrollIntoView", "scrollTo"] as const).map(name => {
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, name);
  Object.defineProperty(Element.prototype, name, {configurable: true, value: () => {}});
  return {name, previous};
});
afterAll(() => {
  for (const {name, previous} of scrolling) {
    if (previous) Object.defineProperty(Element.prototype, name, previous);
    else Reflect.deleteProperty(Element.prototype, name);
  }
});
const showSpawnedChat = async () => {
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.startsWith(label))!;
  await act(async () => button("Agents").click());
  await act(async () => button("Spawner").click());
};
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

// Private read state takes precedence over the source policy, including explicit mutes.
it.each([
  {spawned: false, enabled: undefined, override: undefined, expectedEnabled: true},
  {spawned: true, enabled: undefined, override: undefined, expectedEnabled: true},
  {spawned: true, enabled: true, override: true, expectedEnabled: true},
  {spawned: false, enabled: false, override: false, expectedEnabled: false},
  {spawned: false, enabled: true, override: true, expectedEnabled: true},
  {spawned: true, enabled: false, override: false, expectedEnabled: false},
  {spawned: false, enabled: false, override: undefined, expectedEnabled: false},
  {spawned: true, enabled: false, override: undefined, expectedEnabled: false},
].flatMap(preference => [0, 2].map(count => ({...preference, count}))))(
    "changes notifications without disabling read actions (spawned: $spawned, enabled: $enabled, override: $override, unread: $count)",
    async ({spawned, enabled, override, expectedEnabled, count}) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  const setNotifications = vi.fn<Overseer["setChatNotificationsEnabled"]>().mockResolvedValue(undefined);
  const chat: AiChatMetadata = {id: 1, title: "Notification test", started: new Date(), lastActive: new Date(),
    notificationsRequireParticipation: enabled === undefined ? undefined : true, ...(spawned ? {spawnerName: "Spawner"} : {})};
  Object.assign(server.overseer, {
    listChats: async () => [chat], listModels: async () => [], onRpcBroken: () => {},
    subscribeToChat: () => ({[Symbol.dispose]: () => {}}),
    setChatNotificationsEnabled: setNotifications,
  });
  mock.unread = {
    chats: [{workspaceId: "workspace", chatId: 1, readThroughSequence: 0, unreadMessageCount: count,
      notificationsEnabled: enabled, notificationsEnabledOverride: override}],
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
  if (spawned) await showSpawnedChat();
  expect(document.querySelector('[aria-label="2 unread messages"]') !== null).toBe(expectedEnabled && count > 0);
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for Notification test"]')!;
  await act(async () => trigger.click());
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.find(item => item.textContent === "Mark thread unread")?.getAttribute("aria-disabled"))
    .toBe(count > 0 ? "true" : null);
  expect(items.find(item => item.textContent === "Mark thread read")?.getAttribute("aria-disabled"))
    .toBe(count > 0 ? null : "true");
  const canMute = expectedEnabled || override !== false;
  expect(items.some(item => item.textContent === "Enable notifications")).toBe(!expectedEnabled && override !== false);
  expect(items.some(item => item.textContent === "Mute notifications")).toBe(canMute);
  const toggle = items.find(item => item.textContent === (canMute ? "Mute notifications" : "Unmute notifications"))!;
  await act(async () => toggle.click());
  expect(setNotifications).toHaveBeenCalledExactlyOnceWith(1, !canMute);
});

it.each([false, true].flatMap(spawned => [undefined, true].map(requiresParticipation => ({spawned, requiresParticipation}))))(
    "shows the source default before unread enrollment (spawned: $spawned, participation: $requiresParticipation)",
    async ({spawned, requiresParticipation}) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const server = makeOverseer();
  const setNotifications = vi.fn<Overseer["setChatNotificationsEnabled"]>().mockResolvedValue(undefined);
  const chat: AiChatMetadata = {id: 1, title: "Empty chat", started: new Date(), lastActive: new Date(),
    notificationsRequireParticipation: requiresParticipation, ...(spawned ? {spawnerName: "Spawner"} : {})};
  Object.assign(server.overseer, {
    listChats: async () => [chat], listModels: async () => [], onRpcBroken: () => {},
    subscribeToChat: () => ({[Symbol.dispose]: () => {}}), setChatNotificationsEnabled: setNotifications,
  });
  mock.unread = {
    chats: [], subscribeToUpdates: () => () => {}, markRead: async () => {}, markUnread: async () => true,
    markAllRead: async () => {}, markWorkspaceRead: async () => {},
  };
  await testRoot.render(
    <ChatInterface workspaceId="workspace" overseer={server.overseer}
      selectedChatId={null} onNavigateToChat={() => {}}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ""} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
  );
  if (spawned) await showSpawnedChat();
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for Empty chat"]')!;
  await act(async () => trigger.click());
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.some(item => item.textContent === "Enable notifications")).toBe(requiresParticipation === true);
  const action = items.find(item => item.textContent === (requiresParticipation ? "Enable notifications" : "Mute notifications"))!;
  await act(async () => action.click());
  expect(setNotifications).toHaveBeenCalledExactlyOnceWith(1, requiresParticipation === true);
});
