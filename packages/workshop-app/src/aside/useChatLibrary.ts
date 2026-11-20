import { useMemo } from 'react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { useChatBeside } from '@/chat/useChatSession'
import { useLibrary } from '@/library/OutputsFeedContext'
import { chatAsideItems, workspaceAsideItems, type AsideItem } from './asideItems'
import type { BesideRef } from './useAsideNavigation'

export type ChatLibrary = {
  /** What the page's workspace has made, most recent first (see `workspaceAsideItems`). */
  items: AsideItem[]
  /**
   * What is known of anything that can be shown from the page, to describe the one shown: the
   * items, and the files sent in what has been loaded of a chat, which are not listed.
   */
  known: AsideItem[]
  /** Everything the library has, as read, which the items of the workspace's are made from. */
  outputs: readonly OutputSummary[]
  /** The library is being read. */
  reading: boolean
  /** Why the library could not be read. */
  problem: string | undefined
  /** Reads it again after it could not be. */
  retry: (() => void) | undefined
}

const NONE: readonly OutputSummary[] = []

/**
 * What can be shown beside a chat, or beside its workspace's own page: what the workspace has
 * made, from the library the app keeps live. What a chat has made that the library
 * does not have yet is taken from what has been loaded of the conversation.
 */
export const useChatLibrary = (beside: BesideRef | undefined): ChatLibrary => {
  const workspaceId = beside?.workspaceId
  const chatId = beside?.chatId
  const { chat: snapshot } = useChatBeside(workspaceId === undefined || chatId === undefined ? undefined : { workspaceId, chatId })
  const library = useLibrary()
  const outputs = library.status === 'ready' ? library.outputs : undefined
  const fromChat = useMemo(
    () => (workspaceId === undefined || chatId === undefined ? [] : chatAsideItems(workspaceId, chatId, snapshot)),
    [workspaceId, chatId, snapshot],
  )
  const items = useMemo(
    () => (workspaceId === undefined ? [] : workspaceAsideItems(workspaceId, chatId, outputs ?? [], fromChat)),
    [workspaceId, chatId, outputs, fromChat],
  )
  const known = useMemo(() => [...items, ...fromChat.filter(({ kind }) => kind === 'file')], [items, fromChat])
  return {
    items,
    outputs: outputs ?? NONE,
    known,
    reading: beside !== undefined && library.status === 'loading',
    problem: library.status === 'failed' ? library.message : undefined,
    retry: library.status === 'failed' ? library.retry : undefined,
  }
}
