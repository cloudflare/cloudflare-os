import { useSyncExternalStore } from 'react'
import { setSidebarHidden, useSidebarHidden } from '@/prefs/sidebarHidden'
import { useApi } from '@/rpc/ApiContext'
import { RecentChats } from './RecentChatsStore'
import { useRecentChatsContext } from './RecentChatsContext'
import { recentChatKey, recentChatsOf, type RecentChat } from './recentChats'

const EMPTY = new RecentChats()
const nothing = () => {}

export type RecentChatsValue = {
  chats: RecentChat[]
  /** Every workspace asked has answered: with none listed, there are none. */
  known: boolean
  /** Mutes a chat for the viewer, or unmutes it, shown at once and put back if refused. Rejects with why. */
  setMuted: (chat: RecentChat, muted: boolean) => Promise<void>
  /** Marks a chat read, or its latest message unread, shown at once and put back if refused. Rejects with why. */
  setRead: (chat: RecentChat, read: boolean) => Promise<void>
  /** Takes a chat out of the sidebar on this device, until it waits on the viewer again. */
  hide: (chat: RecentChat) => void
  /** Puts a chat taken out back. */
  unhide: (workspaceId: string, chatId: number) => void
  /** Reads a workspace's chats again ahead of the rest. Stable. */
  refresh: (workspaceId: string) => void
}

/**
 * The viewer's recent chats across their workspaces, as the sidebar lists them (`recentChatsOf`),
 * from what the sweep has read (`AgentsWaitingProvider`), and what can be done to each from there.
 */
export const useRecentChats = (): RecentChatsValue => {
  const { api } = useApi()
  const context = useRecentChatsContext()
  const store = context?.store ?? EMPTY
  const { readings, tails, known } = useSyncExternalStore(store.subscribe, store.snapshot)
  const hidden = useSidebarHidden()

  // Through the chat's workspace, let go of after.
  const inWorkspace = async (workspaceId: string, act: (overseer: ReturnType<typeof api.openWorkspace>) => Promise<unknown>) => {
    const overseer = api.openWorkspace(workspaceId)
    try {
      await act(overseer)
    } finally {
      overseer[Symbol.dispose]()
    }
  }
  const changing = async (chat: RecentChat, change: Parameters<RecentChats['markChat']>[2], act: Parameters<typeof inWorkspace>[1]) => {
    const was = store.markChat(chat.workspaceId, chat.chatId, change)
    try {
      await inWorkspace(chat.workspaceId, act)
    } catch (error) {
      store.restoreChat(chat.workspaceId, chat.chatId, was)
      throw error
    }
  }

  return {
    chats: recentChatsOf(readings, tails, hidden, Date.now()),
    known,
    setMuted: (chat, muted) =>
      changing(chat, { notificationsEnabled: !muted, notificationsEnabledOverride: !muted }, (overseer) => overseer.setChatNotificationsEnabled(chat.chatId, !muted)),
    setRead: (chat, read) =>
      changing(chat, { unreadMessageCount: read ? 0 : 1 }, (overseer) => (read ? overseer.markChatRead(chat.chatId) : overseer.markChatUnread(chat.chatId))),
    hide: (chat) => setSidebarHidden(chat.key, chat.lastActive.getTime()),
    unhide: (workspaceId, chatId) => setSidebarHidden(recentChatKey(workspaceId, chatId), undefined),
    refresh: context?.refresh ?? nothing,
  }
}
