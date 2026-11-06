import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatSession, type ChatSnapshot } from './ChatSession'

/**
 * The live conversation of one workspace, and a way to send to it. The session is fixed to the
 * `workspaceId` it is created with, so give the calling component a `key` of the id to switch
 * workspaces.
 */
export const useChatSession = (workspaceId: string): { chat: ChatSnapshot; send: ChatSession['send'] } => {
  const { api } = useApi()
  const refreshWorkspaces = useRefreshWorkspaces()
  // Creating a session is free; it connects only when started, in the effect below. When a turn
  // ends the workspace's title may have changed, so the sidebar reloads.
  const [session] = useState(
    () => new ChatSession(() => api.openWorkspace(workspaceId), { onTurnEnded: refreshWorkspaces }),
  )

  useEffect(() => {
    session.start()
    return () => session.stop()
  }, [session])

  const chat = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { chat, send: session.send }
}
