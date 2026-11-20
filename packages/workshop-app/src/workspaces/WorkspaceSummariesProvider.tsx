import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { WorkspaceSummaries } from './WorkspaceSummaries'
import { WorkspaceSummariesContext } from './WorkspaceSummariesContext'

/**
 * Keeps every workspace's summary live for everything beneath it (`useWorkspaceSummaries`): one
 * subscription for the whole app, made again on each new connection without clearing the store.
 */
export const WorkspaceSummariesProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [summaries] = useState(() => new WorkspaceSummaries())
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting) return
    summaries.start({ subscribe: (listener) => api.subscribeToWorkspaceSummaries(listener) })
    return () => summaries.stop()
  }, [api, reconnecting, summaries])
  return <WorkspaceSummariesContext value={summaries}>{children}</WorkspaceSummariesContext>
}
