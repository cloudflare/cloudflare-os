import type { UnreadThread } from '@gadgets/workshop-shared/api'

/** A chat to carry on in with an item beside it. */
export type ItemChat = {
  chatId: number
  title: string
  at: Date
  /** It had the item beside it when it was last open, in this browser. */
  showing: boolean
}

// As many as a menu offers without becoming a list to read.
const SHOWN = 4

/**
 * The chats of the user's in a workspace to carry on in with an item beside it: those that last had
 * it open first, then the most recently active. Not one the user archived or has not joined, or one
 * an agent started, as the sidebar's recents leave them out (`sidebarEntries`).
 */
export const itemChats = (
  threads: readonly UnreadThread[],
  workspaceId: string,
  /** The item, as `?open=` names it. */
  open: string,
  /** What was last shown beside a chat (`lastShown`). */
  shownIn: (workspaceId: string, chatId: number) => string | undefined,
): ItemChat[] =>
  threads
    .filter((thread) => thread.workspaceId === workspaceId && !thread.archived && !thread.unjoined && !thread.spawnerName)
    .map((thread): ItemChat => ({
      chatId: thread.chatId,
      title: thread.chatTitle || 'Untitled chat',
      at: thread.latestActivityAt ?? new Date(0),
      showing: shownIn(workspaceId, thread.chatId) === open,
    }))
    .toSorted((a, b) => Number(b.showing) - Number(a.showing) || b.at.getTime() - a.at.getTime())
    .slice(0, SHOWN)
