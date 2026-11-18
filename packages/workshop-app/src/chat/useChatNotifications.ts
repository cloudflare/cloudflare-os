import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { ChatNotifications } from './ChatNotifications'

/**
 * The viewer's notifications for a workspace's chats and what of each is unread, live while
 * `live`, and the ways to change a chat's or mark it read or unread. Not for a workspace the viewer
 * can only use, whose chats are not theirs to change.
 */
export const useChatNotifications = (workspaceId: string, live: boolean) => {
  const { api, reconnecting } = useApi()
  // One for each connection, as a new one makes the subscription again.
  const notifications = useMemo(
    () => new ChatNotifications({ subscribe: (listener) => api.subscribeToUnreadState({ workspaceId }, listener), open: () => api.openWorkspace(workspaceId) }, workspaceId),
    [api, workspaceId],
  )
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (!live || reconnecting) return
    notifications.start()
    return () => notifications.stop()
  }, [notifications, live, reconnecting])
  const rows = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot)
  return { rows, setEnabled: notifications.setEnabled, setRead: notifications.setRead }
}
