import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ChatSession, ChatSnapshot } from './ChatSession'
import { useChatSessions } from './ChatSessionsContext'

/** What can be asked of a chat. Each is stable for the life of the session. */
export type ChatActions = Pick<
  ChatSession,
  'send' | 'listCommands' | 'dismissSendError' | 'stopAgent' | 'loadEarlier' | 'findQuoted' | 'retry' | 'approveAction' | 'rejectAction' | 'decideAction' | 'alwaysApprove' | 'denyConnection' | 'setHookEnabled' | 'rename' | 'keepChanges' | 'discardChanges' | 'goBack' | 'deleteChat' | 'attachmentContent' | 'markRead'
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
 * Something drawn from what a chat holds, live, for whoever needs only that of it: the caller
 * renders again only when `select` gives something that is not `equal` to what it gave before,
 * not for every word of a reply as it streams in. `select` of the loading snapshot, for no chat.
 */
export const useChatSelection = <T,>(
  chat: { workspaceId: string; chatId: number } | undefined,
  select: (snapshot: ChatSnapshot) => T,
  equal: (a: T, b: T) => boolean,
): T => {
  const session = useHeldSession(chat)
  const read = session?.getSnapshot ?? loading
  const last = useRef<{ from: ChatSnapshot; select: (snapshot: ChatSnapshot) => T; value: T }>(undefined)
  const getSelection = () => {
    const from = read()
    const before = last.current
    if (before?.from === from && before.select === select) return before.value
    const value = select(from)
    last.current = { from, select, value: before && equal(before.value, value) ? before.value : value }
    return last.current.value
  }
  return useSyncExternalStore(session?.subscribe ?? noSubscription, getSelection)
}
