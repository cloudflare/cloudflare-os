import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { useRefreshWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatSession, type ChatSnapshot } from './ChatSession'

/**
 * One chat, live, and a way to send to it. The session is fixed to the chat it is created with, so
 * give the calling component a `key` of the ids to switch chats.
 */
export const useChatSession = (workspaceId: string, chatId: number): {
  chat: ChatSnapshot
  send: ChatSession['send']
  loadEarlier: ChatSession['loadEarlier']
} => {
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
  return { chat, send: session.send, loadEarlier: session.loadEarlier }
}
