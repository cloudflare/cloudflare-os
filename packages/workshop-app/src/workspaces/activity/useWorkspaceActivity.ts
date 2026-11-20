import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { WorkspaceActivity } from './WorkspaceActivity'

/**
 * A workspace's activity (`WorkspaceActivity`), live while mounted; the caller keys it by the
 * workspace. A new API, from a new connection, opens the workspace again, keeping what is shown
 * meanwhile.
 */
export const useWorkspaceActivity = (workspaceId: string) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const latestApi = useRef(api)
  const [activity] = useState(() => new WorkspaceActivity(() => latestApi.current.openWorkspace(workspaceId), { connection: notice ?? undefined }))

  useEffect(() => {
    activity.start()
    return () => activity.stop()
  }, [activity])

  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    activity.restart()
  }, [api, activity])

  const state = useSyncExternalStore(activity.subscribe, activity.getSnapshot)
  return { state, activity }
}
