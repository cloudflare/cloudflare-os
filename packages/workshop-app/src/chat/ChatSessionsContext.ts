import { createContext, useContext } from 'react'
import type { ChatSessions } from './ChatSessions'

export const ChatSessionsContext = createContext<ChatSessions | null>(null)

/** The live chats. Only available beneath `ChatSessionsProvider`. */
export const useChatSessions = (): ChatSessions => {
  const sessions = useContext(ChatSessionsContext)
  if (!sessions) throw new Error('useChatSessions must be used inside ChatSessionsProvider')
  return sessions
}
