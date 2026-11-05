// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { UnreadStateBridge } from "./UnreadStateBridge";
import { ReadTimeline } from "./ReadTimeline";
import { TimelineReadItem } from "./TimelineReadItem";
import { reportVisibleChat } from "./visibleChat";
import { TimelineContext } from "./readTimelineContext";

vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({ add: () => {} }),
}));

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
  const markChatRead = vi.fn<Overseer["markChatRead"]>().mockResolvedValue(undefined);
  const markChatUnread = vi.fn<Overseer["markChatUnread"]>().mockResolvedValue(true);
  const markAllRead = vi.fn<AuthenticatedApi["markAllRead"]>().mockResolvedValue(undefined);
  const dispose = vi.fn<() => void>();
  const subscribeToUnreadState = vi.fn<
    (_scope: unknown, value: RpcStub<UnreadStateSubscriber>) => Promise<void> & Disposable
  >((_scope, value) => {
    subscriber = value;
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: dispose });
  });
  const api = { subscribeToUnreadState, markChatRead, markChatUnread, markAllRead };
  const loadEarlier = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const navigate = vi.fn<() => void>();

  const View = ({ oldest = 0, loadingEarlier = false, latestSequence = 2, sequences = [0, 1, 2] }: {
    oldest?: number; loadingEarlier?: boolean; latestSequence?: number; sequences?: number[];
  }) => {
    const viewport = useRef<HTMLDivElement>(null);
    return (
      <div ref={viewport} data-viewport>
        <ReadTimeline overseer={api}
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
  const receiveChat = (state: UserUnreadState) => subscriber.chatUpdated("workspace", 1, state.chats[0], {
    unreadChatCount: state.unreadChatCount, unreadMessageCount: state.unreadMessageCount,
    workspace: {workspaceId: "workspace", unreadChatCount: state.unreadChatCount, unreadMessageCount: state.unreadMessageCount},
  });
  const updateChat = (state: UserUnreadState) => act(async () => receiveChat(state));
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
  };
  const markUnreadFrom = async (sequence: number) => {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-read-start="${sequence}"] button`)!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    visibleBottom = 150;
    shown = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
      setTimeout(() => fn(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) {
      return this.hasAttribute("data-viewport") ? visibleBottom : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) {
      const tail = [...this.querySelectorAll<HTMLElement>("[data-read-through]")].at(-1);
      return tail ? Number(tail.dataset.readThrough) * 100 + 101 : 0;
    });
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
    vi.useRealTimers();
  });

  it("renders the unread line and acknowledges only persisted items visible in the focused viewport", async () => {
    await render();
    await update(snapshot());
    await settle();
    expect(container.querySelector('[role="separator"]')?.textContent).toContain("New");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 0);
    visibleBottom = 350;
    await act(async () =>
      container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")),
    );
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith(1, 2);
  });

  it("does not flash unread UI for a live reply in a caught-up, focused pane", async () => {
    visibleBottom = 450;
    await render(); await update(snapshot(1, 2)); await settle();
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(2, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    expect(container.querySelector("[data-unread-divider]")).toBeNull();
    expect(container.textContent).not.toContain("Unread activity");
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 3);
  });

  it("shows unread activity for a live reply while scrolled away from the tail", async () => {
    await render(); await update(snapshot(1, 2)); await settle();
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(2, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    expect(container.querySelector("[data-unread-divider]")).not.toBeNull();
    expect(container.textContent).toContain("Unread activity");
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("keeps a New divider for messages received while the tab was hidden", async () => {
    visibleBottom = 450;
    await render(); await update(snapshot(1, 2)); await settle();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {configurable: true, value: "visible"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const arrival = snapshot(2, 2);
    await update({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("3");
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 3);
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
    expect(markChatUnread).toHaveBeenCalledExactlyOnceWith(1, 1);
    await settle();
    expect(viewport.scrollTop).toBe(40);
    await update(snapshot(1, 0));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
  });

  it.each([false, true])("does not treat the first unread event on an already-open legacy thread as a rewind (history first: %s)", async historyFirst => {
    await render();
    if (historyFirst) await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    await update({chats: [], workspaces: [], unreadChatCount: 0, unreadMessageCount: 0});
    await settle();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    navigate.mockClear();
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(1, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.textContent).not.toContain("automatic reading paused");
    visibleBottom = 450;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 3);
  });

  it("lets visible receipts consume the first cursor of an already-open legacy thread", async () => {
    visibleBottom = 350;
    await render();
    await update({chats: [], workspaces: [], unreadChatCount: 0, unreadMessageCount: 0});
    await settle();
    await updateChat(snapshot(1, 0));
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
    expect(navigate).not.toHaveBeenCalledWith(true);
  });

  it.each([false, true])("keeps a failed unread command's navigation in its owning visit (reentered: %s)", async reenter => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = Promise.withResolvers<never>();
    markChatUnread.mockReturnValueOnce(failed.promise);
    await render(<View oldest={2} />);
    await update(snapshot(1, 0));
    await settle();
    await markUnreadFrom(2);
    await render(<p>Another thread</p>);
    if (reenter) { await render(); await settle(); }
    navigate.mockClear();
    await act(async () => failed.reject(new Error("Unread command failed")));
    await settle();
    expect(navigate).not.toHaveBeenCalledWith(true);
  });

  it.each([
    {ackFirst: false, interveningUpdate: "none"},
    {ackFirst: true, interveningUpdate: "none"},
    {ackFirst: false, interveningUpdate: "metadata"},
    {ackFirst: true, interveningUpdate: "metadata"},
    {ackFirst: false, interveningUpdate: "bulk"},
    {ackFirst: true, interveningUpdate: "bulk"},
  ])("preserves local unread navigation across an intervening arrival (ACK first: $ackFirst, update: $interveningUpdate)", async ({ackFirst, interveningUpdate}) => {
    visibleBottom = 450;
    await render();
    await update(snapshot(1, 2));
    await settle();
    navigate.mockClear();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    const ack = Promise.withResolvers<boolean>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1);
    if (ackFirst) await act(async () => ack.resolve(true));
    // A rename or bulk read elsewhere can publish this thread's unchanged horizon/count.
    if (interveningUpdate === "metadata") await updateChat(snapshot(1, 2));
    if (interveningUpdate === "bulk") await update(snapshot(1, 2));
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(2, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    if (!ackFirst) await act(async () => ack.resolve(true));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled(); // A changed command still awaits its rewind echo.
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
    const ack = Promise.withResolvers<boolean>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1);
    if (ackFirst) await act(async () => ack.resolve(true));
    // Another device advanced the server before this command ran. Its delta and our
    // real rewind echo arrive after the ACK, despite the unchanged cached boundary.
    await updateChat(snapshot(2, 2));
    if (!ackFirst) await act(async () => ack.resolve(true));
    await updateChat(snapshot(3, 0));
    await settle();
    expect(viewport.scrollTop).toBe(40);
    expect(navigate).not.toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("lets the latest server horizon settle overlapping local unread selections", async () => {
    await render(); await update(snapshot(1, 2)); await settle();
    await markUnreadFrom(2); await markUnreadFrom(1);
    await updateChat(snapshot(2, 1)); await updateChat(snapshot(3, 0));
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("1");
    expect(container.textContent).toContain("automatic reading paused");
    expect(navigate).not.toHaveBeenCalledWith(true);
  });

  it.each(["before read", "before arrival", "after arrival"])("resumes after a remote read clears a no-op unread selection (ACK: %s)", async ackAt => {
    await render(); await update(snapshot(1, 0)); await settle();
    const ack = Promise.withResolvers<boolean>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1); // The source horizon is already zero; there will be no local echo.
    if (ackAt === "before read") await act(async () => ack.resolve(false));
    await updateChat(snapshot(2, 2));
    if (ackAt === "before arrival") await act(async () => ack.resolve(false));
    visibleBottom = 450;
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(3, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    if (ackAt === "after arrival") await act(async () => ack.resolve(false));
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 3);
  });

  it("respects a remote rewind after an all-read update while a local command is pending", async () => {
    await render(); await update(snapshot(1, 0)); await settle();
    const ack = Promise.withResolvers<boolean>();
    markChatUnread.mockReturnValueOnce(ack.promise);
    await markUnreadFrom(1);
    await updateChat(snapshot(2, 2));
    await updateChat(snapshot(3, 1));
    await act(async () => ack.resolve(false));
    visibleBottom = 350;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("2");
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
  });

  it.each([0, 1])("pauses for a later remote rewind after a no-op unread and completed read (remote horizon: %s)", async horizon => {
    await render();
    await update(snapshot(1, 0));
    await settle();
    markChatUnread.mockResolvedValueOnce(false);
    await markUnreadFrom(1); // The server is already at 0 and publishes no local echo.
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Mark thread read")!.click());
    await updateChat(snapshot(2, 2));
    await updateChat(snapshot(3, horizon)); // A genuinely later command from another device.
    visibleBottom = 350;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
  });

  it("honors a server rewind received after a failed local selection", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(); await update(snapshot(1, 2)); await settle();
    markChatUnread.mockRejectedValueOnce(new Error("Unread command failed"));
    await markUnreadFrom(1);
    await updateChat(snapshot(2, 0));
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("ignores an older failed selection after a newer selection succeeds", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    await render(); await update(snapshot(1, 2)); await settle();
    const first = Promise.withResolvers<boolean>();
    markChatUnread.mockReturnValueOnce(first.promise);
    await markUnreadFrom(2); await markUnreadFrom(1);
    await updateChat(snapshot(2, 0));
    await act(async () => first.reject(new Error("Earlier command failed")));
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("1");
    expect(container.textContent).toContain("automatic reading paused");
  });

  it("rolls back a failed newer unread without treating the earlier successful rewind as remote", async () => {
    await render();
    await update(snapshot(1, 2));
    await settle();
    navigate.mockClear();
    const viewport = container.querySelector<HTMLDivElement>("[data-viewport]")!;
    viewport.scrollTop = 40;
    const failed = Promise.withResolvers<never>();
    markChatUnread.mockResolvedValueOnce(true).mockReturnValueOnce(failed.promise);
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
    const failed = Promise.withResolvers<never>();
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
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

  it.each([false, true])("uses the replacement snapshot after another device clears unread while hidden (rewind received: %s)", async receivedRewind => {
    await render(); await update(snapshot(1, 2)); await settle();
    await markUnreadFrom(1);
    if (receivedRewind) await updateChat(snapshot(1, 0));
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {configurable: true, value: "visible"});
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await update(snapshot(2, 2));
    await settle();
    expect(subscribeToUnreadState).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("automatic reading paused");
    visibleBottom = 450;
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(3, 2);
    await updateChat({...arrival, unreadChatCount: 1, unreadMessageCount: 1,
      chats: [{...arrival.chats[0], unreadMessageCount: 1}]});
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 3);
    await updateChat(snapshot(3, 1));
    expect(container.textContent).toContain("automatic reading paused");
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

  it("waits to acknowledge a mounted pane until the editor reports it visible", async () => {
    withdraw();
    await render(); await update(snapshot()); await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    await act(async () => {
      withdraw = reportVisibleChat(() => ({workspaceId: "workspace", chatId: 1}));
    });
    await settle();
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 0);
  });

  it("does not resend an unchanged viewport boundary when snapshots refresh", async () => {
    visibleBottom = 350;
    await render();
    await update(snapshot());
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith(1, 2);
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
      expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("pauses for a remote read then rewind, including a following arrival (batched: %s)", async batched => {
    await render();
    await update(snapshot(1, 0));
    await settle();
    await render(<View latestSequence={3} sequences={[0, 1, 2, 3]} />);
    const arrival = snapshot(4, 0);
    const updates = [snapshot(2, 2), snapshot(3, 0), {...arrival,
      chats: [{...arrival.chats[0], unreadMessageCount: 3}]}];
    if (batched) await act(async () => {
      for (const next of updates) await receiveChat(next);
    });
    else for (const next of updates) await updateChat(next);
    visibleBottom = 450;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(container.querySelector("[data-unread-divider]")?.closest<HTMLElement>("[data-read-start]")?.dataset.readStart).toBe("1");
    expect(markChatRead).not.toHaveBeenCalled();
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 1);
    await render(<View oldest={oldest} latestSequence={2} />);
    await update(snapshot(2, 1)); // Message 2 arrives while the receipt for message 1 is pending.
    await act(async () => ack.resolve());
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    expect(markChatRead).toHaveBeenCalledOnce();
    visibleBottom = 350;
    await act(async () => container.querySelector("[data-viewport]")!.dispatchEvent(new Event("scroll")));
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith(1, 2);
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
  });

  it("restores pending history navigation when a manual unread command fails", async () => {
    using _ = vi.spyOn(console, "error").mockImplementation(() => {});
    visibleBottom = 350;
    await render(<View oldest={2} />);
    await update(snapshot(1, 0));
    await settle();
    expect(loadEarlier).toHaveBeenCalledOnce();
    const failed = Promise.withResolvers<never>();
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
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(1, 2);
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
