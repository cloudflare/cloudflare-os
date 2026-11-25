import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useChatBeside } from '@/chat/useChatSession'
import { setSidebarHidden } from '@/prefs/sidebarHidden'
import { recentChatKey } from './recentChats'
import { ghostLineOf } from './ghostChat'

/** A chat the sidebar lists though it is not among the recent chats (`useGhostChat`). */
export type GhostChat = {
  key: string
  workspaceId: string
  chatId: number
  title: string | undefined
  preview?: string
  speaker?: string
  working: boolean
  /** Something was said in it since it was opened. */
  fresh: boolean
  /** Its conversation is still to be read, which says its latest message. */
  loading: boolean
  /** It is the chat open. */
  open: boolean
}

/**
 * The chats the sidebar lists that the recent chats do not have: the one open (`open`) while it is
 * not listed (`isListed`, by key), and, once left, one in which something was said meanwhile,
 * until the recent chats, which follow the account live, have it. One
 * left with nothing said in it goes. One the viewer took out of the sidebar is put back once
 * something is said in it, and one left that is gone to again is still fresh. `title` is what the chat was called as it was gone to, until
 * its own is read. The open one's session is the chat page's own, held here too.
 */
export const useGhostChats = (
  open: { workspaceId: string; chatId: number; title?: string } | undefined,
  isListed: (key: string) => boolean,
): GhostChat[] => {
  const key = open && recentChatKey(open.workspaceId, open.chatId)
  const shown = open && key !== undefined && !isListed(key) ? open : undefined
  const { chat } = useChatBeside(shown && { workspaceId: shown.workspaceId, chatId: shown.chatId })
  // When it was opened, which what was said in it since is told by.
  const [opened, setOpened] = useState<{ key: string; at: number }>()
  if (shown && opened?.key !== key) setOpened({ key: key!, at: Date.now() })

  // The one left with something said in it, kept as it was then.
  const [left, setLeft] = useState<GhostChat>()
  const line = shown && opened && opened.key === key && chat.status === 'ready' ? ghostLineOf(chat.items, opened.at) : undefined
  const current: GhostChat | undefined = shown && opened && opened.key === key
    ? {
        key: key!,
        workspaceId: shown.workspaceId,
        chatId: shown.chatId,
        title: (chat.status === 'ready' ? chat.title : undefined) ?? shown.title,
        preview: line?.preview ?? (left?.key === key ? left.preview : undefined),
        speaker: line ? line.speaker : left?.key === key ? left.speaker : undefined,
        fresh: line?.fresh === true || left?.key === key,
        working: chat.status === 'ready' && chat.agentActive,
        loading: chat.status !== 'ready' && left?.key !== key,
        open: true,
      }
    : undefined

  // Hidden, it would never be among the recent chats again however much is said in it.
  const freshKey = current?.fresh ? current.key : undefined
  useEffect(() => {
    if (freshKey !== undefined) setSidebarHidden(freshKey, undefined)
  }, [freshKey])
  const last = useRef<GhostChat>(undefined)
  useLayoutEffect(() => {
    const was = last.current
    if (was && was.key !== key && was.fresh) setLeft({ ...was, open: false, working: false, loading: false })
  }, [key])
  useLayoutEffect(() => {
    last.current = current
  })

  const kept = left && left.key !== key && !isListed(left.key) ? left : undefined
  return [current, kept].filter((ghost) => ghost !== undefined)
}
