/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { UnreadThreads } from "./UnreadThreads";
import "../../styles.css";

vi.mock("./UnreadStateBridge", () => ({
  useUnreadState: () => ({ state: { revision: 1, unreadChatCount: 1, chats: [{
    workspaceId: "workspace", chatId: 1, chatTitle: "A long thread title that should truncate before the date",
    latestSequence: 2, readThroughSequence: 0, readEpoch: 0,
    latestMessagePreview: "The latest message should stay underneath the thread title.",
    latestActivityAt: new Date("2026-10-13T12:00:00Z"),
  }] } }),
}));
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }));
const api = { openGadget: vi.fn<(workspaceId: string) => unknown>() };
let host: HTMLDivElement | undefined, root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

it("right-aligns the date above the unread badge at desktop and narrow widths", async () => {
  const base = createRootRoute({ component: UnreadThreads });
  const router = createRouter({ routeTree: base, history: createMemoryHistory({ initialEntries: ["/"] }) });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { await router.load(); root!.render(<RouterProvider router={router} />); });
  const rect = (element: Element) => element.getBoundingClientRect();
  for (const width of [832, 320]) {
    host.style.width = `${width}px`;
    const row = host.querySelector("ul a")!;
    const date = rect(row.querySelector("time")!);
    const badge = rect(row.querySelector('[aria-label="1 unread thread"]')!);
    const title = rect(row.querySelector("h2")!);
    const preview = rect(row.querySelector("p")!);
    expect(Math.abs(date.right - badge.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(date.top - title.top)).toBeLessThanOrEqual(1);
    expect(badge.top).toBeGreaterThanOrEqual(date.bottom + 4);
    expect(badge.top + badge.height / 2).toBeGreaterThan(rect(row).top + rect(row).height / 2);
    expect(Math.abs(badge.top + badge.height / 2 - preview.top - preview.height / 2)).toBeLessThanOrEqual(1);
    expect(title.right).toBeLessThan(date.left);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  }
  expect(api.openGadget).not.toHaveBeenCalled();
});
