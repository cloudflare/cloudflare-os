import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatSession } from './ChatSession'
import { ChatSessions } from './ChatSessions'
import { ChatSessionsContext } from './ChatSessionsContext'

/**
 * Shares one live session for each chat shown beneath it. Needs `WorkspacesProvider` above it. A
 * new API, from a new connection, connects them all again, keeping what each shows meanwhile.
 */
export const ChatSessionsProvider = ({ children }: { children: ReactNode }) => {
  const { api, user } = useApi()
  // Stable: when a turn ends the workspace's title and activity may have changed, so the sidebar reloads.
  const refreshWorkspaces = useRefreshWorkspaces()
  // The API sessions open their workspace with, read when they connect.
  const latestApi = useRef(api)
  const [sessions] = useState(
    () => new ChatSessions((workspaceId, chatId) =>
      new ChatSession(() => latestApi.current.openWorkspace(workspaceId), chatId, { viewerId: user.id, onTurnEnded: refreshWorkspaces })),
  )
  // A layout effect, so the new API is in place before any session started in the same commit
  // connects, which happens in a passive effect.
  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    sessions.reconnect()
  }, [api, sessions])
  return <ChatSessionsContext value={sessions}>{children}</ChatSessionsContext>
}
