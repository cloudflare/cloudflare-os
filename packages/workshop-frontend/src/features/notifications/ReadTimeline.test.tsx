// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { UnreadStateBridge } from "./UnreadStateBridge";
import { ReadTimeline } from "./ReadTimeline";
import { TimelineReadItem } from "./TimelineReadItem";
import { reportVisibleChat } from "./visibleChat";
import { TimelineContext } from "./readTimelineContext";

const snapshot = (_update = 1, readThroughSequence = -1): UserUnreadState => ({
  workspaces: [],
  unreadChatCount: readThroughSequence < 2 ? 1 : 0, unreadMessageCount: readThroughSequence < 2 ? 1 : 0,
  chats: [
    {
      workspaceId: "workspace",
      chatId: 1,

      readThroughSequence,
      unreadMessageCount: Math.max(0, 2 - readThroughSequence),
    },
  ],
});

describe("timeline read/unread experience", () => {
  let container: HTMLDivElement, root: Root;
  let subscriber: RpcStub<UnreadStateSubscriber>;
  let withdraw: () => void;
  let visibleBottom = 150;
  let shown = true;
  const markChatRead = vi.fn<AuthenticatedApi["markChatRead"]>().mockResolvedValue(undefined);
  const markChatUnread = vi.fn<AuthenticatedApi["markChatUnread"]>().mockResolvedValue(undefined);
  const markChatsRead = vi.fn<AuthenticatedApi["markChatsRead"]>().mockResolvedValue(undefined);
  const dispose = vi.fn<() => void>();
  const subscribeToUnreadState = vi.fn<
    (_scope: unknown, value: RpcStub<UnreadStateSubscriber>) => Promise<void> & Disposable
  >((_scope, value) => {
    subscriber = value;
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: dispose });
  });
  const api = { subscribeToUnreadState, markChatRead, markChatUnread, markChatsRead };
  const loadEarlier = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const navigate = vi.fn<() => void>();

  const View = ({ oldest = 0, loadingEarlier = false, latestSequence = 2, sequences = [0, 1, 2] }: {
    oldest?: number; loadingEarlier?: boolean; latestSequence?: number; sequences?: number[];
  }) => {
    const viewport = useRef<HTMLDivElement>(null);
    return (
      <div ref={viewport} data-viewport>
        <ReadTimeline
          workspaceId="workspace"
          chatId={1}
          container={viewport} latestSequence={latestSequence}
          oldestSequence={oldest}
          loadingEarlier={loadingEarlier}
          loadEarlier={loadEarlier}
          onUnreadNavigation={navigate}
          className=""
        >
          {sequences
            .filter((sequence) => sequence >= oldest)
            .map((sequence) => (
              <TimelineReadItem key={sequence} start={sequence} end={sequence}>
                <p>Item {sequence}</p>
              </TimelineReadItem>
            ))}
        </ReadTimeline>
      </div>
    );
  };
  const render = (child = <View />) =>
    act(async () =>
      root.render(
        <UnreadStateBridge scope={{workspaceId: "workspace"}} authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}>
          {child}
        </UnreadStateBridge>,
      ),
    );
  const update = (state: UserUnreadState) => act(async () => subscriber.updated(state));
  const updateChat = (state: UserUnreadState) => act(async () => subscriber.chatUpdated("workspace", 1, state.chats[0], {
    unreadChatCount: state.unreadChatCount, unreadMessageCount: state.unreadMessageCount,
    workspace: {workspaceId: "workspace", unreadChatCount: state.unreadChatCount, unreadMessageCount: state.unreadMessageCount},
  }));
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
  };
  const markUnreadFrom = async (sequence: number) => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-read-start="${sequence}"] button`)!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    visibleBottom = 150;
    shown = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
      setTimeout(() => fn(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.hasAttribute("data-viewport"))
        return new DOMRect(0, 0, shown ? 400 : 0, shown ? visibleBottom : 0);
      if (this.dataset.readThrough !== undefined)
        return new DOMRect(0, Number(this.dataset.readThrough) * 100 + 100, 400, 1);
      if (this.dataset.unreadThrough !== undefined)
        return new DOMRect(0, Number(this.dataset.unreadThrough) * 100, 400, 100);
      return new DOMRect(0, 0, 400, 20);
    });
    withdraw = reportVisibleChat(() => ({ workspaceId: "workspace", chatId: 1 }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    withdraw();
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the unread line and acknowledges only persisted items visible in the focused viewport", async () => {
    await render();
    await update(snapshot());
    await settle();
    expect(container.querySelector('[role="separator"]')?.textContent).toContain("New");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace",
      chatId: 1,
      throughSequence: 0,
    });
    visibleBottom = 350;
    await act(async () =>
      container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")),
    );
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith({
      workspaceId: "workspace",
      chatId: 1,
      throughSequence: 2,
    });
  });

  it("can mark an untouched legacy thread unread without initializing it on open", async () => {
    await render();
    await update({chats: [], workspaces: [], unreadChatCount: 0, unreadMessageCount: 0});
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    const trigger = container.querySelector<HTMLButtonElement>('[data-read-start="1"] button')!;
    await act(async () => trigger.click());
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(markChatUnread).toHaveBeenCalledExactlyOnceWith("workspace", 1, 1);
    await settle();
    expect(viewport.scrollTop).toBe(40);
    await update(snapshot(1, 0));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
  });

  it("does not treat the first unread event on an already-open legacy thread as entry", async () => {
    await render();
    await update({chats: [], workspaces: [], unreadChatCount: 0, unreadMessageCount: 0});
    await settle();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    navigate.mockClear();
    await updateChat(snapshot(1, 0));
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
  });

  it.each([false, true])("preserves local unread navigation across an intervening arrival delta (ACK first: %s)", async ackFirst => {
    await render();
    await update(snapshot(1, 2));
    await settle();
    navigate.mockClear();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    const ack = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1);
    if (ackFirst) await act(async () => ack.resolve());
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(2, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    if (!ackFirst) await act(async () => ack.resolve());
    const rewind = snapshot(3, 0);
    await updateChat({...rewind, unreadMessageCount: 3,
      chats: [{...rewind.chats[0], unreadMessageCount: 3}]});
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a local rewind in place when its starting horizon was stale (ACK first: %s)", async ackFirst => {
    await render();
    await update(snapshot(1, 0));
    await settle();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    navigate.mockClear();
    const ack = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1);
    if (ackFirst) await act(async () => ack.resolve());
    // Another device advanced the server before this command ran. Its delta and our
    // real rewind echo arrive after the ACK, despite the unchanged cached boundary.
    await updateChat(snapshot(2, 2));
    if (!ackFirst) await act(async () => ack.resolve());
    await updateChat(snapshot(3, 0));
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it.each(["delta", "replacement", "reconnect"])("positions unread only on entry, not a live %s", async change => {
    await render();
    await update(snapshot(1, 1));
    await settle();
    expect(navigate).toHaveBeenCalledWith(true);
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    navigate.mockClear();
    if (change === "reconnect") await act(async () => subscriber[Symbol.dispose]());
    await (change === "delta" ? updateChat(snapshot(2, 0)) : update(snapshot(2, 0)));
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();

    await render(<p>Thread list</p>);
    await render(<View />);
    await settle();
    expect(navigate).toHaveBeenCalledWith(true);
    expect(container.querySelector<HTMLDivElement>("[data-viewport]")!.scrollTop).toBe(80);
    expect(container.textContent).not.toContain("automatic reading paused");
  });

  it.each([
    {ackFirst: false, earlierFailure: false}, {ackFirst: true, earlierFailure: false},
    {ackFirst: true, earlierFailure: true},
  ])("resumes after a remote read supersedes a no-op unread selection (ACK first: $ackFirst, earlier failure: $earlierFailure)", async ({ackFirst, earlierFailure}) => {
    await render();
    await update(snapshot(1, 0));
    await settle();
    const failed = Promise.withResolvers<void>();
    if (earlierFailure) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      markChatUnread.mockReturnValueOnce(failed.promise);
      await markUnreadFrom(2);
    }
    const ack = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1); // Already at this boundary: the server sends no rewind echo.
    if (ackFirst) await act(async () => ack.resolve());
    await updateChat(snapshot(2, 2));
    if (!ackFirst) await act(async () => ack.resolve());
    if (earlierFailure) await act(async () => failed.reject(new Error("Earlier rewind failed")));
    visibleBottom = 450;
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(3, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 3});
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    navigate.mockClear();
    await updateChat(snapshot(4, 0)); // Even a later real remote rewind must preserve the viewport.
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(viewport.scrollTop).toBe(40);
  });

  it.each([
    {sequences: [2, 1], coalesced: false, firstFails: false},
    {sequences: [2, 1], coalesced: false, firstFails: false, initialHorizon: 0},
    {sequences: [2, 1], coalesced: true, firstFails: false, initialHorizon: 0},
    {sequences: [2, 1], coalesced: true, firstFails: false},
    {sequences: [2, 1], coalesced: true, firstFails: true},
    {sequences: [1, 2], coalesced: false, firstFails: false},
    {sequences: [1, 2], coalesced: true, firstFails: false},
  ])("keeps overlapping local unread selections $sequences in place (coalesced: $coalesced, first fails: $firstFails)",
      async ({sequences, coalesced, firstFails, initialHorizon = 2}) => {
    await render();
    await update(snapshot(1, initialHorizon));
    await settle();
    navigate.mockClear();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    const first = Promise.withResolvers<void>();
    if (firstFails) markChatUnread.mockReturnValueOnce(first.promise);
    for (const sequence of sequences) await markUnreadFrom(sequence);
    expect(markChatUnread.mock.calls).toEqual(sequences.map(sequence => ["workspace", 1, sequence]));
    if (firstFails) await act(async () => first.reject(new Error("First command failed")));
    const horizons = sequences.map(sequence => sequence - 1);
    for (const horizon of coalesced ? horizons.slice(-1) : horizons) {
      await update(snapshot(2, horizon));
      await settle();
      expect(viewport.scrollTop).toBe(40);
      expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart)
        .toBe(String(sequences.at(-1)));
    }
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("keeps a newer manual unread paused when an earlier mark-read ACK arrives", async () => {
    await render();
    await update(snapshot(1, 0));
    await settle();
    const ack = Promise.withResolvers<void>();
    markChatRead.mockReturnValueOnce(ack.promise);
    const markRead = [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!;
    await act(async () => markRead.click());
    await update(snapshot(2, 2)); // The read ran first, but its ACK is still in flight.
    await markUnreadFrom(1);
    await update(snapshot(3, 0));
    visibleBottom = 350;
    await act(async () => ack.resolve());
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 2});
  });

  it("preserves a remote rewind when an older mark-read fails", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    await update(snapshot(1, 1));
    await settle();
    const failed = Promise.withResolvers<void>();
    markChatRead.mockReturnValueOnce(failed.promise);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!.click());
    await update(snapshot(2, 0));
    await settle();
    await act(async () => failed.reject(new Error("Read command failed")));
    visibleBottom = 350;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("1");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 2});
  });

  it.each(["first", "second"])("retains a successful earlier read when a newer read fails (%s settles first)", async order => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    await update(snapshot(1, 2));
    await update(snapshot(2, 0));
    await settle();
    const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
    markChatRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const markRead = () => act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!.click());
    await markRead();
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const state = snapshot(3, 2);
    await update({...state, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...state.chats[0], unreadMessageCount: 1}]});
    await markRead();
    if (order === "first") await act(async () => first.resolve());
    await act(async () => second.reject(new Error("Second read failed")));
    if (order === "second") await act(async () => first.resolve());
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    visibleBottom = 450;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead.mock.calls.map(([request]) => request.throughSequence)).toEqual([2, 3, 3]);
  });

  it.each([false, true])("does not pause a successful read on a delayed local rewind echo (read ACK first: %s)", async ackFirst => {
    await render();
    await update(snapshot(1, 1));
    await settle();
    await markUnreadFrom(1);
    const read = Promise.withResolvers<void>();
    markChatRead.mockReturnValueOnce(read.promise);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!.click());
    if (ackFirst) await act(async () => read.resolve());
    await update(snapshot(2, 0));
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const state = snapshot(3, 2);
    await update({...state, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...state.chats[0], unreadMessageCount: 1}]});
    if (!ackFirst) await act(async () => read.resolve());
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    visibleBottom = 450;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead.mock.calls.map(([request]) => request.throughSequence)).toEqual([2, 3]);
  });

  it("rolls back a failed newer unread without treating the earlier successful rewind as remote", async () => {
    await render();
    await update(snapshot(1, 2));
    await settle();
    navigate.mockClear();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    const failed = Promise.withResolvers<void>();
    markChatUnread.mockResolvedValueOnce(undefined).mockReturnValueOnce(failed.promise);
    await markUnreadFrom(2);
    await markUnreadFrom(1);
    await update(snapshot(2, 1)); // The first command's snapshot precedes the second failure.
    await act(async () => failed.reject(new Error("Second command failed")));
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("2");
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it.each([false, true])("rolls back a failed unread selection at the already-unread boundary (fresh snapshot: %s)", async freshSnapshot => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    await update(snapshot(1, 0));
    await settle();
    const failed = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(failed.promise);
    await markUnreadFrom(1);
    if (freshSnapshot) await update(snapshot(2, 0));
    await act(async () => failed.reject(new Error("Unread command failed")));
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("1");
    visibleBottom = 350;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 2});
  });

  it.each([
    {secondAction: "unread", order: "first"}, {secondAction: "unread", order: "second"},
    {secondAction: "read", order: "first"}, {secondAction: "read", order: "second"},
  ])("restores the original visit when unread then $secondAction both fail ($order rejects first)", async ({secondAction, order}) => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(<View latestSequence={4} sequences={[0, 1, 2, 3, 4]} />);
    const state = snapshot(1, 2);
    await update({...state, unreadChatCount: 1, unreadMessageCount: 2,
      chats: [{...state.chats[0], unreadMessageCount: 2}]});
    await settle();
    const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(first.promise);
    await markUnreadFrom(2);
    if (secondAction === "unread") {
      markChatUnread.mockReturnValueOnce(second.promise);
      await markUnreadFrom(1);
    } else {
      markChatRead.mockReturnValueOnce(second.promise);
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!.click());
    }
    for (const request of order === "first" ? [first, second] : [second, first]) {
      await act(async () => request.reject(new Error("Unread command failed")));
    }
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("3");
    markChatRead.mockClear();
    visibleBottom = 550;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 4});
  });

  it.each(["foreground", "reset"])("waits for fresh unread state after %s before sending receipts", async reason => {
    await render();
    await update(snapshot(1, 2));
    await settle();
    await act(async () => {
      if (reason === "foreground") {
        Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"});
        document.dispatchEvent(new Event("visibilitychange"));
      } else subscriber[Symbol.dispose]();
    });
    visibleBottom = 450;
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    if (reason === "foreground") await act(async () => {
      Object.defineProperty(document, "visibilityState", {configurable: true, value: "visible"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle(); // History has advanced, but the replacement unread snapshot has not arrived.
    expect(markChatRead).not.toHaveBeenCalled();
    await update(snapshot(2, 0)); // Another device rewound while this subscription was absent.
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("waits for replay to render the first unread message before completing navigation", async () => {
    await render();
    const state = snapshot(1, 2);
    await update({...state, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...state.chats[0], unreadMessageCount: 1}]});
    await settle();
    expect(navigate).not.toHaveBeenCalledWith(false);
    expect(markChatRead).not.toHaveBeenCalled();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    expect(viewport.scrollTop).toBe(0);
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    await settle();
    expect(navigate).toHaveBeenLastCalledWith(false);
    expect(viewport.scrollTop).toBe(280); // Message 3 is positioned below the 20px toolbar.
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it.each([false, true])("resumes after a hidden rewind is superseded (ACK while hidden: %s)", async ackHidden => {
    const allRead = (): UserUnreadState => ({...snapshot(1, 1), unreadChatCount: 0, unreadMessageCount: 0,
      chats: [{...snapshot(1, 1).chats[0], unreadMessageCount: 0}]});
    const ack = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await render(<View latestSequence={1} />);
    await update(allRead());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-read-start="1"] button')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    if (!ackHidden) await act(async () => ack.resolve());
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (ackHidden) await act(async () => ack.resolve());
    await update(snapshot(2, 0)); // The unsubscribed callback misses the local echo.
    await update(allRead()); // Another device marks the thread read while this one is hidden.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await update(allRead());
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    visibleBottom = 350;
    await render(<View latestSequence={2} />);
    await update(snapshot(3, 1));
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 2});
  });

  it("does not acknowledge hidden documents, unfocused windows or a zero-size pane", async () => {
    await render();
    await update(snapshot());
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await update(snapshot());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    shown = false;
    await act(async () => window.dispatchEvent(new Event("resize")));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not resend an unchanged viewport boundary when snapshots refresh", async () => {
    visibleBottom = 350;
    await render();
    await update(snapshot());
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith({workspaceId: "workspace", chatId: 1,
      throughSequence: 2});
    await update(snapshot());
    await settle();
    await update(snapshot(2, 0));
    await settle();
    expect(markChatRead).toHaveBeenCalledOnce();
  });

  it("acknowledges visible messages during continuous streaming renders and resizes", async () => {
    vi.useFakeTimers();
    let resized = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      await render();
      await update(snapshot());
      await act(async () => vi.advanceTimersByTime(10));
      for (let chunk = 0; chunk < 6; chunk++) {
        await update(snapshot(chunk + 2));
        await render();
        await act(async () => {
          resized();
          vi.advanceTimersByTime(50);
        });
      }
      expect(markChatRead).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "workspace", chatId: 1, throughSequence: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses automatic reading when another device marks unread, and resumes after an explicit read", async () => {
    await render();
    await update(snapshot(1, 2));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    await update(snapshot(2, 0));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
    await update(snapshot(3, 2));
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    await update(snapshot(4, 0));
    visibleBottom = 350;
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    expect(container.textContent).toContain("automatic reading paused");
  });

  it.each([0, 2])("resumes explicit reading when a message beats the mark-read ACK (history starts at %s)", async oldest => {
    const earlier = (readThroughSequence: number): UserUnreadState => ({
      ...snapshot(1, readThroughSequence),
      chats: [{...snapshot(1, readThroughSequence).chats[0], unreadMessageCount: readThroughSequence < 1 ? 1 : 0}],
    });
    await render(<View oldest={oldest} latestSequence={1} />);
    await update(earlier(1));
    await settle();
    await update(earlier(0));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    const ack = Promise.withResolvers<void>();
    markChatRead.mockReturnValueOnce(ack.promise);
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!;
    await act(async () => button.click());
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 1});
    await render(<View oldest={oldest} latestSequence={2} />);
    await update(snapshot(2, 1)); // Message 2 arrives while the receipt for message 1 is pending.
    await act(async () => ack.resolve());
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledOnce();
    visibleBottom = 350;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith({workspaceId: "workspace", chatId: 1, throughSequence: 2});
  });

  it("loads older history before acknowledging a newer page, without endlessly retrying a failed page", async () => {
    visibleBottom = 350; // The newer page would otherwise acknowledge items past unseen history.
    loadEarlier.mockRejectedValueOnce(new Error("History unavailable"));
    await render(<View oldest={2} />);
    await update(snapshot(1, 0));
    await render(<View oldest={2} loadingEarlier />);
    await render(<View oldest={2} />);
    await settle();
    expect(loadEarlier).toHaveBeenCalledOnce();
    expect(markChatRead).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Jump to first unread",
    );
    await act(async () => retry!.click());
    expect(loadEarlier).toHaveBeenCalledTimes(2);
    await render(<View oldest={0} />);
    await settle();
    expect(navigate).toHaveBeenCalled();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace", chatId: 1, throughSequence: 2,
    });
  });

  it("restores pending history navigation when a manual unread command fails", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    visibleBottom = 350;
    await render(<View oldest={2} />);
    await update(snapshot(1, 0));
    await settle();
    expect(loadEarlier).toHaveBeenCalledOnce();
    const failed = Promise.withResolvers<void>();
    markChatUnread.mockReturnValueOnce(failed.promise);
    await markUnreadFrom(2);
    await act(async () => failed.reject(new Error("Unread command failed")));
    await settle();
    expect(navigate).toHaveBeenLastCalledWith(true);
    expect(markChatRead).not.toHaveBeenCalled();
    expect(loadEarlier).toHaveBeenCalledOnce(); // Restore the no-progress guard too.
    await render(<View oldest={0} />);
    await settle();
    expect(navigate).toHaveBeenLastCalledWith(false);
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith({workspaceId: "workspace", chatId: 1, throughSequence: 2});
  });

  it("allows explicit mark-read to release a failed history jump", async () => {
    visibleBottom = 350;
    await render(<View oldest={2} />);
    await update(snapshot(1, 0));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    const markRead = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Mark thread read",
    );
    await act(async () => markRead!.click());
    expect(markChatRead).toHaveBeenCalledOnce();
    await update(snapshot(2, 2));
    await settle();
    expect(container.textContent).not.toContain("Jump to first unread");
    markChatRead.mockClear();
    await update(snapshot(3, 1));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    expect(container.textContent).toContain("automatic reading paused");
  });

  it("cleans viewport listeners/timers on leaving and preserves the visit divider as receipts advance", async () => {
    await render();
    await update(snapshot());
    await settle();
    await update(snapshot(2, 2));
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    markChatRead.mockClear();
    await render(<p>Another thread</p>);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("places the divider after catalog gaps and marks unread from the selected visible item", async () => {
    const markUnread = vi.fn<(sequence: number) => void>();
    await render(
      <TimelineContext.Provider value={{ divider: 10, latestSequence: 11, markUnread }}>
        <TimelineReadItem start={9} end={10} unreadEnd={9}>
          Already read
        </TimelineReadItem>
        <TimelineReadItem start={11} end={11} previousUnreadEnd={9}>
          New item
        </TimelineReadItem>
      </TimelineContext.Provider>,
    );
    expect(
      container
        .querySelector("[data-unread-divider]")
        ?.closest("[data-read-start]")
        ?.getAttribute("data-read-start"),
    ).toBe("11");
    const trigger = container.querySelector<HTMLButtonElement>('[data-read-start="11"] button');
    await act(async () => trigger!.click());
    const action = document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(action?.textContent).toContain("Mark unread from here");
    await act(async () => action!.click());
    expect(markUnread).toHaveBeenCalledExactlyOnceWith(11);
  });
});
