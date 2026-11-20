import { useChatNotifications } from '@/chat/useChatNotifications'
import { useDevMode } from '@/hooks/useDevMode'
import { useChatFavorites } from '@/prefs/chatFavorites'
import { useApi } from '@/rpc/ApiContext'
import { attentionOf, reviewsOf, workingOf } from './activity/overview'
import { useUnreadPreviews } from './activity/useUnreadPreviews'
import type { useWorkspaceActivity } from './activity/useWorkspaceActivity'
import { ChatListView } from './ChatListView'
import { chatStatesOf, type FailedRun } from './chatStates'
import { useWorkspaceChats } from './useWorkspaceChats'

export type WorkspaceChatListProps = {
  workspaceId: string
  onOpenChat: (chat: { id: number; title: string }) => void
  /** A chat's address, for its row to link to so that it can be opened in another tab. */
  chatHref?: (chatId: number) => string
  /** The viewer may build in the workspace, and so has a read state and decides what waits. */
  builds?: boolean
  /** The chats waiting on a person, by id: stopped on a decision, or with an action waiting. */
  waiting?: ReadonlySet<number>
  /** The workspace's activity, which its page holds: what waits on a decision, and who wrote what in each chat. */
  activity?: ReturnType<typeof useWorkspaceActivity>
  /** The agents whose latest run failed, as the page reads its agents. */
  failed?: readonly FailedRun[]
  /** Marks everything in the workspace read, while anything is. */
  onMarkRead?: () => Promise<void>
  /** Starts a chat in the workspace. */
  onNewChat: () => void
}

/**
 * A workspace's Chats tab (`ChatListView`), from its chats, its activity (what waits, and who wrote
 * what in each), its agents' failed runs, the viewer's read state and the chats they starred.
 */
export const WorkspaceChatList = ({ workspaceId, onOpenChat, chatHref, builds = false, waiting, activity, failed = [], onMarkRead, onNewChat }: WorkspaceChatListProps) => {
  const { user } = useApi()
  const chats = useWorkspaceChats(workspaceId)
  const devMode = useDevMode()
  const notifications = useChatNotifications(workspaceId, builds)
  const favorites = useChatFavorites(workspaceId)
  const all = chats.status === 'ready' ? chats.chats : []
  const ready = activity?.state.status === 'ready' ? activity.state : undefined

  const attention = builds && ready ? attentionOf(ready) : []
  const reviews = builds ? reviewsOf(all) : []
  const states = chatStatesOf({ attention, failed: builds ? failed : [], reviews, working: workingOf(all) })
  const unreadOf = (id: number) => (builds ? notifications.rows.get(id)?.unreadMessageCount ?? 0 : 0)
  const unread = all.filter(({ id }) => unreadOf(id) > 0).map(({ id }) => `${id}:${unreadOf(id)}`).join(',')
  const previews = useUnreadPreviews(workspaceId, unread)
  // Who started a chat, or else who last wrote in it, while its first messages are read.
  const starters = new Map([...(ready?.askers ?? []), ...(ready?.starters ?? [])])

  return (
    <ChatListView
      status={chats.status === 'failed' ? { status: 'failed', message: chats.message } : { status: chats.status }}
      chats={all}
      states={states}
      unreadOf={unreadOf}
      starters={starters}
      latest={ready?.latest ?? new Map()}
      asks={ready?.asks}
      previews={previews}
      favorites={favorites}
      viewerId={user.id}
      showsCost={devMode}
      waiting={waiting}
      onOpenChat={onOpenChat}
      chatHref={chatHref}
      onMarkRead={onMarkRead}
      onNewChat={onNewChat}
    />
  )
}
