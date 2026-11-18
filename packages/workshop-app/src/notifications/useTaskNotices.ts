import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useHandler } from '@/hooks/useHandler'
import { useApi } from '@/rpc/ApiContext'
import { TaskNotices } from './TaskNotices'

/**
 * The viewer's latest task notification, shown in this tab while it is in view (see
 * `TaskNotices`), and the way to put it away. `isShown` says whether a chat is on screen, which
 * is not told of; it is read as each arrives, so it need not be stable.
 */
export const useTaskNotices = (isShown: (workspaceId: string, chatId: number) => boolean) => {
  const { api, reconnecting } = useApi()
  const shown = useHandler(isShown)
  // One for each connection, as a new one makes the subscription again.
  const notices = useMemo(
    () => new TaskNotices({ subscribe: (listener) => api.subscribeToNotifications(listener) }, shown),
    [api, shown],
  )
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting) return
    notices.start()
    return () => notices.stop()
  }, [notices, reconnecting])
  const notice = useSyncExternalStore(notices.subscribe, notices.getSnapshot)
  return { notice, dismiss: notices.dismiss }
}
