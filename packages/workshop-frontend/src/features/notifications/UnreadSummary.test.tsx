// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { useUnreadState } from "./UnreadStateBridge";
import { UnreadSummary } from "./UnreadSummary";
import { UnreadThreads } from "./UnreadThreads";

type Unread = NonNullable<ReturnType<typeof useUnreadState>>;
const mock = vi.hoisted(() => ({
  unread: null as ReturnType<typeof useUnreadState>,
  openGadget: vi.fn<(workspaceId: string) => unknown>(),
  listeners: new Set<() => void>(),
}));
vi.mock("./UnreadStateBridge", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useUnreadState: () => useSyncExternalStore(listener => {
    mock.listeners.add(listener);
    return () => { mock.listeners.delete(listener); };
  }, () => mock.unread) };
});
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }));
const api = { openGadget: mock.openGadget };
let container: HTMLDivElement, root: Root;
const markManyRead = vi.fn<Unread["markManyRead"]>().mockResolvedValue(undefined);
const chats = [
  { workspaceId: "workspace-1", chatId: 3, chatTitle: "Unread elsewhere",
    latestSequence: 8, readThroughSequence: 2, readEpoch: 1,
    latestMessagePreview: "The deployment is ready.", latestActivityAt: new Date("2026-10-15T01:00:00Z") },
  { workspaceId: "workspace-2", chatId: 4, chatTitle: "Already read",
    latestSequence: 6, readThroughSequence: 6, readEpoch: 0,
    latestMessagePreview: "Old message", latestActivityAt: new Date("2026-10-14T01:00:00Z") },
];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal("scrollTo", vi.fn<() => void>());
  mock.unread = { state: { revision: 3, unreadChatCount: 1, chats }, markManyRead,
    markRead: vi.fn<Unread["markRead"]>().mockResolvedValue(undefined),
    markUnread: vi.fn<Unread["markUnread"]>().mockResolvedValue(undefined) };
  mock.openGadget.mockImplementation(() => ({ getMetadata: async () => ({}), [Symbol.dispose]: vi.fn<() => void>() }));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const render = async (collapsed = false) => {
  const base = createRootRoute({ component: () => <><UnreadSummary collapsed={collapsed} /><Outlet /></> });
  const inbox = createRoute({ getParentRoute: () => base, path: "/unread", component: UnreadThreads });
  const workspace = createRoute({ getParentRoute: () => base, path: "/workspace/$id", component: () => <p>Thread opened</p> });
  const router = createRouter({ routeTree: base.addChildren([inbox, workspace]),
    history: createMemoryHistory({ initialEntries: ["/unread"] }) });
  await act(async () => { await router.load(); root.render(<RouterProvider router={router} />); });
  return router;
};
const action = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;

it("uses a standard navigation link with a trailing unread count", async () => {
  await render();
  const nav = container.querySelector('a[href="/unread"]')!;
  expect(nav.textContent).toBe("Unread threads1");
  expect(nav.querySelector('[aria-label="1 unread thread"]')).not.toBeNull();
  expect(container.querySelector('[role="menu"]')).toBeNull();
});

it("lists previews of only unread threads and opens the exact conversation", async () => {
  const router = await render();
  expect(container.textContent).not.toContain("Already read");
  expect(container.textContent).toContain("The deployment is ready.");
  expect(markManyRead).not.toHaveBeenCalled();
  expect(mock.unread!.markRead).not.toHaveBeenCalled();
  const link = container.querySelector<HTMLAnchorElement>('ul a')!;
  await act(async () => link.click());
  expect(router.state.location.pathname).toBe("/workspace/workspace-1");
  expect(router.state.location.search).toEqual({ chat: 3, showChat: true });
});

it("orders threads by latest activity and updates when read state changes", async () => {
  mock.unread!.state!.chats = [...chats, { ...chats[0], chatId: 9, chatTitle: "Newest",
    latestActivityAt: new Date("2026-10-15T02:00:00Z") }];
  await render();
  expect([...container.querySelectorAll("ul h2")].map(item => item.textContent)).toEqual(["Newest", "Unread elsewhere"]);
  mock.unread = { ...mock.unread!, state: { revision: 4, unreadChatCount: 0, chats: [] } };
  await act(async () => mock.listeners.forEach(listener => listener()));
  expect(container.textContent).toContain("You’re all caught up");
});

it("marks only the currently observed unread boundaries read", async () => {
  await render();
  await act(async () => action("Mark all read").click());
  expect(markManyRead).toHaveBeenCalledExactlyOnceWith([chats[0]]);
});

it("distinguishes loading from an empty inbox and keeps collapsed navigation accessible", async () => {
  mock.unread!.state = undefined;
  await render(true);
  expect(container.textContent).toContain("Loading unread threads…");
  expect(container.textContent).not.toContain("You’re all caught up");
  expect(container.querySelector('a[title="Unread threads"]')).not.toBeNull();
});

it("refreshes missing legacy previews once per workspace without reading chats", async () => {
  mock.unread!.state!.chats = [{ ...chats[0], latestMessagePreview: undefined },
    { ...chats[0], chatId: 5, latestMessagePreview: undefined }];
  const dispose = vi.fn<() => void>();
  mock.openGadget.mockReturnValue({ getMetadata: async () => ({}), [Symbol.dispose]: dispose });
  await render();
  expect(mock.openGadget).toHaveBeenCalledExactlyOnceWith("workspace-1");
  expect(dispose).toHaveBeenCalledOnce();
  expect(mock.unread!.markRead).not.toHaveBeenCalled();
});

it("offers retry after preview hydration fails and releases the workspace capability", async () => {
  mock.unread!.state!.chats = [{ ...chats[0], latestMessagePreview: undefined }];
  const dispose = vi.fn<() => void>();
  mock.openGadget.mockReturnValue({ getMetadata: vi.fn<() => Promise<object>>().mockRejectedValue(new Error("offline")), [Symbol.dispose]: dispose });
  await render();
  expect(container.textContent).toContain("Preview unavailable");
  expect(dispose).toHaveBeenCalledOnce();
  mock.openGadget.mockReturnValue({ getMetadata: async () => ({}), [Symbol.dispose]: dispose });
  await act(async () => action("Retry previews").click());
  expect(mock.openGadget).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(2);
});

it("offers retry when workspace-open succeeds but the preview projection never arrives", async () => {
  mock.unread!.state!.chats = [{ ...chats[0], latestMessagePreview: undefined }];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await render();
  expect(container.textContent).toContain("Loading message preview…");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(container.textContent).toContain("Preview unavailable");
  await act(async () => action("Retry previews").click());
  expect(mock.openGadget).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Loading message preview…");
  mock.unread = { ...mock.unread!, state: { revision: 4, unreadChatCount: 1, chats: [chats[0]] } };
  await act(async () => mock.listeners.forEach(listener => listener()));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(container.textContent).toContain("The deployment is ready.");
  expect(container.textContent).not.toContain("Preview unavailable");
  expect(mock.unread!.markRead).not.toHaveBeenCalled();
});
