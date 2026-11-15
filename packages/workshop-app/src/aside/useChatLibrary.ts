import { useEffect, useMemo, useState } from 'react'
import type { ChatFileSummary } from '@gadgets/workshop-shared/api'
import { useChatBeside } from '@/chat/useChatSession'
import { fileTitle } from '@/library/libraryEntries'
import { useLibrary } from '@/library/useLibrary'
import { useApi } from '@/rpc/ApiContext'
import { besideChatItems, chatAsideItems, formatAsideRef, workspaceAsideItems, type AsideItem } from './asideItems'
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
 * The files sent in chat `chat`, as `listChatFiles` lists them, read only while `wanted`: what a
 * file shown from the chat is called and what it is, when the message it came in has not been
 * loaded, as for one opened from the Library.
 */
const useChatFiles = (chat: ChatRef | undefined, wanted: boolean) => {
  const { api, reconnecting } = useApi()
  const [read, setRead] = useState<{ key: string; files: ChatFileSummary[] }>()
  const workspaceId = chat?.workspaceId
  const chatId = chat?.chatId
  const key = `${workspaceId}/${chatId}`
  useEffect(() => {
    if (workspaceId === undefined || chatId === undefined || !wanted || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    overseer.listChatFiles(chatId).then((files) => { if (current) setRead({ key, files }) }, () => {})
      .finally(() => overseer[Symbol.dispose]())
    return () => { current = false }
  }, [api, reconnecting, workspaceId, chatId, key, wanted])
  return read && read.key === key ? read.files : undefined
}

/**
 * What can be shown beside a chat: what its workspace has made, from the library, which is read
 * again for each chat. What the chat has made that the library does not have yet is taken from
 * what has been loaded of the conversation. A file `shownFileId` that none of that has is looked
 * up among the files sent in the chat, so that it is known by its name and type.
 */
export const useChatLibrary = (chat: ChatRef | undefined, shownFileId?: string): ChatLibrary => {
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
  const unknownFile = shownFileId !== undefined && !items.some(({ key }) => key === formatAsideRef({ kind: 'file', fileId: shownFileId }))
  const chatFiles = useChatFiles(chat, unknownFile)
  const known = useMemo(() => {
    if (!unknownFile || !chatFiles || workspaceId === undefined || chatId === undefined) return items
    const file = chatFiles.find(({ id }) => id === shownFileId)
    if (!file) return items
    const title = fileTitle(file)
    return [...items, {
      key: formatAsideRef({ kind: 'file', fileId: file.id }),
      title,
      at: file.attached,
      kind: 'file' as const,
      file: { id: file.id, name: title, mimeType: file.mimeType, size: file.size, workspaceId, chatId },
    }]
  }, [items, unknownFile, chatFiles, shownFileId, workspaceId, chatId])
  return {
    items,
    known,
    reading: chat !== undefined && library.status === 'loading',
    problem: library.status === 'failed' ? library.message : undefined,
    retry: library.status === 'failed' ? library.retry : undefined,
  }
}
