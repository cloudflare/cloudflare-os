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

class UnreadSubscriber extends RpcTarget implements UnreadStateSubscriber {
  constructor(
    private readonly receive: (state: UserUnreadState) => void,
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
  [Symbol.dispose]() {
    this.released();
  }
}

type UnreadContextValue = {
  state?: UserUnreadState;
  markRead: (chat: ChatReadState, throughSequence?: number) => Promise<void>;
  markManyRead: (chats: ChatReadState[]) => Promise<void>;
  markUnread: (chat: ChatReadState, fromSequence?: number) => Promise<void>;
};
const UnreadContext = createContext<UnreadContextValue | null>(null);

/** Returns the shared unread snapshot; absent on public/unauthenticated surfaces. */
export const useUnreadState = () => useContext(UnreadContext);

const receiptFor = (
  chat: ChatReadState,
  throughSequence: number,
): ChatReadReceipt => ({
  workspaceId: chat.workspaceId,
  chatId: chat.chatId,
  throughSequence,
});

/** One visible-session subscription supplies web indicators and timeline cursors. */
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
      if (!active || document.visibilityState === "hidden") return;
      const currentGeneration = ++generation;
      latest = undefined;
      const previous = subscription;
      subscription = undefined;
      previous?.[Symbol.dispose]();
      let live = false;
      let released = false;
      const subscriber = new UnreadSubscriber(
        (next) => {
          if (!active || currentGeneration !== generation) return;
          latest = next;
          setSnapshot({ api: authenticatedApi, state: next });
          clearTimeout(retryTimer);
          retryTimer = undefined;
          retryDelay = 1_000;
        },
        async (workspaceId, chatId, chat, counts) => {
          if (!active || currentGeneration !== generation || !latest) return;
          const chats = latest.chats.filter(item =>
            item.workspaceId !== workspaceId || item.chatId !== chatId);
          if (chat) chats.push(chat);
          latest = {...latest, ...counts, chats};
          setSnapshot({api: authenticatedApi, state: latest});
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
    const visibilityChanged = () => {
      if (document.visibilityState !== "hidden") { subscribe(); return; }
      ++generation;
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

  // Explicit menu/bulk actions need an observed boundary. Badges and subscriptions don't.
  const observedReceipts = async (chats: ChatReadState[]): Promise<ChatReadReceipt[]> => {
    const heads = new Map(await Promise.all([...new Set(chats.map(chat => chat.workspaceId))]
      .map(async workspaceId => [workspaceId, await authenticatedApi.getChatHeads(workspaceId)] as const)));
    return chats.map(chat => {
      const head = heads.get(chat.workspaceId)?.find(item => item.chatId === chat.chatId);
      if (!head) throw new Error("Thread is no longer available.");
      return receiptFor(chat, head.latestSequence);
    });
  };

  return (
    <UnreadContext.Provider
      value={{
        state,
        markRead: (chat, through) =>
          perform((async () => {
            const receipt = through === undefined ? (await observedReceipts([chat]))[0] : receiptFor(chat, through);
            await authenticatedApi.markChatRead(receipt);
          })()),
        markManyRead: (chats) =>
          perform((async () => {
            await authenticatedApi.markChatsRead(await observedReceipts(chats));
          })()),
        markUnread: (chat, from) =>
          perform((async () => {
            const sequence = from ?? (await observedReceipts([chat]))[0].throughSequence;
            if (sequence >= 0) await authenticatedApi.markChatUnread(chat.workspaceId, chat.chatId, sequence);
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
