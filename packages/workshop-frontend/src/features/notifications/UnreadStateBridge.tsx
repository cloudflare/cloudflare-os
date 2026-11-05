import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AuthenticatedApi,
  Overseer,
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

// An initial snapshot can settle missed transitions even when its horizon matches the cached row.
type UnreadUpdateListener = (state: UserUnreadState, initialSnapshot: boolean) => void;

type UnreadContextValue = {
  /** Last snapshot for this API. Rollups survive resubscription; use chats for fresh cursors. */
  state?: UserUnreadState;
  /** Fresh cursors for the current scope; cached totals alone cannot authorize receipts. */
  chats?: UserUnreadState["chats"];
  /** Process server transitions before React can batch consecutive state updates. */
  subscribeToUpdates: (listener: UnreadUpdateListener) => () => void;
  markRead: (overseer: Pick<Overseer, "markChatRead">, chatId: number, throughSequence?: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  markWorkspaceRead: (workspaceId: string) => Promise<void>;
  markUnread: (overseer: Pick<Overseer, "markChatUnread">, chatId: number, fromSequence?: number) => Promise<boolean>;
};
const UnreadContext = createContext<UnreadContextValue | null>(null);

/** Returns badge rollups and this view's scoped rows; absent on unauthenticated surfaces. */
export const useUnreadState = () => useContext(UnreadContext);

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
    scopeKey?: string;
    state: UserUnreadState;
  }>();
  const toasts = useKumoToastManager();
  const currentApi = useRef<RpcStub<AuthenticatedApi> | undefined>(authenticatedApi);
  useEffect(() => {
    currentApi.current = authenticatedApi;
    return () => { currentApi.current = undefined; };
  }, [authenticatedApi]);
  const updateListeners = useRef(new Set<UnreadUpdateListener>());
  const subscribeToUpdates = useCallback((listener: UnreadUpdateListener) => {
    updateListeners.current.add(listener);
    return () => { updateListeners.current.delete(listener); };
  }, []);
  // Don't display another authenticated session's state while its replacement is connecting.
  const scopeKey = typeof scope === "string" ? scope : `workspace:${scope.workspaceId}`;
  const state = snapshot?.api === authenticatedApi ? snapshot.state : undefined;
  const scopedChats = snapshot?.api === authenticatedApi && snapshot.scopeKey === scopeKey ? snapshot.state.chats : undefined;

  useEffect(() => {
    let subscription: RpcStub<{}> | undefined;
    let latest: typeof snapshot;
    let active = true;
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    const publish = (initialSnapshot = false) => {
      if (!latest) return;
      for (const listener of updateListeners.current) listener(latest.state, initialSnapshot);
      setSnapshot(latest);
    };
    const subscribe = () => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (!active || document.visibilityState === "hidden") return;
      const currentGeneration = ++generation;
      latest = undefined;
      // Cached horizons cannot authorize receipts while the replacement snapshot is pending.
      setSnapshot(previous => previous && {...previous, scopeKey: undefined});
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
      let live = false;
      let released = false;
      const subscriber = new UnreadSubscriber(
        (next) => {
          if (!active || currentGeneration !== generation) return;
          const initialSnapshot = !latest;
          latest = {api: authenticatedApi, scopeKey, state: next};
          publish(initialSnapshot);
          clearTimeout(retryTimer);
          retryTimer = undefined;
          retryDelay = 1_000;
        },
        async (summary) => {
          if (!active || currentGeneration !== generation || !latest) return;
          latest = {...latest, state: applySummary(latest.state, summary)};
          publish();
        },
        async (workspaceId, chatId, chat, counts) => {
          if (!active || currentGeneration !== generation || !latest) return;
          const chats = latest.state.chats.filter(item =>
            item.workspaceId !== workspaceId || item.chatId !== chatId);
          if (chat) chats.push(chat);
          latest = {...latest, state: {...applySummary(latest.state, counts), chats}};
          publish();
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
      setSnapshot(previous => previous && {...previous, scopeKey: undefined});
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
      return await operation;
    } catch (cause) {
      if (!logRpcFailure("Failed to update read state:", cause) && currentApi.current === authenticatedApi) {
        toasts.add({ id: "unread-update-failed", title: "Couldn’t update read state", variant: "error" });
      }
      throw cause;
    }
  };

  return (
    <UnreadContext.Provider
      value={{
        state,
        chats: scopedChats,
        subscribeToUpdates,
        markRead: (overseer, chatId, through) => perform(overseer.markChatRead(chatId, through)),
        markAllRead: () => perform(authenticatedApi.markAllRead()),
        markWorkspaceRead: (workspaceId) => perform(authenticatedApi.markWorkspaceRead(workspaceId)),
        markUnread: (overseer, chatId, from) => perform(overseer.markChatUnread(chatId, from)),
      }}
    >
      {children}
    </UnreadContext.Provider>
  );
};
