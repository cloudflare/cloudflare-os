// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { UnreadStateBridge, useUnreadState } from "./UnreadStateBridge";

const addToast = vi.fn<(toast: object) => void>();
vi.mock("@cloudflare/kumo", () => ({ useKumoToastManager: () => ({ add: addToast }) }));

const snapshot = (sequence: number): UserUnreadState => ({
  workspaces: [{workspaceId: "workspace-1", unreadChatCount: 1, unreadMessageCount: sequence}],
  unreadChatCount: 1, unreadMessageCount: sequence,
  chats: [
    {
      workspaceId: "workspace-1",
      chatId: 1,

      unreadMessageCount: sequence,

      readThroughSequence: -1,
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

const Commands = ({overseer}: {overseer: Pick<Overseer, "markChatRead" | "markChatUnread">}) => {
  const unread = useUnreadState();
  const chat = unread?.state?.chats[0];
  return (
    <>
      <output>{JSON.stringify(unread?.state ?? null)}</output>
      {chat && unread && <>
      <button onClick={() => void unread.markRead(overseer, chat.chatId).catch(() => {})}>read</button>
      <button onClick={() => void unread.markUnread(overseer, chat.chatId)}>unread</button>
      <button onClick={() => void unread.markAllRead().catch(() => {})}>all</button>
      </>}
    </>
  );
};

describe("UnreadStateBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let subscribers: RpcStub<UnreadStateSubscriber>[];
  const currentState = () => JSON.parse(container.querySelector("output")!.textContent!);
  const dispose = vi.fn<() => void>();
  const markChatRead = vi.fn<Overseer["markChatRead"]>().mockResolvedValue(undefined);
  const subscribeToUnreadState = vi.fn<
    (_scope: unknown, subscriber: RpcStub<UnreadStateSubscriber>) => Promise<void> & Disposable
  >((_scope, subscriber) => {
    subscribers.push(subscriber);
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: dispose });
  });
  const markAllRead = vi.fn<AuthenticatedApi["markAllRead"]>().mockResolvedValue(undefined);
  const markChatUnread = vi.fn<Overseer["markChatUnread"]>().mockResolvedValue(true);
  const markWorkspaceRead = vi.fn<AuthenticatedApi["markWorkspaceRead"]>().mockResolvedValue(undefined);
  const overseer = {markChatRead, markChatUnread};
  const api = { subscribeToUnreadState, markAllRead, markWorkspaceRead };
  const render = (authenticatedApi = api, scope: Parameters<AuthenticatedApi["subscribeToUnreadState"]>[0] = {workspaceId: "workspace-1"}) =>
    act(async () =>
      root.render(
        <UnreadStateBridge scope={scope}
          authenticatedApi={authenticatedApi as unknown as RpcStub<AuthenticatedApi>}
        >
          <Commands overseer={overseer} />
        </UnreadStateBridge>,
      ),
    );
  const update = (state: UserUnreadState, index = subscribers.length - 1) =>
    act(() => subscribers[index].updated(state));

  beforeEach(() => {
    vi.clearAllMocks();
    subscribers = [];
    visibility("visible");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("releases hidden subscriptions so callbacks do not pin the User DO, then refreshes on return", async () => {
    await render();
    await update(snapshot(1));
    expect(currentState()).toEqual(snapshot(1));
    await act(async () => visibility("hidden"));
    expect(dispose).toHaveBeenCalledOnce();
    await act(async () => visibility("visible"));
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
  });

  it("exposes explicit read/unread and bulk commands using only the requested boundaries", async () => {
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, undefined);
    await click("unread");
    expect(markChatUnread).toHaveBeenCalledExactlyOnceWith(1, undefined);
    await click("all");
    expect(markAllRead).toHaveBeenCalledExactlyOnceWith();
  });

  it("merges a thread delta and its authoritative totals", async () => {
    await render();
    await update(snapshot(3));
    await act(() => subscribers[0].chatUpdated("workspace-1", 1, null,
      {unreadChatCount: 0, unreadMessageCount: 0, workspace: {workspaceId: "workspace-1", unreadChatCount: 0, unreadMessageCount: 0}}));
    expect(currentState()).toEqual({unreadChatCount: 0, unreadMessageCount: 0, workspaces: [], chats: []});
  });

  it("switches scopes without showing old workspace rows or accepting late callbacks", async () => {
    await render();
    await update(snapshot(1));
    expect(subscribeToUnreadState.mock.calls[0][0]).toEqual({workspaceId: "workspace-1"});
    await render(api, "summary");
    expect(dispose).toHaveBeenCalledOnce();
    expect(currentState()).toBeNull();
    await update(snapshot(1), 0);
    expect(currentState()).toBeNull();
    await update({unreadChatCount: 0, unreadMessageCount: 0, workspaces: [], chats: []});
    const workspaces = [{workspaceId: "workspace-2", unreadChatCount: 1, unreadMessageCount: 3}];
    await act(() => subscribers.at(-1)!.summaryUpdated({workspace: workspaces[0], unreadChatCount: 1, unreadMessageCount: 3}));
    expect(currentState()).toEqual({chats: [], workspaces, unreadChatCount: 1, unreadMessageCount: 3});
    await render(api, "unread");
    expect(subscribeToUnreadState.mock.calls.at(-1)?.[0]).toBe("unread");
  });

  it("merges an out-of-scope badge delta without replacing scoped rows or unrelated workspace counts", async () => {
    await render(); await update(snapshot(1));
    await act(() => subscribers[0].summaryUpdated({unreadChatCount: 2, unreadMessageCount: 4,
      workspace: {workspaceId: "workspace-2", unreadChatCount: 1, unreadMessageCount: 3}}));
    expect(currentState()).toEqual({...snapshot(1), unreadChatCount: 2, unreadMessageCount: 4,
      workspaces: [...snapshot(1).workspaces, {workspaceId: "workspace-2", unreadChatCount: 1, unreadMessageCount: 3}]});
    await act(() => subscribers[0].summaryUpdated({unreadChatCount: 1, unreadMessageCount: 1,
      workspace: {workspaceId: "workspace-2", unreadChatCount: 0, unreadMessageCount: 0}}));
    expect(currentState()).toEqual(snapshot(1));
  });

  it("marks a workspace read with a single local user command", async () => {
    const WorkspaceCommand = () => {
      const unread = useUnreadState()!;
      return <button onClick={() => void unread.markWorkspaceRead("workspace-1")}>workspace read</button>;
    };
    await act(async () => root.render(
      <UnreadStateBridge scope="summary" authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}>
        <WorkspaceCommand />
      </UnreadStateBridge>,
    ));
    await update({...snapshot(1), chats: []});
    await act(async () => container.querySelector("button")!.click());
    expect(markWorkspaceRead).toHaveBeenCalledExactlyOnceWith("workspace-1");
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

  it("does not retry a rejected subscription in a tight loop", async () => {
    vi.useFakeTimers();
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    subscribeToUnreadState.mockImplementationOnce((_scope, subscriber) => {
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
    subscribeToUnreadState.mockImplementationOnce((_scope, subscriber) => {
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

  it("shows one deduplicated error toast without a later receipt clearing it", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    markChatRead.mockRejectedValueOnce(new Error("read failed"));
    await render(); await update(snapshot(1));
    await act(async () => container.querySelector("button")!.click());
    expect(addToast).toHaveBeenCalledExactlyOnceWith({
      id: "unread-update-failed", title: "Couldn’t update read state", variant: "error",
    });
    await act(async () => container.querySelector("button")!.click());
    expect(addToast).toHaveBeenCalledOnce();
  });

  it("ignores late command failures after switching accounts", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = deferred();
    markChatRead.mockReturnValueOnce(failed.promise);
    await render(); await update(snapshot(1));
    await act(async () => container.querySelector("button")!.click());
    await render({ ...api });
    await act(async () => failed.reject(new Error("read failed")));
    expect(addToast).not.toHaveBeenCalled();
  });
});
