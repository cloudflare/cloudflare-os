import { Button } from "@cloudflare/kumo";
import { Chats, Check } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { UnreadThread } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import { UnreadBadge } from "./UnreadBadge";
import { useUnreadState } from "./UnreadStateBridge";

/** A live inbox of unread conversations. Previewing a thread never marks it read. */
export const UnreadThreads = () => {
  const unread = useUnreadState();
  const { authenticatedApi } = useAuthenticatedApi();
  const state = unread?.state;
  const [result, setResult] = useState<{
    api: RpcStub<AuthenticatedApi>;
    chats: UnreadThread[];
    failed: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void authenticatedApi.getUnreadThreads().then(chats => {
      if (active) setResult({api: authenticatedApi, chats, failed: false});
    }, () => {
      if (active) setResult(previous => ({api: authenticatedApi,
        chats: previous?.api === authenticatedApi ? previous.chats : [], failed: true}));
    });
    return () => { active = false; };
  }, [authenticatedApi, state, retry]);
  const inbox = result?.api === authenticatedApi ? result : undefined;
  const chats = inbox?.chats ?? [];
  const [markingRead, setMarkingRead] = useState(false);

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
      <header className="flex flex-wrap items-center justify-between gap-4 px-3 pb-5 pt-6 sm:pt-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Unread threads</h1>
          <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
            New activity across your workspaces.
          </p>
        </div>
        <Button size="sm" icon={<Check size={14} />} disabled={!chats.length}
          loading={markingRead} onClick={async () => {
            setMarkingRead(true);
            try { await unread?.markManyRead(chats); }
            catch { /* The shared unread bridge presents the failure. */ }
            finally { setMarkingRead(false); }
          }}>
          Mark all read
        </Button>
      </header>
      {inbox?.failed && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-kumo-subtle">
          Couldn’t refresh unread threads. Please try again.
          <Button size="xs" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry</Button>
        </div>
      )}
      {!inbox ? (
        <p role="status" className="px-3 py-8 text-sm text-kumo-subtle">Loading unread threads…</p>
      ) : chats.length === 0 && !inbox.failed ? (
        <div role="status" className="flex flex-col items-center gap-3 px-3 py-16 text-center">
          <Chats size={32} className="text-kumo-inactive" />
          <h2 className="text-base font-medium text-kumo-default">You’re all caught up</h2>
          <p className="text-sm text-kumo-subtle">New activity will appear here.</p>
        </div>
      ) : (
        <ul aria-label="Unread threads" className="min-h-0 flex-1 divide-y divide-kumo-line overflow-y-auto pb-6">
          {chats.map(chat => (
            <li key={`${chat.workspaceId}:${chat.chatId}`}>
              <Link to="/workspace/$id" params={{ id: chat.workspaceId }}
                search={{ chat: chat.chatId, showChat: true }}
                className="flex min-w-0 items-start gap-3 rounded-lg px-3 py-4 transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold text-kumo-default">{chat.chatTitle || `Thread ${chat.chatId}`}</h2>
                  <p className="mt-1 truncate text-sm text-kumo-subtle">
                    {chat.latestMessagePreview || "New activity"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {chat.latestActivityAt && (
                    <time dateTime={chat.latestActivityAt.toISOString()} className="text-xs leading-5 text-kumo-inactive">
                      {chat.latestActivityAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </time>
                  )}
                  <UnreadBadge count={chat.unreadMessageCount} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
