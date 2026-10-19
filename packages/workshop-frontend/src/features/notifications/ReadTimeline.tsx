import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@cloudflare/kumo";
import { useUnreadState } from "./UnreadStateBridge";
import { isChatVisible, subscribeVisibleChat } from "./visibleChat";

import { TimelineContext } from "./readTimelineContext";

/** A visit-scoped boundary stays in place as receipts advance; explicit unread moves it again. */
export const ReadTimeline = ({
  workspaceId,
  chatId,
  container,
  oldestSequence,
  loadingEarlier,
  loadEarlier,
  onUnreadNavigation,
  className,
  children,
}: {
  workspaceId?: string;
  chatId: number;
  container: RefObject<HTMLDivElement | null>;
  oldestSequence?: number;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  onUnreadNavigation: (pending: boolean) => void;
  className: string;
  children: ReactNode;
}) => {
  const unread = useUnreadState();
  const chat = unread?.state?.chats.find(
    (item) => item.workspaceId === workspaceId && item.chatId === chatId,
  );
  const [visit, setVisit] = useState<{ epoch: number; divider?: number; paused: boolean }>();
  // A new request also retries a failed page when navigation is already pending; zero is idle.
  const [jump, setJump] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef(-1);
  const requestedPage = useRef<number | undefined>(undefined);
  const jumpSequence = useRef<number | undefined>(undefined);
  const localUnreadEpoch = useRef<number | undefined>(undefined);
  const requestRead = useRef<(() => void) | undefined>(undefined);
  const latest = useRef({ chat, unread, visit });
  latest.current = { chat, unread, visit };

  useLayoutEffect(() => {
    if (!chat) {
      pending.current = -1;
      return;
    }
    if (!visit || visit.epoch !== chat.readEpoch) {
      const localUnread = localUnreadEpoch.current === chat.readEpoch;
      localUnreadEpoch.current = undefined;
      const divider =
        chat.latestSequence > chat.readThroughSequence ? chat.readThroughSequence + 1 : undefined;
      setVisit({ epoch: chat.readEpoch, divider, paused: !!visit });
      pending.current = -1;
      if (divider !== undefined && !localUnread) {
        jumpSequence.current = divider;
        requestedPage.current = undefined;
        onUnreadNavigation(true);
        setJump((request) => request + 1);
      }
    } else if (visit.paused && localUnreadEpoch.current === undefined &&
        chat.readThroughSequence >= chat.latestSequence) {
      setVisit({ ...visit, paused: false });
    } else if (visit.divider === undefined && chat.latestSequence > chat.readThroughSequence) {
      setVisit({ ...visit, divider: chat.readThroughSequence + 1 });
    }
  }, [chat, visit, onUnreadNavigation]);

  // Walk checkpoint pages until the boundary is present, then position before acknowledging any
  // viewport. Read state isn't advanced merely because the newest history page was fetched.
  useEffect(() => {
    if (
      !jump ||
      !visit ||
      visit.divider === undefined ||
      (chat && chat.readThroughSequence >= chat.latestSequence)
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
    const frame = requestAnimationFrame(() => {
      const items = root.current?.querySelectorAll<HTMLElement>("[data-unread-through]");
      const item = items && [...items].find((element) => Number(element.dataset.unreadThrough) >= target);
      if (item && container.current) {
        container.current.scrollTop +=
          item.getBoundingClientRect().top - container.current.getBoundingClientRect().top;
      }
      // A short history may not move scrollTop and therefore emits no scroll event. Let the
      // chat recompute follow-to-bottom even for that no-op navigation.
      onUnreadNavigation(false);
      setJump(0);
    });
    return () => cancelAnimationFrame(frame);
  }, [jump, visit, chat, oldestSequence, loadingEarlier, loadEarlier, container, onUnreadNavigation]);

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
        let through = current.chat.readThroughSequence;
        for (const marker of content.querySelectorAll<HTMLElement>("[data-read-through]")) {
          const rect = marker.getBoundingClientRect();
          if (
            rect.bottom >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.right > bounds.left &&
            rect.left < bounds.right
          ) {
            through = Math.max(through, Number(marker.dataset.readThrough));
          }
        }
        through = Math.min(through, current.chat.latestSequence);
        if (through <= current.chat.readThroughSequence || through <= pending.current) return;
        pending.current = through;
        void current.unread.markRead(current.chat, through).catch(() => {
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
  useEffect(() => requestRead.current?.(), [chat, visit]);

  return (
    <TimelineContext.Provider
      value={{
        divider: visit?.divider,
        latestSequence: chat?.latestSequence ?? -1,
        markUnread: (sequence) => {
          if (!chat || !unread || !visit) return;
          localUnreadEpoch.current = chat.readEpoch + 1;
          setVisit({ ...visit, divider: sequence, paused: true });
          void unread.markUnread(chat, sequence).catch(() => {
            localUnreadEpoch.current = undefined;
            setVisit(visit);
          });
        },
      }}
    >
      <div ref={root} className={className}>
        {chat && chat.latestSequence > chat.readThroughSequence && (
          <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-center gap-2 rounded-md bg-kumo-base p-2 text-sm text-kumo-subtle">
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
                void unread?.markRead(chat).catch(() => {});
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
