import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { AgentRunList } from './AgentRunList'

/**
 * One agent's runs (`AgentRunList`), by its spawner's id, live while mounted; the caller keys it
 * by the workspace and the agent. A new API, from a new connection, reads them again, keeping what
 * is shown meanwhile. `more` reads the next page, and `retry` reads them again, after they could
 * not be.
 */
export const useAgentRunList = (workspaceId: string, spawnerId: number) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  // The API it opens the workspace with, read when it does.
  const latestApi = useRef(api)
  const [runs] = useState(() => new AgentRunList(() => latestApi.current.openWorkspace(workspaceId), spawnerId, { connection: notice ?? undefined }))

  useEffect(() => {
    runs.start()
    return () => runs.stop()
  }, [runs])

  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    runs.restart()
  }, [api, runs])

  const snapshot = useSyncExternalStore(runs.subscribe, runs.getSnapshot)
  return { state: snapshot, more: () => runs.more(), retry: () => runs.restart() }
}
