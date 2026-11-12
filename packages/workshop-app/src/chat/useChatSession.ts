import { useEffect, useSyncExternalStore } from 'react'
import type { ChatSession, ChatSnapshot } from './ChatSession'
import { useChatSessions } from './ChatSessionsContext'

/** What can be asked of a chat. Each is stable for the life of the session. */
export type ChatActions = Pick<
  ChatSession,
  'send' | 'dismissSendError' | 'stopAgent' | 'loadEarlier' | 'findQuoted' | 'retry' | 'approveAction' | 'rejectAction' | 'denyConnection' | 'setHookEnabled' | 'rename'
>

const LOADING: ChatSnapshot = { status: 'loading' }
const noSubscription = () => () => {}
const loading = () => LOADING

/**
 * One chat, live, while the calling component is mounted: its session is shared with whoever else
 * shows the same chat (`ChatSessions`). Nothing, for no chat.
 */
const useHeldSession = (chat: { workspaceId: string; chatId: number } | undefined) => {
  const sessions = useChatSessions()
  const session = chat && sessions.get(chat.workspaceId, chat.chatId)
  useEffect(() => session && sessions.hold(session), [sessions, session])
  return session
}

/** One chat, live, and what can be asked of it. */
export const useChatSession = (workspaceId: string, chatId: number): { chat: ChatSnapshot; actions: ChatActions } => {
  const session = useHeldSession({ workspaceId, chatId })!
  const chat = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { chat, actions: session }
}

/** What a chat holds, live, for whoever shows something of it beside the conversation. Loading, for no chat. */
export const useChatSnapshot = (chat: { workspaceId: string; chatId: number } | undefined): ChatSnapshot => {
  const session = useHeldSession(chat)
  return useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? loading)
}
