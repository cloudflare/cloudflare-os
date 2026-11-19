import { useEffect, useState } from 'react'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type WorkspaceChatsState =
  | { status: 'loading' }
  | { status: 'ready'; chats: AiChatMetadata[] }
  | { status: 'failed'; message: string }

const LOADING: WorkspaceChatsState = { status: 'loading' }

// What each workspace's chats were when last read, for the visit: shown again while they are read
// again, so that coming back to a list (the sidebar going into a workspace, its page) does not
// empty it first.
const lastRead = new Map<string, AiChatMetadata[]>()

/**
 * The chats in one workspace, most recently active first, loaded once for each workspace it is
 * given, and shown as they were last read meanwhile. Given none, nothing is loaded and it stays
 * loading. One workspace's chats are never returned for another's while that one loads. A
 * `reading` that changes reads them again, over what was read before.
 */
export const useWorkspaceChats = (workspaceId: string | undefined, reading?: unknown): WorkspaceChatsState => {
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
        lastRead.set(workspaceId, byRecentActivity)
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
    // `reading` is only there to read again when it changes.
  }, [api, reconnecting, workspaceId, reading])

  if (loaded !== undefined && loaded.workspaceId === workspaceId) return loaded.state
  const before = workspaceId === undefined ? undefined : lastRead.get(workspaceId)
  return before ? { status: 'ready', chats: before } : LOADING
}
