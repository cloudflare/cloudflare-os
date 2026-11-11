import { useEffect, useState } from 'react'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type WorkspaceChatsState =
  | { status: 'loading' }
  | { status: 'ready'; chats: AiChatMetadata[] }
  | { status: 'failed'; message: string }

/**
 * The chats in one workspace, most recently active first, loaded once when mounted. The state is
 * not reset when `workspaceId` changes, so give the calling component a `key` of the id.
 */
export const useWorkspaceChats = (workspaceId: string): WorkspaceChatsState => {
  const { api } = useApi()
  const [state, setState] = useState<WorkspaceChatsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    overseer.listChats().then(
      (chats) => {
        if (cancelled) return
        const byRecentActivity = chats.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
        setState({ status: 'ready', chats: byRecentActivity })
      },
      (error) => {
        if (!cancelled) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, workspaceId])

  return state
}
