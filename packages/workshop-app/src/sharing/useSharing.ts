import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { SharingSession, type SharingOptions, type SharingSnapshot } from './SharingSession'

/**
 * Who a workspace, or one of its gadgets, is shared with, live while `open`: read when it opens, and
 * let go when it closes. Over a lost connection it waits, as anything else does, for the new one,
 * and starts over on it. The session is made for the workspace and gadget it is first given, so
 * key the caller by them.
 */
export const useSharing = (workspaceId: string, options: SharingOptions, open: boolean) => {
  const { api, reconnecting } = useApi()
  // Whichever `api` is current when the session opens the workspace, which may be a new connection's.
  const [latest] = useState(() => ({ api }))
  latest.api = api
  const [session] = useState(() => new SharingSession(() => latest.api.openWorkspace(workspaceId), options))
  const snapshot: SharingSnapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)

  useEffect(() => {
    if (!open || reconnecting) return
    session.start()
    return () => session.stop()
  }, [session, open, reconnecting, api])

  return { snapshot, session }
}
