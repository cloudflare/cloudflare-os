import type { UnreadThread, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

/** One row of the sidebar's recents: a chat, or a workspace with no chat of the user's to list. */
export type SidebarEntry = {
  /** Unique among the rows: `chat:<workspace>/<chat>` or `workspace:<workspace>`. */
  key: string
  workspaceId: string
  workspaceTitle: string
  /** The chat's, for a chat; a workspace has none. */
  chatId?: number
  title: string
  /** When it was last active. */
  at: Date
  unread: boolean
}

export const chatEntryKey = (workspaceId: string, chatId: number) => `chat:${workspaceId}/${chatId}`
export const workspaceEntryKey = (workspaceId: string) => `workspace:${workspaceId}`

/**
 * The sidebar's recents, most recently active first: each of the user's chats as a row of its own,
 * named with its workspace, and each workspace with no chat to list as one row, so it can still be
 * reached. A chat the user archived, has not joined, or that an agent started is left out (they are
 * on its workspace's page), unless it is the one open.
 */
export const sidebarEntries = (
  workspaces: readonly WorkspaceMetadataWithTimestamps[],
  threads: readonly UnreadThread[],
  open?: { workspaceId: string; chatId: number },
): SidebarEntry[] => {
  const titles = new Map(workspaces.map(({ id, title }) => [id, title]))
  const isOpen = (thread: UnreadThread) => thread.workspaceId === open?.workspaceId && thread.chatId === open.chatId
  const chats = threads.filter((thread) => titles.has(thread.workspaceId) && (isOpen(thread) || (!thread.archived && !thread.unjoined && !thread.spawnerName)))
  const withChats = new Set(chats.map(({ workspaceId }) => workspaceId))
  return [
    ...chats.map((thread): SidebarEntry => ({
      key: chatEntryKey(thread.workspaceId, thread.chatId),
      workspaceId: thread.workspaceId,
      workspaceTitle: titles.get(thread.workspaceId)!,
      chatId: thread.chatId,
      title: thread.chatTitle || 'Untitled chat',
      at: thread.latestActivityAt ?? new Date(0),
      unread: thread.unreadMessageCount > 0,
    })),
    ...workspaces.filter(({ id }) => !withChats.has(id)).map((workspace): SidebarEntry => ({
      key: workspaceEntryKey(workspace.id),
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      title: workspace.title,
      at: workspace.lastActive,
      unread: false,
    })),
  ].toSorted((a, b) => b.at.getTime() - a.at.getTime())
}
