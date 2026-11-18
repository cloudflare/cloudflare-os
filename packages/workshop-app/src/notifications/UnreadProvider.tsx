import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { UnreadContext } from './UnreadContext'
import { UnreadSummary } from './UnreadSummary'

/**
 * Keeps the viewer's unread totals live for everything beneath it (`useUnread`): one subscription
 * for the whole app, made again on each new connection.
 */
export const UnreadProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  // One for each connection, as a new one makes the subscription again.
  const summary = useMemo(() => new UnreadSummary({ subscribe: (listener) => api.subscribeToUnreadState('summary', listener) }), [api])
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting) return
    summary.start()
    return () => summary.stop()
  }, [summary, reconnecting])
  const totals = useSyncExternalStore(summary.subscribe, summary.getSnapshot)
  const value = useMemo(
    () => ({ totals, markWorkspaceRead: (workspaceId: string) => api.markWorkspaceRead(workspaceId), markAllRead: () => api.markAllRead() }),
    [totals, api],
  )
  return <UnreadContext value={value}>{children}</UnreadContext>
}
