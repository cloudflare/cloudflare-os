import { useState } from 'react'
import { useChatSelection } from '@/chat/useChatSession'
import { chatAsideItems } from './asideItems'
import type { ChatRef } from './useAsideNavigation'

type Latest = { key: string | null; active: boolean } | undefined
const sameLatest = (a: Latest, b: Latest) => a === b || (a !== undefined && b !== undefined && a.key === b.key && a.active === b.active)

/**
 * What chat `chat` has just made, while it is open: a gadget, or a file in a connected service,
 * such as a Google Doc, that its agent made as the user watched, for the page to show beside it as
 * it is worked on. Not a file the user sent, and not what the chat had made already when it was
 * opened, nor what paging back through its history turns up: only what newly heads what it has
 * made, while its agent works. The latest such, until the next; nothing, for no chat.
 */
export const useJustMade = (chat: ChatRef | undefined): string | undefined => {
  const workspaceId = chat?.workspaceId
  const chatId = chat?.chatId
  const latest = useChatSelection(
    chat,
    (snapshot): Latest => {
      if (snapshot.status !== 'ready' || workspaceId === undefined || chatId === undefined) return undefined
      const made = chatAsideItems(workspaceId, chatId, snapshot).find(({ kind }) => kind !== 'file')
      return { key: made?.key ?? null, active: snapshot.agentActive }
    },
    sameLatest,
  )
  const at = chat && `${chat.workspaceId}/${chat.chatId}`
  // What headed what it had made when it was opened, and what it has made since.
  const [seen, setSeen] = useState<{ at?: string; key?: string | null; made?: string }>({})
  if (latest !== undefined && seen.at !== at) setSeen({ at, key: latest.key })
  else if (latest !== undefined && seen.at === at && latest.key !== seen.key) {
    setSeen({ at, key: latest.key, made: latest.active && latest.key !== null ? latest.key : seen.made })
  }
  return seen.at === at ? seen.made : undefined
}
