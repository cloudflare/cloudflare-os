import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { SharingSession, type SharingSnapshot } from './SharingSession'
import type { ShareTarget } from './sharingRules'

/**
 * Who a workspace is shared with, live while `open`: read when it opens, and let go when it
 * closes. Given `sharing`, it is for sharing it, or one of its gadgets (`target`), which reads the
 * viewer's link (to `page`) and what its connections ask of whoever it is shared with too. Over a lost connection it waits, as anything
 * else does, for the new one, and starts over on it. The session is made for the workspace and
 * what is shared as it is first given, so key the caller by them.
 */
export const useSharing = (workspaceId: string, open: boolean, sharing?: { page: string; target: ShareTarget }) => {
  const { api, reconnecting, user } = useApi()
  // Whichever `api` is current when the session opens the workspace, which may be a new connection's.
  const [latest] = useState(() => ({ api }))
  latest.api = api
  const [session] = useState(() => new SharingSession({
    open: () => latest.api.openWorkspace(workspaceId),
    sharing: sharing && { ...sharing, viewerId: user.id, vendors: () => latest.api.listGatekeeperVendors() },
  }))
  const snapshot: SharingSnapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)

  useEffect(() => {
    if (!open || reconnecting) return
    session.start()
    return () => session.stop()
  }, [session, open, reconnecting, api])

  return { snapshot, session }
}
