import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatSession, type ChatSnapshot } from './ChatSession'

/** What can be asked of a chat. Each is stable for the life of the session. */
export type ChatActions = Pick<
  ChatSession,
  'send' | 'loadEarlier' | 'retry' | 'approveAction' | 'rejectAction' | 'denyConnection' | 'setHookEnabled'
>

/**
 * One chat, live, and what can be asked of it. The session is fixed to the chat it is created
 * with, so give the calling component a `key` of the ids to switch chats.
 */
export const useChatSession = (workspaceId: string, chatId: number): { chat: ChatSnapshot; actions: ChatActions } => {
  const { api, user } = useApi()
  const refreshWorkspaces = useRefreshWorkspaces()
  // Creating a session is free; it connects only when started, in the effect below. When a turn
  // ends the workspace's title and activity may have changed, so the sidebar reloads.
  const [session] = useState(
    () => new ChatSession(() => api.openWorkspace(workspaceId), chatId, { viewerId: user.id, onTurnEnded: refreshWorkspaces }),
  )

  useEffect(() => {
    session.start()
    return () => session.stop()
  }, [session])

  const chat = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { chat, actions: session }
}
