/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, ChatReadState } from "@gadgets/workshop-shared/api";
import { UnreadStateBridge, useUnreadState } from "./UnreadStateBridge";
import "../../styles.css";

const chat: ChatReadState = {
  workspaceId: "workspace",
  chatId: 1,
  chatTitle: "Thread",
  latestSequence: 2,
  readThroughSequence: 0,
  unreadMessageCount: 1,
};

const Workspace = () => {
  const unread = useUnreadState()!;
  return (
    <main className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <button onClick={() => void unread.markRead(chat).catch(() => {})}>Mark read</button>
      </div>
      <textarea aria-label="Message" className="shrink-0" />
    </main>
  );
};

let host: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

it.each([1000, 360])("keeps the composer inside a %ipx viewport after a read failure", async (width) => {
  using _ = vi.spyOn(console, "error").mockImplementation(() => {});
  const markChatRead = vi.fn<AuthenticatedApi["markChatRead"]>()
    .mockRejectedValueOnce(new Error("read failed"))
    .mockResolvedValue(undefined);
  const api = {
    markChatRead,
    subscribeToUnreadState: () => Object.assign(Promise.resolve(), { [Symbol.dispose]() {} }),
  };
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(
    <div className="flex flex-col overflow-hidden" style={{ width, height: 320 }}>
      {/* The router host is a block, while its routed workspace fills its height. */}
      <div className="h-full min-h-0 flex-1" data-viewport>
        <UnreadStateBridge authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}>
          <Workspace />
        </UnreadStateBridge>
      </div>
    </div>,
  ));

  const viewport = host.querySelector("[data-viewport]")!;
  const composer = host.querySelector("textarea")!;
  const initialHeight = host.querySelector("main")!.getBoundingClientRect().height;
  const expectComposerVisible = () => {
    const bounds = composer.getBoundingClientRect();
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    expect(bounds.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
  };
  expectComposerVisible();

  await act(async () => userEvent.click(page.getByRole("button", { name: "Mark read" })));
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Couldn’t update read state");
  expectComposerVisible();
  expect(host.querySelector("main")!.getBoundingClientRect().height).toBeLessThan(initialHeight);

  await act(async () => userEvent.click(page.getByRole("button", { name: "Dismiss" })));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("main")!.getBoundingClientRect().height).toBe(initialHeight);
  expectComposerVisible();

  markChatRead.mockRejectedValueOnce(new Error("read failed again"));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Mark read" })));
  await expect.element(page.getByRole("alert")).toBeVisible();
  await act(async () => userEvent.click(page.getByRole("button", { name: "Mark read" })));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("main")!.getBoundingClientRect().height).toBe(initialHeight);
  expectComposerVisible();
});
