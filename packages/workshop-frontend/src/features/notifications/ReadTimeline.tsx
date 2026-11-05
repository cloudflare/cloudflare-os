import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatReadState, Overseer } from "@gadgets/workshop-shared/api";
import { Button } from "@cloudflare/kumo";
import { useUnreadState } from "./UnreadStateBridge";
import { isChatVisible, subscribeVisibleChat } from "./visibleChat";

import { TimelineContext } from "./readTimelineContext";

/** A visit-scoped boundary stays in place as receipts advance; explicit unread moves it again. */
export const ReadTimeline = ({
  workspaceId,
  overseer,
  chatId,
  container,
  oldestSequence,
  latestSequence,
  loadingEarlier,
  loadEarlier,
  onUnreadNavigation,
  className,
  children,
}: {
  workspaceId?: string;
  overseer: Pick<Overseer, "markChatRead" | "markChatUnread">;
  chatId: number;
  container: RefObject<HTMLDivElement | null>;
  oldestSequence?: number;
  latestSequence: number;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  onUnreadNavigation: (pending: boolean) => void;
  className: string;
  children: ReactNode;
}) => {
  const unread = useUnreadState();
  const chat = unread?.chats?.find(
    (item) => item.workspaceId === workspaceId && item.chatId === chatId,
  );
  const [visit, renderVisit] = useState<{ divider?: number; paused: boolean }>();
  // A new request also retries a failed page when navigation is already pending; zero is idle.
  const [jump, setJump] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const pending = useRef(-1);
  const requestedPage = useRef<number | undefined>(undefined);
  const jumpSequence = useRef<number | undefined>(undefined);
  const receivedChat = useRef<ChatReadState | undefined>(undefined);
  const latestAction = useRef<symbol | undefined>(undefined);
  const requestRead = useRef<(() => void) | undefined>(undefined);
  const latest = useRef({ chat, unread, visit, latestSequence, overseer });
  latest.current = { chat, unread, visit, latestSequence, overseer };
  // Subscriber callbacks can precede the next render. Each transition must see the prior visit,
  // including changes from earlier callbacks and local command completions in the same batch.
  const setVisit = useCallback((update: typeof visit | ((current: typeof visit) => typeof visit)) => {
    const next = typeof update === "function" ? update(latest.current.visit) : update;
    latest.current.visit = next;
    renderVisit(next);
  }, []);

  // A departed visit must not restore navigation through the parent's shared callback.
  useLayoutEffect(() => () => { latestAction.current = undefined; }, []);

  const reconcileChat = useCallback((chat: ChatReadState | undefined, available = true, initialSnapshot = false) => {
    const visit = latest.current.visit;
    latest.current.chat = chat;
    if (!chat) {
      if (available) receivedChat.current = undefined;
      pending.current = -1;
      // Legacy history and the first unread cursor can arrive in either order.
      if (available && !visit && oldestSequence !== undefined) setVisit({paused: false});
      return;
    }
    const previous = receivedChat.current;
    if (previous === chat) return;
    receivedChat.current = chat;
    // Server transitions supersede local optimism, even before the command ACK arrives.
    if (!visit) {
      const divider = chat.unreadMessageCount > 0 ? chat.readThroughSequence + 1 : undefined;
      setVisit({divider, paused: false});
      if (divider !== undefined) {
        jumpSequence.current = divider;
        requestedPage.current = undefined;
        onUnreadNavigation(true);
        setJump(request => request + 1);
      }
    } else if (previous &&
        chat.readThroughSequence < previous.readThroughSequence) {
      latestAction.current = undefined;
      setVisit({divider: chat.readThroughSequence + 1, paused: true});
      pending.current = -1;
      // Live changes, including remote rewinds, never take over the viewport.
    } else if (visit.paused && chat.unreadMessageCount === 0 &&
        (initialSnapshot || (previous && chat.readThroughSequence > previous.readThroughSequence))) {
      latestAction.current = undefined;
      setVisit({...visit, paused: false});
    } else if (visit.divider === undefined && chat.unreadMessageCount > 0) {
      const viewport = container.current;
      const bounds = viewport?.getBoundingClientRect();
      const readingTail = viewport && bounds && bounds.width > 0 && bounds.height > 0 &&
        document.visibilityState === "visible" && document.hasFocus() &&
        !!workspaceId && isChatVisible(workspaceId, chatId) &&
        viewport.scrollHeight - viewport.scrollTop <= viewport.clientHeight + 1;
      if (!readingTail || initialSnapshot) setVisit({...visit, divider: chat.readThroughSequence + 1});
    }
  }, [oldestSequence, onUnreadNavigation, setVisit, container, workspaceId, chatId]);

  useLayoutEffect(() => unread?.subscribeToUpdates((state, initialSnapshot) => {
    reconcileChat(state.chats.find(item => item.workspaceId === workspaceId && item.chatId === chatId), true, initialSnapshot);
  }), [unread?.subscribeToUpdates, workspaceId, chatId, reconcileChat]);

  useLayoutEffect(() => {
    // Also reconcile the initial snapshot when entering an already-subscribed workspace.
    reconcileChat(chat, !!unread?.chats);
  }, [chat, unread?.chats, reconcileChat]);

  // Walk checkpoint pages until the boundary is present, then position before acknowledging any
  // viewport. Read state isn't advanced merely because the newest history page was fetched.
  useEffect(() => {
    if (
      !jump ||
      !visit ||
      visit.divider === undefined ||
      (chat && chat.unreadMessageCount === 0)
    ) {
      if (visit && jump) {
        onUnreadNavigation(false);
        setJump(0);
      }
      return;
    }
    if (oldestSequence === undefined || loadingEarlier) return;
    const target = jumpSequence.current ?? visit.divider;
    if (oldestSequence > target && oldestSequence > 0) {
      if (requestedPage.current === oldestSequence) {
        // The previous load failed or made no progress. Keep receipts blocked until the
        // boundary is present, the user retries navigation, or explicitly marks the thread read.
        return;
      }
      requestedPage.current = oldestSequence;
      void loadEarlier().catch(() => {});
      return;
    }
    const viewport = container.current;
    if (!viewport) return;
    let frame = 0;
    const navigate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Mobile keeps the chat mounted behind the gadget pane. Leave the jump pending until
        // layout exists, then position before enabling viewport receipts.
        const bounds = viewport.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        const items = root.current?.querySelectorAll<HTMLElement>("[data-unread-through]");
        const item = items && [...items].find((element) => Number(element.dataset.unreadThrough) >= target);
        if (!item) return; // The unread snapshot can arrive before history replay.
        viewport.scrollTop += item.getBoundingClientRect().top - bounds.top -
          (toolbar.current?.getBoundingClientRect().height ?? 0);
        // A short history may not move scrollTop and therefore emits no scroll event. Let the
        // chat recompute follow-to-bottom even for that no-op navigation.
        onUnreadNavigation(false);
        setJump(0);
      });
    };
    const stopWatchingChat = subscribeVisibleChat(navigate);
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(navigate);
    resize?.observe(viewport);
    window.addEventListener("resize", navigate);
    navigate();
    return () => {
      cancelAnimationFrame(frame);
      stopWatchingChat();
      resize?.disconnect();
      window.removeEventListener("resize", navigate);
    };
  }, [jump, visit, chat, oldestSequence, latestSequence, loadingEarlier, loadEarlier, container, onUnreadNavigation]);

  const canRead = !!chat && !!visit && !jump;
  useEffect(() => {
    const viewport = container.current;
    const content = root.current;
    if (!viewport || !content || !canRead) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readViewport = () => {
      // Continuous streaming/resizing must not postpone a visible receipt indefinitely.
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const current = latest.current;
        if (
          !current.chat ||
          !current.unread ||
          current.visit?.paused ||
          document.visibilityState !== "visible" ||
          !document.hasFocus() ||
          !workspaceId ||
          !isChatVisible(workspaceId, chatId)
        )
          return;
        const bounds = viewport.getBoundingClientRect();
        if (bounds.height <= 0 || bounds.width <= 0) return;
        const readableTop = Math.max(bounds.top, toolbar.current?.getBoundingClientRect().bottom ?? bounds.top);
        let through = current.chat.readThroughSequence;
        for (const marker of content.querySelectorAll<HTMLElement>("[data-read-through]")) {
          const rect = marker.getBoundingClientRect();
          if (
            rect.bottom > readableTop &&
            rect.bottom <= bounds.bottom &&
            rect.right > bounds.left &&
            rect.left < bounds.right
          ) {
            through = Math.max(through, Number(marker.dataset.readThrough));
          }
        }
        through = Math.min(through, current.latestSequence);
        if (through <= current.chat.readThroughSequence || through <= pending.current) return;
        pending.current = through;
        void current.unread.markRead(current.overseer, chatId, through).catch(() => {
          pending.current = -1;
        });
      }, 250);
    };
    requestRead.current = readViewport;
    viewport.addEventListener("scroll", readViewport);
    const stopWatchingChat = subscribeVisibleChat(readViewport);
    window.addEventListener("focus", readViewport);
    window.addEventListener("resize", readViewport);
    document.addEventListener("visibilitychange", readViewport);
    const resize =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(readViewport);
    resize?.observe(content);
    readViewport();
    return () => {
      requestRead.current = undefined;
      clearTimeout(timer);
      stopWatchingChat();
      resize?.disconnect();
      viewport.removeEventListener("scroll", readViewport);
      window.removeEventListener("focus", readViewport);
      window.removeEventListener("resize", readViewport);
      document.removeEventListener("visibilitychange", readViewport);
    };
  }, [container, canRead, workspaceId, chatId]);

  // New snapshots request a scan without cancelling a timer already armed by streaming/layout.
  useEffect(() => requestRead.current?.(), [chat, visit, latestSequence]);

  return (
    <TimelineContext.Provider
      value={{
        divider: visit?.divider,
        latestSequence,
        markUnread: (sequence) => {
          if (!workspaceId || !unread?.chats) return;
          const action = Symbol();
          latestAction.current = action;
          const previous = {visit: latest.current.visit, jump,
            target: jumpSequence.current, page: requestedPage.current};
          jumpSequence.current = undefined;
          requestedPage.current = undefined;
          if (jump) onUnreadNavigation(false);
          setJump(0);
          setVisit({divider: sequence, paused: true});
          void unread.markUnread(overseer, chatId, sequence).catch(() => {
            if (latestAction.current !== action) return;
            setVisit(previous.visit);
            jumpSequence.current = previous.target;
            requestedPage.current = previous.page;
            onUnreadNavigation(!!previous.jump);
            setJump(previous.jump);
          });
        },
      }}
    >
      <div ref={root} className={className}>
        {chat && chat.unreadMessageCount > 0 && (visit?.divider !== undefined || visit?.paused) && (
          <div ref={toolbar} className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-center gap-2 rounded-md bg-kumo-base p-2 text-sm text-kumo-subtle">
            {visit?.paused
              ? "Marked unread — automatic reading paused until you leave this thread."
              : "Unread activity"}
            <Button
              size="xs"
              onClick={() => {
                jumpSequence.current = chat.readThroughSequence + 1;
                requestedPage.current = undefined;
                onUnreadNavigation(true);
                setJump((request) => request + 1);
              }}
            >
              Jump to first unread
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                const action = Symbol();
                latestAction.current = action;
                void unread?.markRead(overseer, chatId, latestSequence).then(() => {
                  if (latestAction.current !== action) return;
                  setVisit(current => current && {...current, paused: false});
                  onUnreadNavigation(false);
                  setJump(0);
                }).catch(() => {});
              }}
            >
              Mark thread read
            </Button>
          </div>
        )}
        {children}
      </div>
    </TimelineContext.Provider>
  );
};
