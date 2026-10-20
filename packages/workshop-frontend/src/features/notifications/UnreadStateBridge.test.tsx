// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { UnreadStateBridge, useUnreadState } from "./UnreadStateBridge";
import { reportVisibleChat } from "./visibleChat";

const snapshot = (sequence: number): UserUnreadState => ({
  unreadChatCount: 1, unreadMessageCount: 1,
  chats: [
    {
      workspaceId: "workspace-1",
      chatId: 1,
      chatTitle: "Demo",
      unreadMessageCount: 1,
      latestSequence: sequence,
      readThroughSequence: -1,
      readToken: "token",
    },
  ],
});
const visibility = (value: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const Commands = () => {
  const unread = useUnreadState();
  const chat = unread?.state?.chats[0];
  return (
    <>
      <output>{JSON.stringify(unread?.state ?? null)}</output>
      {chat && unread && <>
      <button onClick={() => void unread.markRead(chat).catch(() => {})}>read</button>
      <button onClick={() => void unread.markUnread(chat, chat.latestSequence)}>unread</button>
      <button onClick={() => void unread.markManyRead(unread.state!.chats)}>all</button>
      </>}
    </>
  );
};

describe("UnreadStateBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let subscribers: RpcStub<UnreadStateSubscriber>[];
  let withdraw: (() => void) | undefined;
  const currentState = () => JSON.parse(container.querySelector("output")!.textContent!);
  const dispose = vi.fn<() => void>();
  const markChatRead = vi.fn<AuthenticatedApi["markChatRead"]>().mockResolvedValue(undefined);
  const subscribeToUnreadState = vi.fn<
    (subscriber: RpcStub<UnreadStateSubscriber>) => Promise<void> & Disposable
  >((subscriber) => {
    subscribers.push(subscriber);
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: dispose });
  });
  const markChatsRead = vi.fn<AuthenticatedApi["markChatsRead"]>().mockResolvedValue(undefined);
  const markChatUnread = vi.fn<AuthenticatedApi["markChatUnread"]>().mockResolvedValue(undefined);
  const api = { subscribeToUnreadState, markChatRead, markChatsRead, markChatUnread };
  const render = (authenticatedApi = api) =>
    act(async () =>
      root.render(
        <UnreadStateBridge
          authenticatedApi={authenticatedApi as unknown as RpcStub<AuthenticatedApi>}
        >
          <Commands />
        </UnreadStateBridge>,
      ),
    );
  const update = (state: UserUnreadState, index = subscribers.length - 1) =>
    act(() => subscribers[index].updated(state));

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers = [];
    visibility("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    withdraw?.();
    withdraw = undefined;
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("releases hidden subscriptions so callbacks do not pin the User DO, then refreshes on return", async () => {
    withdraw = reportVisibleChat(() => ({ workspaceId: "workspace-1", chatId: 1 }));
    await render();
    await update(snapshot(1));
    expect(currentState()).toEqual(snapshot(1));
    await act(async () => visibility("hidden"));
    expect(markChatRead).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    await act(async () => visibility("visible"));
    expect(markChatRead).not.toHaveBeenCalled();
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
  });

  it("exposes explicit read/unread and bulk commands using the observed horizon", async () => {
    await render();
    await update(snapshot(4));
    const click = async (name: string) =>
      act(async () => {
        const button = [...container.querySelectorAll("button")].find(
          (item) => item.textContent === name,
        );
        button?.click();
      });
    await click("read");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-1",
      chatId: 1,
      throughSequence: 4,
      readThroughSequence: -1,
      readToken: "token",
    });
    await click("unread");
    expect(markChatUnread).toHaveBeenCalledExactlyOnceWith("workspace-1", 1, 4, -1, "token");
    await click("all");
    expect(markChatsRead).toHaveBeenCalledWith([
      {
        workspaceId: "workspace-1",
        chatId: 1,
        throughSequence: 4,
        readThroughSequence: -1,
        readToken: "token",
      },
    ]);
  });

  it("merges a thread delta and its authoritative totals", async () => {
    await render();
    await update(snapshot(3));
    await act(() => subscribers[0].chatUpdated("workspace-1", 1, null,
      {unreadChatCount: 0, unreadMessageCount: 0}));
    expect(currentState()).toEqual({unreadChatCount: 0, unreadMessageCount: 0, chats: []});
  });

  it("re-subscribes after a User DO reset while visible, but not after unmount", async () => {
    await render();
    await update(snapshot(9));
    await act(async () => subscribers[0][Symbol.dispose]());
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
    await update(snapshot(2));
    expect(currentState()).toEqual(snapshot(2));
    await act(async () => root.unmount());
    await update(snapshot(3));
    expect(container.textContent).toBe("");
    await act(async () => subscribers[1][Symbol.dispose]());
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });

  it("keeps healthy state live and retries missing workspaces", async () => {
    vi.useFakeTimers();
    await render();
    await update(snapshot(1));
    await update({...snapshot(2), unavailableWorkspaceIds: ["workspace-2"]});
    expect(container.querySelector('[role="status"]')?.textContent).toContain("unread counts are unavailable");
    expect(container.querySelector("button")?.textContent).toBe("read");
    expect(currentState()).toEqual({...snapshot(2), unavailableWorkspaceIds: ["workspace-2"]});
    await update({...snapshot(3), unavailableWorkspaceIds: ["workspace-2"]});
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
    await update(snapshot(1)); // Fresh snapshot after reconnect.
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(currentState()).toEqual(snapshot(1));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected subscription in a tight loop", async () => {
    vi.useFakeTimers();
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribeToUnreadState.mockImplementationOnce((subscriber) => {
      subscribers.push(subscriber);
      return Object.assign(Promise.reject(new Error("not supported")), {
        [Symbol.dispose]: dispose,
      });
    });
    await render();
    await act(async () => subscribers[0][Symbol.dispose]());
    expect(subscribeToUnreadState).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(subscribeToUnreadState).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
    await update(snapshot(1));
    expect(currentState()).toEqual(snapshot(1));
  });

  it("recovers when the subscriber is released before the subscribe ACK arrives", async () => {
    const ack = deferred();
    subscribeToUnreadState.mockImplementationOnce((subscriber) => {
      subscribers.push(subscriber);
      return Object.assign(ack.promise, { [Symbol.dispose]: dispose });
    });
    await render();
    await act(async () => subscribers[0][Symbol.dispose]());
    expect(subscribeToUnreadState).toHaveBeenCalledOnce();
    await act(async () => ack.resolve());
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
    await update(snapshot(1));
    expect(currentState()).toEqual(snapshot(1));
  });

  it("reports failed read commands without leaking an old account's failure into its replacement", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = deferred();
    markChatRead.mockReturnValueOnce(failed.promise);
    await render();
    await update(snapshot(1));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => failed.reject(new Error("read failed")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t update read state",
    );
    await render({ ...api });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await update(snapshot(1));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
