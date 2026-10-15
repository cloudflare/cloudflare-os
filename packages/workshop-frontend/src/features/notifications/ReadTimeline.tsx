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
  onUnreadNavigation: () => void;
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
  const latest = useRef({ chat, unread, visit });
  latest.current = { chat, unread, visit };

  useLayoutEffect(() => {
    if (!chat) {
      pending.current = -1;
      return;
    }
    if (!visit || visit.epoch !== chat.readEpoch) {
      const divider =
        chat.latestSequence > chat.readThroughSequence ? chat.readThroughSequence + 1 : undefined;
      setVisit({ epoch: chat.readEpoch, divider, paused: !!visit });
      pending.current = -1;
      if (divider !== undefined) {
        jumpSequence.current = divider;
        requestedPage.current = undefined;
        onUnreadNavigation();
        setJump((request) => request + 1);
      }
    } else if (visit.paused && chat.readThroughSequence >= chat.latestSequence) {
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
      if (visit) setJump(0);
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
      const items = root.current?.querySelectorAll<HTMLElement>("[data-read-start]");
      const item = items && [...items].find((element) => Number(element.dataset.readEnd) >= target);
      if (item && container.current) {
        container.current.scrollTop +=
          item.getBoundingClientRect().top - container.current.getBoundingClientRect().top;
      }
      setJump(0);
    });
    return () => cancelAnimationFrame(frame);
  }, [jump, visit, chat, oldestSequence, loadingEarlier, loadEarlier, container]);

  useEffect(() => {
    const viewport = container.current;
    const content = root.current;
    if (!viewport || !content || !chat || !visit || jump) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readViewport = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
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
      clearTimeout(timer);
      stopWatchingChat();
      resize?.disconnect();
      viewport.removeEventListener("scroll", readViewport);
      window.removeEventListener("focus", readViewport);
      window.removeEventListener("resize", readViewport);
      document.removeEventListener("visibilitychange", readViewport);
    };
  }, [container, chat, visit, jump, workspaceId, chatId, children]);

  return (
    <TimelineContext.Provider
      value={{
        divider: visit?.divider,
        latestSequence: chat?.latestSequence ?? -1,
        markUnread: (sequence) => {
          if (!chat || !unread || !visit) return;
          setVisit({ ...visit, divider: sequence, paused: true });
          void unread.markUnread(chat, sequence).catch(() => setVisit(visit));
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
                onUnreadNavigation();
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
