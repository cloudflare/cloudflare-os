import { useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatSession } from './ChatSession'
import { ChatSessions } from './ChatSessions'
import { ChatSessionsContext } from './ChatSessionsContext'

/** Shares one live session for each chat shown beneath it. Needs `WorkspacesProvider` above it. */
export const ChatSessionsProvider = ({ children }: { children: ReactNode }) => {
  const { api, user } = useApi()
  // Stable: when a turn ends the workspace's title and activity may have changed, so the sidebar reloads.
  const refreshWorkspaces = useRefreshWorkspaces()
  const [sessions] = useState(
    () => new ChatSessions((workspaceId, chatId) =>
      new ChatSession(() => api.openWorkspace(workspaceId), chatId, { viewerId: user.id, onTurnEnded: refreshWorkspaces })),
  )
  return <ChatSessionsContext value={sessions}>{children}</ChatSessionsContext>
}
