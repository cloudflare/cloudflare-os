import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { ChatSession, type ChatSnapshot } from './ChatSession'

/**
 * The conversation of one workspace. The session is fixed to the `workspaceId` it is created with,
 * so give the calling component a `key` of the id to switch workspaces.
 */
export const useChatSession = (workspaceId: string): ChatSnapshot => {
  const { api } = useApi()
  // Creating a session is free; it connects only when started, in the effect below.
  const [session] = useState(() => new ChatSession(() => api.openWorkspace(workspaceId)))

  useEffect(() => {
    session.start()
    return () => session.stop()
  }, [session])

  return useSyncExternalStore(session.subscribe, session.getSnapshot)
}
