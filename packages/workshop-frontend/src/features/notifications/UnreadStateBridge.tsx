import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AuthenticatedApi,
  ChatReadReceipt,
  ChatReadState,
  ChatTimelineHead,
  UnreadStateScope,
  UnreadStateSubscriber,
  UnreadSummaryUpdate,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "../../rpcErrors";

class UnreadSubscriber extends RpcTarget implements UnreadStateSubscriber {
  constructor(
    private readonly receive: (state: UserUnreadState) => void,
    private readonly receiveSummary: UnreadStateSubscriber["summaryUpdated"],
    private readonly receiveChat: UnreadStateSubscriber["chatUpdated"],
    private readonly released: () => void,
  ) {
    super();
  }
  async updated(state: UserUnreadState): Promise<void> {
    this.receive(state);
  }
  async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>): Promise<void> {
    await this.receiveChat(...args);
  }
  async summaryUpdated(summary: UnreadSummaryUpdate): Promise<void> {
    await this.receiveSummary(summary);
  }
  [Symbol.dispose]() {
    this.released();
  }
}

type ObservedChat = ChatReadState & Partial<Pick<ChatTimelineHead, "latestSequence">>;

type UnreadContextValue = {
  state?: UserUnreadState;
  /** Last full replacement, retaining its identity across deltas so visits can recognize reconnects. */
  replacementSnapshot?: UserUnreadState;
  markRead: (chat: ChatReadState, throughSequence?: number) => Promise<void>;
  markManyRead: (chats: ObservedChat[]) => Promise<void>;
  markWorkspaceRead: (workspaceId: string) => Promise<void>;
  markUnread: (chat: ChatReadState, fromSequence?: number) => Promise<boolean>;
};
const UnreadContext = createContext<UnreadContextValue | null>(null);

/** Returns badge rollups and this view's scoped rows; absent on unauthenticated surfaces. */
export const useUnreadState = () => useContext(UnreadContext);

const receiptFor = (
  chat: ChatReadState,
  throughSequence: number,
): ChatReadReceipt => ({
  workspaceId: chat.workspaceId,
  chatId: chat.chatId,
  throughSequence,
});

const applySummary = (state: UserUnreadState, update: UnreadSummaryUpdate): UserUnreadState => {
  const workspaces = state.workspaces.filter(item => item.workspaceId !== update.workspace.workspaceId);
  if (update.workspace.unreadMessageCount > 0) workspaces.push(update.workspace);
  return {...state, unreadChatCount: update.unreadChatCount, unreadMessageCount: update.unreadMessageCount, workspaces};
};

/** One scoped session subscription supplies badges and only the active view's thread rows. */
export const UnreadStateBridge = ({
  authenticatedApi,
  scope,
  children,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
  scope: UnreadStateScope;
  children?: ReactNode;
}) => {
  const [snapshot, setSnapshot] = useState<{
    api: RpcStub<AuthenticatedApi>;
    scopeKey: string;
    state: UserUnreadState;
    replacement: UserUnreadState;
  }>();
  const [failure, setFailure] = useState<{ api: RpcStub<AuthenticatedApi> }>();
  const refreshAfterReconnect = useRef<(() => void) | undefined>(undefined);
  // Don't display another authenticated session's state while its replacement is connecting.
  const scopeKey = typeof scope === "string" ? scope : `workspace:${scope.workspaceId}`;
  const state = snapshot?.api === authenticatedApi && snapshot.scopeKey === scopeKey ? snapshot.state : undefined;

  useEffect(() => {
    let subscription: RpcStub<{}> | undefined;
    let latest: typeof snapshot;
    let active = true;
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    const subscribe = () => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (!active || document.visibilityState === "hidden") return;
      const currentGeneration = ++generation;
      refreshAfterReconnect.current = () => {
        // A replacement received during a mutation need not include its effect. Fence that
        // subscription and fetch once after the ACK; a still-hidden web view waits for foreground.
        if (active && currentGeneration !== generation) subscribe();
      };
      latest = undefined;
      // Cached horizons cannot authorize receipts while the replacement snapshot is pending.
      setSnapshot(undefined);
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
      let live = false;
      let released = false;
      const subscriber = new UnreadSubscriber(
        (next) => {
          if (!active || currentGeneration !== generation) return;
          latest = {api: authenticatedApi, scopeKey, state: next, replacement: next};
          setSnapshot(latest);
          clearTimeout(retryTimer);
          retryTimer = undefined;
          retryDelay = 1_000;
        },
        async (summary) => {
          if (!active || currentGeneration !== generation || !latest) return;
          latest = {...latest, state: applySummary(latest.state, summary)};
          setSnapshot(latest);
        },
        async (workspaceId, chatId, chat, counts) => {
          if (!active || currentGeneration !== generation || !latest) return;
          const chats = latest.state.chats.filter(item =>
            item.workspaceId !== workspaceId || item.chatId !== chatId);
          if (chat) chats.push(chat);
          latest = {...latest, state: {...applySummary(latest.state, counts), chats}};
          setSnapshot(latest);
        },
        () => {
          released = true;
          if (active && live && subscription === nextSubscription) subscribe();
        },
      );
      const nextSubscription = authenticatedApi.subscribeToUnreadState(
        scopeKey === "summary" || scopeKey === "unread" ? scopeKey : {workspaceId: scopeKey.slice("workspace:".length)},
        subscriber as unknown as RpcStub<UnreadStateSubscriber>,
      );
      subscription = nextSubscription;
      nextSubscription.then(
        () => {
          live = true;
          if (released && active && subscription === nextSubscription) subscribe();
        },
        (cause) => {
          if (active && subscription === nextSubscription) {
            logRpcFailure("Unread subscription failed:", cause);
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              subscribe();
            }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        },
      );
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== "hidden") { subscribe(); return; }
      ++generation;
      setSnapshot(undefined);
      clearTimeout(retryTimer);
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    subscribe();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      clearTimeout(retryTimer);
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
    };
  }, [authenticatedApi, scopeKey]);

  const perform = async <T,>(operation: Promise<T>): Promise<T> => {
    try {
      const result = await operation;
      setFailure((previous) => (previous?.api === authenticatedApi ? undefined : previous));
      return result;
    } catch (cause) {
      setFailure({ api: authenticatedApi });
      logRpcFailure("Failed to update read state:", cause);
      throw cause;
    }
  };

  // Explicit menu/bulk actions need an observed boundary. Badges and subscriptions don't.
  const observedReceipts = async (chats: ObservedChat[]) => {
    const needsHead = (chat: ObservedChat) => chat.latestSequence === undefined || chat.latestSequence < 0;
    const heads = new Map(await Promise.all([...new Set(chats.filter(needsHead).map(chat => chat.workspaceId))]
      .map(async workspaceId => [workspaceId, await authenticatedApi.getChatHeads(workspaceId).catch(() => null)] as const)));
    const receipts: ChatReadReceipt[] = [];
    let unavailable = false;
    for (const chat of chats) {
      const sequence = needsHead(chat)
        ? heads.get(chat.workspaceId)?.find(item => item.chatId === chat.chatId)?.latestSequence : chat.latestSequence;
      if (sequence !== undefined) receipts.push(receiptFor(chat, sequence));
      else unavailable = true;
    }
    return {receipts, unavailable};
  };
  const observedReceipt = async (chat: ChatReadState) => {
    const {receipts} = await observedReceipts([chat]);
    if (!receipts.length) throw new Error("Thread is no longer available.");
    return receipts[0];
  };
  const markObservedRead = async (chats: ObservedChat[]) => {
    const {receipts, unavailable} = await observedReceipts(chats);
    if (receipts.length) await authenticatedApi.markChatsRead(receipts);
    if (unavailable) throw new Error("Some threads are no longer available; other read receipts were submitted.");
  };

  return (
    <UnreadContext.Provider
      value={{
        state,
        replacementSnapshot: state ? snapshot?.replacement : undefined,
        markRead: (chat, through) =>
          perform((async () => {
            const receipt = through === undefined ? await observedReceipt(chat) : receiptFor(chat, through);
            await authenticatedApi.markChatRead(receipt);
          })()),
        markManyRead: (chats) => perform(markObservedRead(chats)),
        markWorkspaceRead: (workspaceId) =>
          perform((async () => {
            const chats = (await authenticatedApi.getWorkspaceUnreadState(workspaceId))
              .filter(chat => chat.unreadMessageCount > 0);
            await markObservedRead(chats);
          })()),
        markUnread: (chat, from) =>
          perform((async () => {
            const refresh = refreshAfterReconnect.current;
            const sequence = from ?? (await observedReceipt(chat)).throughSequence;
            if (sequence < 0) return false;
            const changed = await authenticatedApi.markChatUnread(chat.workspaceId, chat.chatId, sequence);
            refresh?.();
            return changed;
          })()),
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {failure?.api === authenticatedApi && (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-center gap-2 bg-kumo-danger-tint p-2 text-sm text-kumo-danger"
          >
            Couldn’t update read state. Please try again.
            <Button size="xs" variant="ghost" onClick={() => setFailure(undefined)}>
              Dismiss
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </UnreadContext.Provider>
  );
};
