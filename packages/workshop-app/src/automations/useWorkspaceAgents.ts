import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { WorkspaceAgents } from './WorkspaceAgents'

/**
 * A workspace's agents (`WorkspaceAgents`), live while mounted; the caller keys it by the
 * workspace. A new API, from a new connection, opens the workspace again, keeping what is shown
 * meanwhile. `retry` reads them again, after they could not be.
 */
export const useWorkspaceAgents = (workspaceId: string) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  // The API it opens the workspace with, read when it does.
  const latestApi = useRef(api)
  const [agents] = useState(() => new WorkspaceAgents(() => latestApi.current.openWorkspace(workspaceId), { connection: notice ?? undefined }))

  useEffect(() => {
    agents.start()
    return () => agents.stop()
  }, [agents])

  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    agents.restart()
  }, [api, agents])

  const snapshot = useSyncExternalStore(agents.subscribe, agents.getSnapshot)
  return { state: snapshot, retry: () => agents.restart() }
}
