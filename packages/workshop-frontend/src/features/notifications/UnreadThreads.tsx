import { Button } from "@cloudflare/kumo";
import { Chats, Check } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { UnreadBadge } from "./UnreadBadge";
import { useUnreadState } from "./UnreadStateBridge";
import { useUnreadPreviews } from "./useUnreadPreviews";

/** A live inbox of unread conversations. Previewing a thread never marks it read. */
export const UnreadThreads = () => {
  const unread = useUnreadState();
  const chats = (unread?.state?.chats ?? [])
    .filter(chat => chat.latestSequence > chat.readThroughSequence)
    .toSorted((a, b) => (b.latestActivityAt?.getTime() ?? 0) - (a.latestActivityAt?.getTime() ?? 0)
      || a.chatTitle.localeCompare(b.chatTitle) || a.workspaceId.localeCompare(b.workspaceId)
      || a.chatId - b.chatId);
  const previews = useUnreadPreviews(chats);
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
      {previews.failed && (
        <div role="status" className="mb-3 flex items-center justify-between gap-3 px-3 text-sm text-kumo-subtle">
          Some message previews couldn’t be loaded.
          <Button size="xs" variant="ghost" onClick={previews.retry}>Retry previews</Button>
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
                  <h2 className="truncate text-sm font-semibold text-kumo-default">{chat.chatTitle || "Untitled thread"}</h2>
                  <p className="mt-1 truncate text-sm text-kumo-subtle">
                    {chat.latestMessagePreview === undefined
                      ? previews.failed ? "Preview unavailable" : "Loading message preview…"
                      : chat.latestMessagePreview || "New activity"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {chat.latestActivityAt && (
                    <time dateTime={chat.latestActivityAt.toISOString()} className="text-xs leading-5 text-kumo-inactive">
                      {chat.latestActivityAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </time>
                  )}
                  <UnreadBadge count={1} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
