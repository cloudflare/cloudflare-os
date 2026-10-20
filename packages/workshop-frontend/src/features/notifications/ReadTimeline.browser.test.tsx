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
import { timelineReadRanges } from "./timelineReadRanges";

let root: Root | undefined, host: HTMLDivElement | undefined;
let withdraw: (() => void) | undefined;
const navigate = vi.fn<(pending: boolean) => void>();
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
        onUnreadNavigation={navigate}
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
  navigate.mockClear();
  let subscriber: RpcStub<UnreadStateSubscriber> | undefined;
  let state: UserUnreadState = {

    unreadChatCount: 1, unreadMessageCount: 1,
    chats: [
      {
        workspaceId: "workspace",
        chatId: 1,
        chatTitle: "Browser timeline",
        latestSequence: 2,
        readThroughSequence: -1,
        unreadMessageCount: 1,
      },
    ],
  };
  const markChatRead = vi.fn<AuthenticatedApi["markChatRead"]>(async (receipt) => {
    state = {
      ...state,

      unreadChatCount: receipt.throughSequence === 2 ? 0 : 1, unreadMessageCount: receipt.throughSequence === 2 ? 0 : 1,
      chats: [{ ...state.chats[0], readThroughSequence: receipt.throughSequence }],
    };
    await subscriber!.updated(state);
  });
  const markChatUnread = vi.fn<AuthenticatedApi["markChatUnread"]>(
    async (_workspace, _chat, from) => {
      state = {
        ...state,

        unreadChatCount: 1, unreadMessageCount: 1,
        chats: [{ ...state.chats[0], readThroughSequence: from - 1, unreadMessageCount: 1, }],
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
      readThroughSequence: -1,
    }),
  );

  // The first item's actions are now visible at the viewport edge. Open them as a real pointer user.
  const firstActions = page.getByRole("button", { name: "Read actions for this item" }).nth(0);
  await act(async () => userEvent.click(firstActions));
  const beforeUnread = marker.getBoundingClientRect().bottom;
  navigate.mockClear();
  await act(async () =>
    userEvent.click(page.getByRole("menuitem", { name: "Mark unread from here" })),
  );
  expect(markChatUnread).toHaveBeenCalledExactlyOnceWith("workspace", 1, 0, 0);
  await expect.element(page.getByText(/automatic reading paused/)).toBeVisible();
  const calls = markChatRead.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(markChatRead).toHaveBeenCalledTimes(calls);
  expect(Math.abs(marker.getBoundingClientRect().bottom - beforeUnread)).toBeLessThan(1);
  expect(navigate).not.toHaveBeenCalled();

  withdraw();
  await render(<p>Conversation list</p>);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(markChatRead).toHaveBeenCalledTimes(calls);

  // Returning starts a fresh visit at the same durable unread boundary, without acknowledging
  // anything until its bottom edge is actually visible.
  await render(<View />);
  withdraw = reportVisibleChat(() => ({ workspaceId: "workspace", chatId: 1 }));
  await act(async () => userEvent.click(page.getByRole("button", { name: "Focus chat" })));
  await expect.element(page.getByText(/Unread activity/)).toBeVisible();
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
      readThroughSequence: -1,
    }),
  );
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const observedHorizon = state.chats[0].readThroughSequence;
  await act(async () => userEvent.click(page.getByRole("button", { name: "Mark thread read" })));
  expect(markChatRead).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    chatId: 1,
    throughSequence: 2,
    readThroughSequence: observedHorizon,
  });
});

it.each([false, true])("completes unread navigation with real scroll geometry (short history: %s)", async short => {
  navigate.mockClear();
  const markChatRead = vi.fn<AuthenticatedApi["markChatRead"]>().mockResolvedValue(undefined);
  const state: UserUnreadState = {unreadChatCount: 1, unreadMessageCount: 1,
    chats: [{workspaceId: "workspace", chatId: 1, chatTitle: "Navigation", latestSequence: short ? 0 : 3,
      readThroughSequence: short ? -1 : 0, unreadMessageCount: 1}]};
  const api = {
    markChatRead,
    subscribeToUnreadState: (subscriber: RpcStub<UnreadStateSubscriber>) => {
      void subscriber.updated(state);
      return Object.assign(Promise.resolve(), {[Symbol.dispose]: () => {}});
    },
  };
  const messages = [
    {sequence: 0, type: "message" as const, message: "Previously read"},
    {sequence: 1, type: "action" as const, actionId: 1},
    {sequence: 2, type: "changes" as const},
    {sequence: 3, type: "message" as const, message: "New text"},
  ].map(body => ({chatId: 1, timestamp: new Date(), author: {type: "agent" as const, id: "test", name: "Test"}, ...body}));
  const ranges = timelineReadRanges(short ? [0] : [0, 3], short ? messages.slice(0, 1) : messages);
  const View = () => {
    const viewport = useRef<HTMLDivElement>(null);
    return <div ref={viewport} data-viewport style={{height: 220, width: 440, overflowY: "auto"}}>
      <ReadTimeline workspaceId="workspace" chatId={1} container={viewport} oldestSequence={0}
        loadingEarlier={false} loadEarlier={async () => {}} onUnreadNavigation={navigate} className="">
        {ranges.map(range => range && <TimelineReadItem key={range.start} {...range}>
          <div style={{height: short ? 20 : 300}}>Message {range.start}<button>Focus chat</button></div>
        </TimelineReadItem>)}
      </ReadTimeline>
    </div>;
  };
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(
    <UnreadStateBridge authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}><View /></UnreadStateBridge>,
  ));
  await vi.waitFor(() => expect(navigate).toHaveBeenLastCalledWith(false));
  expect(navigate).toHaveBeenCalledWith(true);
  const viewport = host.querySelector<HTMLElement>("[data-viewport]")!;
  const divider = host.querySelector("[data-unread-divider]")!;
  expect(divider.closest<HTMLElement>("[data-read-start]")!.dataset.readStart).toBe(short ? "0" : "3");
  expect(viewport.scrollTop > 0).toBe(!short);
  expect(viewport.scrollHeight <= viewport.clientHeight).toBe(short);
  const item = divider.closest<HTMLElement>("[data-read-start]")!;
  expect(Math.abs(item.getBoundingClientRect().top - viewport.getBoundingClientRect().top))
    .toBeLessThan(short ? viewport.clientHeight : 1);
});
