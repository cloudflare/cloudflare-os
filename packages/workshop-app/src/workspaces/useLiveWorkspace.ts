import { useEffect } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { LiveWorkspace } from './LiveWorkspace'
import { useUpdateWorkspace } from './WorkspacesContext'

/**
 * Keeps what the list shows of the open workspace (`workspaceId`) up with what it says of itself
 * that the list does not keep (see `LiveWorkspace`), for as long as it is open: what its data
 * allows, and what it has cost. Nothing, for no workspace.
 */
export const useLiveWorkspace = (workspaceId: string | undefined) => {
  const { api, reconnecting } = useApi()
  const update = useUpdateWorkspace()
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting || workspaceId === undefined) return
    const live = new LiveWorkspace(() => api.openWorkspace(workspaceId), (fields) => update(workspaceId, fields))
    live.start()
    return () => live.stop()
  }, [api, reconnecting, workspaceId, update])
}
