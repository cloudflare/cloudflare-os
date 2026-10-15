/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Chats } from "@phosphor-icons/react";
import SidebarGadgetRow from "./SidebarGadgetRow";
import SidebarItem from "./SidebarItem";
import { UnreadBadge } from "../../features/notifications/UnreadBadge";
import type { useUnreadState } from "../../features/notifications/UnreadStateBridge";
import "../../styles.css";

const mock = vi.hoisted(() => ({
  markManyRead: vi.fn<NonNullable<ReturnType<typeof useUnreadState>>["markManyRead"]>()
    .mockResolvedValue(undefined),
}));
const chat = { workspaceId: "workspace", chatId: 1, chatTitle: "Thread", latestSequence: 2,
  readThroughSequence: 0, readEpoch: 0 };
vi.mock("../../features/notifications/UnreadStateBridge", () => ({
  useUnreadState: () => ({ state: { chats: [chat] }, markManyRead: mock.markManyRead }),
}));
let host: HTMLDivElement | undefined, root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

it("gives workspace rows the nav width without reserving separate badge/action columns", async () => {
  const title = "A long workspace title that needs all the available row width";
  const base = createRootRoute({ component: () => (
    <div className="w-[260px]">
      <nav className="flex flex-col px-2">
        <SidebarItem to="/" label="Unread threads" icon={<Chats size={14} />}
          trailing={<UnreadBadge count={1} />} />
      </nav>
      <div className="flex flex-col px-2">
        <SidebarGadgetRow gadget={{ id: "workspace", title, created: new Date(), lastActive: new Date() }} onTogglePin={() => {}}
          onRename={() => {}} onShare={() => {}} onDelete={() => {}} />
      </div>
    </div>
  ) });
  const router = createRouter({ routeTree: base, history: createMemoryHistory({ initialEntries: ["/"] }) });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { await router.load(); root!.render(<RouterProvider router={router} />); });
  const [nav, workspace] = host.querySelectorAll<HTMLAnchorElement>("a");
  const rect = (element: Element) => element.getBoundingClientRect();
  expect(rect(workspace).width).toBe(rect(nav).width);
  const navBadge = nav.querySelector('[aria-label="1 unread thread"]')!;
  const workspaceBadge = workspace.querySelector('[aria-label="1 unread thread"]')!;
  expect(Math.abs(rect(navBadge).right - rect(workspaceBadge).right)).toBeLessThanOrEqual(2);
  expect(rect(workspace.querySelector(".truncate")!).width).toBeGreaterThanOrEqual(160);

  await act(async () => userEvent.click(page.getByRole("button", { name: "Workspace actions" })));
  await expect.element(page.getByRole("menuitem", { name: "Mark workspace read" })).toBeVisible();
  expect(router.state.location.pathname).toBe("/");
  await act(async () => userEvent.click(page.getByRole("menuitem", { name: "Mark workspace read" })));
  expect(mock.markManyRead).toHaveBeenCalledExactlyOnceWith([chat]);
});
