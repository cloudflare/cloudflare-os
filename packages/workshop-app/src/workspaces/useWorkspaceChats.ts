import { useEffect, useState } from 'react'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type WorkspaceChatsState =
  | { status: 'loading' }
  | { status: 'ready'; chats: AiChatMetadata[] }
  | { status: 'failed'; message: string }

const LOADING: WorkspaceChatsState = { status: 'loading' }

/**
 * The chats in one workspace, most recently active first, loaded once for each workspace it is
 * given. Given none, nothing is loaded and it stays loading. One workspace's chats are never
 * returned for another's while that one loads.
 */
export const useWorkspaceChats = (workspaceId: string | undefined): WorkspaceChatsState => {
  const { api, reconnecting } = useApi()
  const [loaded, setLoaded] = useState<{ workspaceId: string; state: WorkspaceChatsState }>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting || workspaceId === undefined) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    overseer.listChats().then(
      (chats) => {
        if (cancelled) return
        const byRecentActivity = chats.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
        setLoaded({ workspaceId, state: { status: 'ready', chats: byRecentActivity } })
      },
      (error) => {
        if (!cancelled) setLoaded({ workspaceId, state: { status: 'failed', message: error instanceof Error ? error.message : String(error) } })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, reconnecting, workspaceId])

  return loaded !== undefined && loaded.workspaceId === workspaceId ? loaded.state : LOADING
}
