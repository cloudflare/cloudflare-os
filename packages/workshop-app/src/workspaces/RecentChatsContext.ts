import { createContext, useContext } from 'react'
import type { RecentChats } from './RecentChatsStore'

export type RecentChatsContextValue = {
  store: RecentChats
  /** Reads a workspace's chats again ahead of the rest, as when one of them was just opened. */
  refresh: (workspaceId: string) => void
}

/** The viewer's chats as the sidebar's sweep reads them (`AgentsWaitingProvider`). */
export const RecentChatsContext = createContext<RecentChatsContextValue | null>(null)

/** What the sidebar's sweep has read of the viewer's chats, beneath `AgentsWaitingProvider`; null elsewhere. */
export const useRecentChatsContext = (): RecentChatsContextValue | null => useContext(RecentChatsContext)
