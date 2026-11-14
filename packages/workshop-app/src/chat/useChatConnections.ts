import { useEffect, useState } from 'react'
import type { ChatConnectionInfo } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type ChatConnectionsState =
  | { status: 'loading' }
  | { status: 'ready'; connections: ChatConnectionInfo[] }
  | { status: 'failed'; message: string }

/**
 * What a chat's agent can use (`listChatConnections()`): read once mounted, and again over a new
 * connection, keeping what was read meanwhile.
 */
export const useChatConnections = (workspaceId: string, chatId: number): ChatConnectionsState => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<ChatConnectionsState>({ status: 'loading' })
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (reconnecting) return
    let current = true
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspaceId)
    overseer.listChatConnections(chatId).then(
      (connections) => current && setState({ status: 'ready', connections }),
      (error: unknown) => current && setState((was) => (was.status === 'ready' ? was : { status: 'failed', message: error instanceof Error ? error.message : String(error) })),
    ).finally(() => overseer[Symbol.dispose]())
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, chatId])
  return state
}
