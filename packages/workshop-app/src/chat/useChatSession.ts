import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ChatCode, ChatCodeSnapshot } from './code/ChatCode'
import type { ChatSession, ChatSnapshot } from './ChatSession'
import { useChatSessions } from './ChatSessionsContext'

/** What can be asked of a chat. Each is stable for the life of the session. */
export type ChatActions = Pick<
  ChatSession,
  'send' | 'listCommands' | 'dismissSendError' | 'stopAgent' | 'loadEarlier' | 'findQuoted' | 'retry' | 'approveAction' | 'rejectAction' | 'denyConnection' | 'alwaysApprove' | 'approveWebFetches' | 'denyWebFetch' | 'setHookEnabled' | 'rename' | 'markUnreadFrom' | 'keepChanges' | 'discardChanges' | 'attachmentContent' | 'markRead' | 'view' | 'rawMessage'
>

const LOADING: ChatSnapshot = { status: 'loading' }
const CODE_LOADING: ChatCodeSnapshot = { status: 'loading' }
const noSubscription = () => () => {}
const loading = () => LOADING
const codeLoading = () => CODE_LOADING

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

/**
 * What a chat holds, live, and what can be asked of it, for whoever shows something of it beside
 * the conversation. Loading, with nothing to ask, for no chat.
 */
export const useChatBeside = (chat: { workspaceId: string; chatId: number } | undefined): { chat: ChatSnapshot; actions: ChatActions | undefined } => {
  const session = useHeldSession(chat)
  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? loading)
  return { chat: snapshot, actions: session }
}

/**
 * A chat's code, live (`ChatCode`), while the calling component is mounted, and the way to edit it.
 * Loading, with nothing to edit it by, until it has been read, and for no chat.
 */
export const useChatCode = (chat: { workspaceId: string; chatId: number } | undefined): { code: ChatCodeSnapshot; edits: ChatCode | undefined } => {
  const session = useHeldSession(chat)
  const [held, setHeld] = useState<{ session: ChatSession; code: ChatCode }>()
  useEffect(() => {
    if (!session) return
    const { code, release } = session.holdCode()
    setHeld({ session, code })
    return () => {
      release()
      setHeld(undefined)
    }
  }, [session])
  const code = held?.session === session ? held?.code : undefined
  const snapshot = useSyncExternalStore(code?.subscribe ?? noSubscription, code?.getSnapshot ?? codeLoading)
  return { code: snapshot, edits: code }
}
