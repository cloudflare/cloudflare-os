import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatReadState, Overseer, UserUnreadState } from "@gadgets/workshop-shared/api";
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
  const chat = unread?.state?.chats.find(
    (item) => item.workspaceId === workspaceId && item.chatId === chatId,
  );
  const [visit, renderVisit] = useState<{ horizon?: number; divider?: number; paused: boolean }>();
  // A new request also retries a failed page when navigation is already pending; zero is idle.
  const [jump, setJump] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const pending = useRef(-1);
  const requestedPage = useRef<number | undefined>(undefined);
  const jumpSequence = useRef<number | undefined>(undefined);
  type LocalAction = {
    previousAction?: LocalAction;
    failed?: boolean;
    readSucceeded?: boolean;
    rollback: {visit: typeof visit; jump: number; target?: number; requestedPage?: number};
  };
  const localUnreadRequests = useRef<(LocalAction & {
    horizon: number;
    startedSnapshot: typeof chat;
    acknowledgedReplacement?: object;
  })[]>([]);
  const receivedChat = useRef<ChatReadState | undefined>(undefined);
  const latestAction = useRef<LocalAction | undefined>(undefined);
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

  const createAction = (): LocalAction => ({
    previousAction: latestAction.current,
    rollback: {visit: latest.current.visit, jump, target: jumpSequence.current, requestedPage: requestedPage.current},
  });
  const rollbackAction = (action: LocalAction) => {
    action.failed = true;
    if (latestAction.current !== action) return;
    // A superseding action may fail before or after the action it replaced.
    while (action.previousAction?.failed) action = action.previousAction;
    latestAction.current = action.previousAction;
    const previous = action.rollback;
    // An earlier read can succeed while its successor is pending. Its resume effect is part
    // of the baseline even though it could not override the successor's optimistic visit.
    const resumed = action.previousAction?.readSucceeded;
    setVisit(current => previous.visit && {...previous.visit,
      horizon: current?.horizon ?? previous.visit.horizon,
      paused: resumed ? false : previous.visit.paused});
    jumpSequence.current = resumed ? undefined : previous.target;
    requestedPage.current = resumed ? undefined : previous.requestedPage;
    onUnreadNavigation(!resumed && !!previous.jump);
    setJump(resumed ? 0 : previous.jump);
  };
  const resumeIfRead = () => {
    const current = latest.current.chat;
    if (!localUnreadRequests.current.length && current?.unreadMessageCount === 0) {
      latestAction.current = undefined;
      setVisit(visit => visit?.paused ? {...visit, horizon: current.readThroughSequence, paused: false} : visit);
    }
  };

  const reconcileChat = useCallback((chat: ChatReadState | undefined, replacement?: UserUnreadState, available = true) => {
    const visit = latest.current.visit;
    latest.current.chat = chat;
    if (!chat) {
      receivedChat.current = undefined;
      pending.current = -1;
      // A legacy thread is already open, but its first cursor must establish the horizon.
      // History and unread snapshots arrive independently; the history tail cannot stand in for it.
      if (available && !visit && oldestSequence !== undefined) setVisit({paused: false});
      return;
    }
    if (receivedChat.current === chat) return;
    receivedChat.current = chat;
    const localIndex = localUnreadRequests.current.findLastIndex(request =>
      request.startedSnapshot !== chat && request.horizon === chat.readThroughSequence);
    const localUnread = localIndex !== -1;
    if (localUnread) {
      // A later local command can supersede earlier ones before their echoes arrive.
      for (const request of localUnreadRequests.current.splice(0, localIndex + 1)) {
        const previous = request.rollback.visit;
        if (previous && (previous.horizon === undefined || chat.readThroughSequence < previous.horizon)) {
          // Even a matching echo is authoritative if the RPC later fails or loses its response.
          request.rollback = {visit: {horizon: chat.readThroughSequence,
            divider: chat.readThroughSequence + 1, paused: true}, jump: 0};
          request.previousAction = undefined; // Older reads cannot resume this authoritative rewind.
        }
      }
      // An earlier local echo must still leave later commands' markers intact on re-render.
      for (const request of localUnreadRequests.current) {
        if (request.acknowledgedReplacement) request.acknowledgedReplacement = replacement;
      }
    } else {
      // A replacement can supersede a rewind missed while hidden; ordinary deltas cannot.
      localUnreadRequests.current = localUnreadRequests.current.filter(request =>
        (!request.acknowledgedReplacement || request.acknowledgedReplacement === replacement));
    }
    if (!visit || (visit.horizon !== undefined && chat.readThroughSequence < visit.horizon)) {
      // A remote rewind establishes a new visit, not a rollback target for older commands.
      if (visit && !localUnread) latestAction.current = undefined;
      const divider = localUnread && visit ? visit.divider :
        chat.unreadMessageCount > 0 ? chat.readThroughSequence + 1 : undefined;
      setVisit({ horizon: chat.readThroughSequence, divider,
        paused: localUnread ? !!visit?.paused : !!visit });
      pending.current = -1;
      // Only entering a thread positions its unread boundary. Live updates and reconnects
      // must not take over the viewport, regardless of which device changed the horizon.
      if (divider !== undefined && !visit) {
        jumpSequence.current = divider;
        requestedPage.current = undefined;
        onUnreadNavigation(true);
        setJump((request) => request + 1);
      }
    } else if (visit.paused && !localUnreadRequests.current.length &&
        chat.unreadMessageCount === 0) {
      latestAction.current = undefined;
      setVisit({ ...visit, horizon: chat.readThroughSequence, paused: false });
    } else if (visit.divider === undefined && chat.unreadMessageCount > 0) {
      setVisit({ ...visit, horizon: chat.readThroughSequence, divider: chat.readThroughSequence + 1 });
    } else if (visit.horizon !== chat.readThroughSequence) {
      setVisit({...visit, horizon: chat.readThroughSequence});
    }
  }, [oldestSequence, onUnreadNavigation, setVisit]);

  useLayoutEffect(() => unread?.subscribeToUpdates((state, replacement) => {
    reconcileChat(state.chats.find(item => item.workspaceId === workspaceId && item.chatId === chatId), replacement);
  }), [unread?.subscribeToUpdates, workspaceId, chatId, reconcileChat]);

  useLayoutEffect(() => {
    // Also reconcile the initial snapshot when entering an already-subscribed workspace.
    reconcileChat(chat, unread?.replacementSnapshot, !!unread?.state);
  }, [chat, unread?.state, unread?.replacementSnapshot, reconcileChat]);

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
          if (!workspaceId || !unread?.state) return;
          // Untouched pre-rollout threads have no cursor until an arrival or explicit command.
          const request: (typeof localUnreadRequests.current)[number] = {
            ...createAction(), horizon: sequence - 1, startedSnapshot: chat,
          };
          localUnreadRequests.current.push(request);
          latestAction.current = request;
          jumpSequence.current = undefined;
          requestedPage.current = undefined;
          if (jump) onUnreadNavigation(false);
          setJump(0);
          setVisit({ horizon: latest.current.visit?.horizon ?? sequence - 1, divider: sequence, paused: true });
          // Changed boundaries retain markers until an echo or a replacement snapshot arrives.
          void unread.markUnread(overseer, chatId, sequence).then(changed => {
            if (!changed) {
              // No echo will arrive for a no-op. Keeping its marker could swallow a later
              // remote rewind to this same horizon after the user marks the thread read.
              const index = localUnreadRequests.current.indexOf(request);
              if (index !== -1) localUnreadRequests.current.splice(index, 1);
            }
            request.acknowledgedReplacement = latest.current.unread?.replacementSnapshot ?? {};
            request.previousAction = undefined; // Only pending commands need the rollback link.
            resumeIfRead();
          }).catch(() => {
            const index = localUnreadRequests.current.indexOf(request);
            if (index !== -1) localUnreadRequests.current.splice(index, 1);
            rollbackAction(request);
            resumeIfRead();
          });
        },
      }}
    >
      <div ref={root} className={className}>
        {chat && chat.unreadMessageCount > 0 && (
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
                const action = createAction();
                latestAction.current = action;
                void unread?.markRead(overseer, chatId, latestSequence).then(() => {
                  action.readSucceeded = true;
                  action.previousAction = undefined;
                  if (latestAction.current !== action) return;
                  setVisit(current => current && {...current, paused: false});
                  onUnreadNavigation(false);
                  setJump(0);
                }).catch(() => rollbackAction(action));
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
