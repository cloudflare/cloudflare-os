import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  AuthenticatedApi,
  ChatReadReceipt,
  ChatReadState,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { logRpcFailure } from "../../rpcErrors";
import { nativeApp } from "../native-app/nativeApp";

class UnreadSubscriber extends RpcTarget implements UnreadStateSubscriber {
  constructor(
    private readonly receive: (state: UserUnreadState) => void,
    private readonly released: () => void,
  ) {
    super();
  }
  async updated(state: UserUnreadState): Promise<void> {
    this.receive(state);
  }
  [Symbol.dispose]() {
    this.released();
  }
}

type UnreadContextValue = {
  state?: UserUnreadState;
  markRead: (chat: ChatReadState, throughSequence?: number) => Promise<void>;
  markManyRead: (chats: ChatReadState[]) => Promise<void>;
  markUnread: (chat: ChatReadState, fromSequence: number) => Promise<void>;
};
const UnreadContext = createContext<UnreadContextValue | null>(null);

/** Returns the shared unread snapshot; absent on public/unauthenticated surfaces. */
export const useUnreadState = () => useContext(UnreadContext);

const receiptFor = (
  chat: ChatReadState,
  throughSequence = chat.latestSequence,
): ChatReadReceipt => ({
  workspaceId: chat.workspaceId,
  chatId: chat.chatId,
  readEpoch: chat.readEpoch,
  throughSequence,
});

/** One background subscription supplies web indicators, timeline cursors and native badges. */
export const UnreadStateBridge = ({
  authenticatedApi,
  children,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
  children?: ReactNode;
}) => {
  const [snapshot, setSnapshot] = useState<{
    api: RpcStub<AuthenticatedApi>;
    state: UserUnreadState;
  }>();
  const [failure, setFailure] = useState<{ api: RpcStub<AuthenticatedApi> }>();
  // Don't display another authenticated session's state while its replacement is connecting.
  const state = snapshot?.api === authenticatedApi ? snapshot.state : undefined;

  useEffect(() => {
    let subscription: RpcStub<{}> | undefined;
    let latest: UserUnreadState | undefined;
    let active = true;
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    const subscribe = () => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      const currentGeneration = ++generation;
      // Revisions are in-memory in the User DO; a reset starts a fresh subscription stream.
      latest = undefined;
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
      let live = false;
      let released = false;
      const subscriber = new UnreadSubscriber(
        (next) => {
          if (!active || currentGeneration !== generation) return;
          if (latest && next.revision <= latest.revision) return;
          latest = next;
          setSnapshot({ api: authenticatedApi, state: next });
          if (next.unavailableWorkspaceIds?.length) {
            // Keep healthy workspaces live, but retry the missing heads even if no new message
            // arrives. Never overwrite the native badge with an incomplete lower bound.
            if (!retryTimer) {
              retryTimer = setTimeout(subscribe, retryDelay);
              retryDelay = Math.min(retryDelay * 2, 30_000);
            }
            return;
          }
          clearTimeout(retryTimer);
          retryTimer = undefined;
          retryDelay = 1_000;
          try {
            nativeApp()?.unreadStateChanged?.(next);
          } catch (cause) {
            logRpcFailure("Native unread-state update failed:", cause);
          }
        },
        () => {
          released = true;
          if (active && live && subscription === nextSubscription) subscribe();
        },
      );
      const nextSubscription = authenticatedApi.subscribeToUnreadState(
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
    subscribe();
    return () => {
      active = false;
      clearTimeout(retryTimer);
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
    };
  }, [authenticatedApi]);

  const perform = async (operation: Promise<void>) => {
    try {
      await operation;
      setFailure((previous) => (previous?.api === authenticatedApi ? undefined : previous));
    } catch (cause) {
      setFailure({ api: authenticatedApi });
      logRpcFailure("Failed to update read state:", cause);
      throw cause;
    }
  };

  return (
    <UnreadContext.Provider
      value={{
        state,
        markRead: (chat, through) =>
          perform(authenticatedApi.markChatRead(receiptFor(chat, through))),
        markManyRead: (chats) =>
          perform(authenticatedApi.markChatsRead(chats.map((chat) => receiptFor(chat)))),
        markUnread: (chat, from) =>
          perform(
            authenticatedApi.markChatUnread(chat.workspaceId, chat.chatId, from, chat.readEpoch),
          ),
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {!!state?.unavailableWorkspaceIds?.length && (
          <div role="status" className="shrink-0 bg-kumo-base p-2 text-center text-sm text-kumo-subtle">
            Some workspace unread counts are unavailable. Retrying…
          </div>
        )}
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
