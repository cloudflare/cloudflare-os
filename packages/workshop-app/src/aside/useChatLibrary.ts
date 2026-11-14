import { useMemo } from 'react'
import { useChatBeside } from '@/chat/useChatSession'
import { useLibrary } from '@/library/useLibrary'
import { besideChatItems, chatAsideItems, workspaceAsideItems, type AsideItem } from './asideItems'
import type { ChatRef } from './useAsideNavigation'

export type ChatLibrary = {
  /** What the chat's workspace has made and the files sent in the chat, most recent first (see `besideChatItems`). */
  items: AsideItem[]
  /** What is known of anything that can be shown from the chat, to describe the one shown: the items. */
  known: AsideItem[]
  /** The library is being read. */
  reading: boolean
  /** Why the library could not be read. */
  problem: string | undefined
  /** Reads it again after it could not be. */
  retry: (() => void) | undefined
}

/**
 * What can be shown beside a chat: what its workspace has made, from the library, which is read
 * again for each chat. What the chat has made that the library does not have yet is taken from
 * what has been loaded of the conversation.
 */
export const useChatLibrary = (chat: ChatRef | undefined): ChatLibrary => {
  const { chat: snapshot } = useChatBeside(chat)
  const workspaceId = chat?.workspaceId
  const chatId = chat?.chatId
  const library = useLibrary(chat ? `${chat.workspaceId}/${chat.chatId}` : null)
  const outputs = library.status === 'ready' ? library.outputs : undefined
  const fromChat = useMemo(
    () => (workspaceId === undefined || chatId === undefined ? [] : chatAsideItems(workspaceId, chatId, snapshot)),
    [workspaceId, chatId, snapshot],
  )
  const items = useMemo(
    () => (workspaceId === undefined ? [] : besideChatItems(workspaceAsideItems(workspaceId, chatId, outputs ?? [], fromChat), fromChat)),
    [workspaceId, chatId, outputs, fromChat],
  )
  const known = items
  return {
    items,
    known,
    reading: chat !== undefined && library.status === 'loading',
    problem: library.status === 'failed' ? library.message : undefined,
    retry: library.status === 'failed' ? library.retry : undefined,
  }
}
