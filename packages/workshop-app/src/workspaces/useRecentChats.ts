import { useSyncExternalStore } from 'react'
import { setSidebarHidden, useSidebarHidden } from '@/prefs/sidebarHidden'
import { useApi } from '@/rpc/ApiContext'
import { RecentChats } from './RecentChatsStore'
import { useRecentChatsContext } from './RecentChatsContext'
import { useWorkspaceSummaries } from './WorkspaceSummariesContext'
import { recentChatsOf, type RecentChat } from './recentChats'

const EMPTY = new RecentChats()

export type RecentChatsValue = {
  chats: RecentChat[]
  /** The account has said: with none listed, there are none. */
  known: boolean
  /** Mutes a chat for the viewer, or unmutes it, shown at once and put back if refused. Rejects with why. */
  setMuted: (chat: RecentChat, muted: boolean) => Promise<void>
  /** Takes a chat out of the sidebar on this device, until it waits on the viewer again. */
  hide: (chat: RecentChat) => void
}

/**
 * The viewer's recent chats across their workspaces, as the sidebar lists them (`recentChatsOf`),
 * from the account's tracked chats (`RecentChatsProvider`) and what waits on them in each workspace
 * (`WorkspaceSummariesProvider`), and what can be done to each from there.
 */
export const useRecentChats = (): RecentChatsValue => {
  const { api } = useApi()
  const store = useRecentChatsContext() ?? EMPTY
  const { threads, known } = useSyncExternalStore(store.subscribe, store.snapshot)
  const summaries = useWorkspaceSummaries()
  const hidden = useSidebarHidden()

  return {
    chats: recentChatsOf(threads.values(), summaries.workspaces, hidden, Date.now()),
    known: known && summaries.known,
    setMuted: async (chat, muted) => {
      const was = store.markChat(chat.workspaceId, chat.chatId, { notificationsEnabled: !muted, notificationsEnabledOverride: !muted })
      const overseer = api.openWorkspace(chat.workspaceId)
      try {
        await overseer.setChatNotificationsEnabled(chat.chatId, !muted)
      } catch (error) {
        store.restoreChat(chat.workspaceId, chat.chatId, was)
        throw error
      } finally {
        overseer[Symbol.dispose]()
      }
    },
    hide: (chat) => setSidebarHidden(chat.key, chat.lastActive.getTime()),
  }
}
