// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useRef, useState } from "react";
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
import { UnreadBadge } from "./UnreadBadge";
import { reportVisibleChat } from "./visibleChat";
import { TimelineContext } from "./readTimelineContext";

const snapshot = (revision = 1, readThroughSequence = -1, readEpoch = 0): UserUnreadState => ({
  revision,
  unreadChatCount: readThroughSequence < 2 ? 1 : 0,
  chats: [
    {
      workspaceId: "workspace",
      chatId: 1,
      chatTitle: "Demo",
      latestSequence: 2,
      readThroughSequence,
      readEpoch,
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
    (value: RpcStub<UnreadStateSubscriber>) => Promise<void> & Disposable
  >((value) => {
    subscriber = value;
    return Object.assign(Promise.resolve(), { [Symbol.dispose]: dispose });
  });
  const api = { subscribeToUnreadState, markChatRead, markChatUnread, markChatsRead };
  const loadEarlier = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const navigate = vi.fn<() => void>();

  const View = ({ oldest = 0 }: { oldest?: number }) => {
    const viewport = useRef<HTMLDivElement>(null);
    return (
      <div ref={viewport} data-viewport>
        <ReadTimeline
          workspaceId="workspace"
          chatId={1}
          container={viewport}
          oldestSequence={oldest}
          loadingEarlier={false}
          loadEarlier={loadEarlier}
          onUnreadNavigation={navigate}
          className=""
        >
          {[0, 1, 2]
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
        <UnreadStateBridge authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}>
          {child}
        </UnreadStateBridge>,
      ),
    );
  const update = (state: UserUnreadState) => act(async () => subscriber.updated(state));
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
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
      readEpoch: 0,
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
      readEpoch: 0,
    });
  });

  it("does not acknowledge hidden documents, unfocused windows or a zero-size pane", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await render();
    await update(snapshot());
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    shown = false;
    await act(async () => window.dispatchEvent(new Event("resize")));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("pauses automatic reading when another device marks unread, and resumes after an explicit read", async () => {
    await render();
    await update(snapshot(1, 2));
    await settle();
    expect(markChatRead).not.toHaveBeenCalled();
    await update(snapshot(2, 0, 1));
    await settle();
    expect(container.textContent).toContain("automatic reading paused");
    expect(markChatRead).not.toHaveBeenCalled();
    await update(snapshot(3, 2, 1));
    await settle();
    expect(container.textContent).not.toContain("automatic reading paused");
    await update(snapshot(4, 0, 1));
    visibleBottom = 350;
    await settle();
    expect(markChatRead).toHaveBeenLastCalledWith({
      workspaceId: "workspace",
      chatId: 1,
      throughSequence: 2,
      readEpoch: 1,
    });
  });

  it("loads older history before acknowledging a newer page, without endlessly retrying a failed page", async () => {
    await render(<View oldest={2} />);
    await update(snapshot(1, 0));
    await settle();
    expect(loadEarlier).toHaveBeenCalledOnce();
    expect(markChatRead).not.toHaveBeenCalled();
    await render(<View oldest={0} />);
    await settle();
    expect(navigate).toHaveBeenCalled();
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

  it("shows accessible aggregate badges and hides zero counts", async () => {
    const Badges = () => {
      const [count, setCount] = useState(2);
      return (
        <>
          <UnreadBadge count={count} />
          <button onClick={() => setCount(0)}>Clear</button>
        </>
      );
    };
    await render(<Badges />);
    expect(container.querySelector('[aria-label="2 unread threads"]')).not.toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[aria-label="2 unread threads"]')).toBeNull();
  });

  it("places the divider after catalog gaps and marks unread from the selected visible item", async () => {
    const markUnread = vi.fn<(sequence: number) => void>();
    await render(
      <TimelineContext.Provider value={{ divider: 10, latestSequence: 11, markUnread }}>
        <TimelineReadItem start={9} end={9}>
          Already read
        </TimelineReadItem>
        <TimelineReadItem start={11} end={11} previousEnd={9}>
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
