/* eslint-disable react/react-in-jsx-scope */
import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { ReadTimeline } from "./ReadTimeline";
import { TimelineReadItem } from "./TimelineReadItem";
import { UnreadStateBridge } from "./UnreadStateBridge";
import { reportVisibleChat } from "./visibleChat";

let root: Root | undefined, host: HTMLDivElement | undefined;
let withdraw: (() => void) | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  withdraw?.();
});

const View = () => {
  const viewport = useRef<HTMLDivElement>(null);
  return (
    <div ref={viewport} data-viewport style={{ height: 220, width: 440, overflowY: "auto" }}>
      <ReadTimeline
        workspaceId="workspace"
        chatId={1}
        container={viewport}
        oldestSequence={0}
        loadingEarlier={false}
        loadEarlier={async () => {}}
        onUnreadNavigation={() => {}}
        className=""
      >
        {[0, 1, 2].map((sequence) => (
          <TimelineReadItem key={sequence} start={sequence} end={sequence}>
            <div style={{ height: 300 }}>
              Item {sequence}
              {sequence === 0 && <button>Focus chat</button>}
            </div>
          </TimelineReadItem>
        ))}
      </ReadTimeline>
    </div>
  );
};

it("keeps manual unread for the visit, then resumes viewport reading after leaving and returning", async () => {
  let subscriber: RpcStub<UnreadStateSubscriber> | undefined;
  let state: UserUnreadState = {
    revision: 1,
    unreadChatCount: 1,
    chats: [
      {
        workspaceId: "workspace",
        chatId: 1,
        chatTitle: "Browser timeline",
        latestSequence: 2,
        readThroughSequence: -1,
        readEpoch: 0,
      },
    ],
  };
  const markChatRead = vi.fn<AuthenticatedApi["markChatRead"]>(async (receipt) => {
    state = {
      ...state,
      revision: state.revision + 1,
      unreadChatCount: receipt.throughSequence === 2 ? 0 : 1,
      chats: [{ ...state.chats[0], readThroughSequence: receipt.throughSequence }],
    };
    await subscriber!.updated(state);
  });
  const markChatUnread = vi.fn<AuthenticatedApi["markChatUnread"]>(
    async (_workspace, _chat, from) => {
      state = {
        ...state,
        revision: state.revision + 1,
        unreadChatCount: 1,
        chats: [{ ...state.chats[0], readThroughSequence: from - 1, readEpoch: 1 }],
      };
      await subscriber!.updated(state);
    },
  );
  const api = {
    markChatRead,
    markChatUnread,
    markChatsRead: async () => {},
    subscribeToUnreadState: (next: RpcStub<UnreadStateSubscriber>) => {
      subscriber = next;
      void next.updated(state);
      return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} });
    },
  };
  withdraw = reportVisibleChat(() => ({ workspaceId: "workspace", chatId: 1 }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = (child: ReactNode) => act(async () =>
    root!.render(
      <UnreadStateBridge authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}>
        {child}
      </UnreadStateBridge>,
    ),
  );
  await render(<View />);
  await act(async () => userEvent.click(page.getByRole("button", { name: "Focus chat" })));
  expect(document.hasFocus()).toBe(true);
  expect(markChatRead).not.toHaveBeenCalled(); // The item's bottom is still below the viewport.
  const viewport = host.querySelector<HTMLElement>("[data-viewport]")!;
  const marker = host.querySelector<HTMLElement>('[data-read-through="0"]')!;
  await act(async () => {
    viewport.scrollTop +=
      marker.getBoundingClientRect().bottom -
      viewport.getBoundingClientRect().top -
      viewport.clientHeight +
      20;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await vi.waitFor(() =>
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace",
      chatId: 1,
      throughSequence: 0,
      readEpoch: 0,
    }),
  );

  // The first item's actions are now visible at the viewport edge. Open them as a real pointer user.
  const firstActions = page.getByRole("button", { name: "Read actions for this item" }).nth(0);
  await act(async () => userEvent.click(firstActions));
  await act(async () =>
    userEvent.click(page.getByRole("menuitem", { name: "Mark unread from here" })),
  );
  expect(markChatUnread).toHaveBeenCalledExactlyOnceWith("workspace", 1, 0, 0);
  await expect.element(page.getByText(/automatic reading paused/)).toBeVisible();
  const calls = markChatRead.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(markChatRead).toHaveBeenCalledTimes(calls);

  withdraw();
  await render(<p>Conversation list</p>);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(markChatRead).toHaveBeenCalledTimes(calls);

  // Returning starts a fresh visit at the same durable unread boundary, without acknowledging
  // anything until its bottom edge is actually visible.
  await render(<View />);
  withdraw = reportVisibleChat(() => ({ workspaceId: "workspace", chatId: 1 }));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Focus chat" })));
  await expect.element(page.getByText("Unread activity")).toBeVisible();
  expect(host.textContent).not.toContain("automatic reading paused");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(markChatRead).toHaveBeenCalledTimes(calls);
  const returnedViewport = host.querySelector<HTMLElement>("[data-viewport]")!;
  const returnedMarker = host.querySelector<HTMLElement>('[data-read-through="0"]')!;
  await act(async () => {
    returnedViewport.scrollTop +=
      returnedMarker.getBoundingClientRect().bottom -
      returnedViewport.getBoundingClientRect().top -
      returnedViewport.clientHeight +
      20;
    returnedViewport.dispatchEvent(new Event("scroll"));
  });
  await vi.waitFor(() =>
    expect(markChatRead).toHaveBeenLastCalledWith({
      workspaceId: "workspace",
      chatId: 1,
      throughSequence: 0,
      readEpoch: 1,
    }),
  );
  await act(async () => userEvent.click(page.getByRole("button", { name: "Mark thread read" })));
  expect(markChatRead).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    chatId: 1,
    throughSequence: 2,
    readEpoch: 1,
  });
});
