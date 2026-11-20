import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { WorkspaceChats, type WorkspaceChatsState } from './WorkspaceChats'

export type { WorkspaceChatsState }

const LOADING: WorkspaceChatsState = { status: 'loading' }

/**
 * The chats people have in one workspace (`WorkspaceChats`), live while mounted, most recently
 * active first. Given none, nothing is read and it stays loading. One workspace's chats are never
 * returned for another's while that one loads; over a new connection, what was shown stays until
 * they are read again.
 */
export const useWorkspaceChats = (workspaceId: string | undefined): WorkspaceChatsState => {
  const { api, reconnecting } = useApi()
  const [loaded, setLoaded] = useState<{ workspaceId: string; state: WorkspaceChatsState }>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting || workspaceId === undefined) return
    const chats = new WorkspaceChats(() => api.openWorkspace(workspaceId))
    const unsubscribe = chats.subscribe(() => setLoaded({ workspaceId, state: chats.getSnapshot() }))
    chats.start()
    return () => {
      unsubscribe()
      chats.stop()
    }
  }, [api, reconnecting, workspaceId])

  return loaded !== undefined && loaded.workspaceId === workspaceId ? loaded.state : LOADING
}
