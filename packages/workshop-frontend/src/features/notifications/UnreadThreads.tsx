import { Button } from "@cloudflare/kumo";
import { Chats, Check } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ChatTimelineHead } from "@gadgets/workshop-shared/api";
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
  const [metadata, setMetadata] = useState<{
    api: RpcStub<AuthenticatedApi>;
    heads: Map<string, ChatTimelineHead>;
    failed: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const workspaceIds = [...new Set((state?.chats ?? [])
      .filter(chat => chat.unreadMessageCount > 0).map(chat => chat.workspaceId))];
    void Promise.allSettled(workspaceIds.map(async workspaceId =>
      ({workspaceId, heads: await authenticatedApi.getChatHeads(workspaceId)})))
      .then(results => {
        if (!active) return;
        const heads = new Map<string, ChatTimelineHead>();
        let failed = false;
        for (const result of results) {
          if (result.status === "rejected" || result.value.heads === null) { failed = true; continue; }
          for (const head of result.value.heads) heads.set(`${result.value.workspaceId}:${head.chatId}`, head);
        }
        setMetadata({api: authenticatedApi, heads, failed});
      });
    return () => { active = false; };
  }, [authenticatedApi, state, retry]);
  const heads = metadata?.api === authenticatedApi ? metadata.heads : undefined;
  const chats = (state?.chats ?? [])
    .filter(chat => chat.unreadMessageCount > 0)
    .map(chat => ({...heads?.get(`${chat.workspaceId}:${chat.chatId}`), ...chat}))
    .toSorted((a, b) => (b.latestActivityAt?.getTime() ?? 0) - (a.latestActivityAt?.getTime() ?? 0)
      || (a.chatTitle ?? "").localeCompare(b.chatTitle ?? "") || a.workspaceId.localeCompare(b.workspaceId)
      || a.chatId - b.chatId);
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
      {metadata?.api === authenticatedApi && metadata.failed && (
        <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm text-kumo-subtle">
          Some thread previews couldn’t load. Your unread counts are still available.
          <Button size="xs" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry</Button>
        </div>
      )}
      {!unread?.state ? (
        <p role="status" className="px-3 py-8 text-sm text-kumo-subtle">Loading unread threads…</p>
      ) : chats.length === 0 ? (
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
