import { useCallback, useEffect, useMemo } from 'react'
import { useChatBeside } from '@/chat/useChatSession'
import { chatAsideItems, type AsideItem } from './asideItems'
import type { ChatRef } from './useAsideNavigation'

export type ChatLibrary = {
  /** What the chat has to show, most recent first, of what has been read of it. */
  items: AsideItem[]
  /** More of the chat is being read for what it has, as asked. */
  reading: boolean
  /** Why the chat, or the last page of it, could not be read. */
  problem: string | undefined
  /** Reads on after a page could not be read. */
  retry: (() => void) | undefined
}

/**
 * What a chat has to show beside it: what was sent and made in it. Only what has been loaded of
 * the conversation is known, so while `readAll` is asked for, the rest is read, a page at a time,
 * back to its start.
 */
export const useChatLibrary = (chat: ChatRef | undefined, readAll: boolean): ChatLibrary => {
  const { chat: snapshot, actions } = useChatBeside(chat)
  const workspaceId = chat?.workspaceId
  const chatId = chat?.chatId
  const items = useMemo(
    () => (workspaceId === undefined || chatId === undefined ? [] : chatAsideItems(workspaceId, chatId, snapshot)),
    [workspaceId, chatId, snapshot],
  )
  const problem = snapshot.status === 'failed' ? snapshot.message : snapshot.status === 'ready' ? snapshot.historyError : undefined
  const more = snapshot.status === 'ready' && snapshot.hasEarlier && !snapshot.historyError
  const reading = readAll && chat !== undefined && (snapshot.status === 'loading' || more)

  useEffect(() => {
    if (readAll && more && snapshot.status === 'ready' && !snapshot.loadingEarlier) void actions?.loadEarlier()
  }, [readAll, more, snapshot, actions])

  const readOn = useCallback(() => void actions?.loadEarlier(), [actions])
  return { items, reading, problem, retry: snapshot.status === 'ready' && snapshot.historyError ? readOn : undefined }
}
