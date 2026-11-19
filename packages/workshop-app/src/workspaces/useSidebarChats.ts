import { useEffect, useState } from 'react'
import type { AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { agentsOf, isAgentRun, type Agent } from '@/automations/agents'
import { useChatNotifications } from '@/chat/useChatNotifications'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaceChats } from './useWorkspaceChats'

/** The last thing said in a chat, and who said it, as a chat's row has it under its title. */
export type ChatPreview = { from: string; text: string }

/** A chat as the sidebar and the panel beside it list it, with when it was last active. */
export type ListedChat = {
  id: number
  title: string
  unread: number
  waiting: boolean
  /** The agent is answering in it now. */
  working: boolean
  href?: string
  lastActive: Date
  /** Once read, and only where asked for (`previews`). */
  preview?: ChatPreview
}

export type SidebarChatsData =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; chats: ListedChat[]; agents: Agent[] }

// The latest few messages of each chat are read for its preview: enough to get past what is not
// said (a change, a divider) to what was.
const PREVIEW_DEPTH = 4
// The chats that are read for a preview, the most recent first. The rest go without.
const PREVIEWS = 20
const NO_PREVIEWS: ReadonlyMap<number, ChatPreview> = new Map()

// Each workspace's previews as last read, for the visit, shown again while they are read again.
const lastPreviews = new Map<string, ReadonlyMap<number, ChatPreview>>()

const previewOf = (messages: AiChatMessage[], viewerId: string): ChatPreview | undefined => {
  for (const message of messages.toReversed()) {
    if (message.type !== 'message') continue
    const text = message.message.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const { author } = message
    const from = author.type === 'agent' ? 'Bot' : author.id === viewerId ? 'You' : author.name.split(' ')[0] || author.name
    return { from, text }
  }
  return undefined
}

/** The last thing said in each of the given chats, read once for each chat as it is listed, and shown as last read meanwhile. */
const usePreviews = (workspaceId: string, chatIds: number[] | undefined): ReadonlyMap<number, ChatPreview> => {
  const { api, user, reconnecting } = useApi()
  const [previews, setPreviews] = useState<{ workspaceId: string; byChat: ReadonlyMap<number, ChatPreview> }>()
  const wanted = chatIds?.slice(0, PREVIEWS).join(',')

  useEffect(() => {
    if (reconnecting || wanted === undefined || wanted === '') return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    // Pipelined on the one workspace, each its own call.
    const ids = wanted.split(',').map(Number)
    void Promise.allSettled(ids.map((id) => overseer.getChatHistory(id, undefined, PREVIEW_DEPTH))).then((pages) => {
      if (cancelled) return
      const byChat = new Map<number, ChatPreview>()
      pages.forEach((page, index) => {
        const preview = page.status === 'fulfilled' ? previewOf(page.value.messages, user.id) : undefined
        if (preview) byChat.set(ids[index], preview)
      })
      lastPreviews.set(workspaceId, byChat)
      setPreviews({ workspaceId, byChat })
    })
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, user.id, reconnecting, workspaceId, wanted])

  return previews?.workspaceId === workspaceId ? previews.byChat : lastPreviews.get(workspaceId) ?? NO_PREVIEWS
}

/**
 * A workspace's chats as the sidebar lists them, most recently active first: those people had,
 * not its agents' runs, which are its agents' (`agentsOf`, from the same list), each with what of it the viewer has not read (only for whoever builds in
 * it, who has read state) and whether it waits on them. With `previews`, each also has the last
 * thing said in it.
 *
 * The list is read once, and again whenever the chat on screen (`currentChatId`) is not in it,
 * as when a new chat has just been made.
 */
export const useSidebarChats = (
  workspaceId: string,
  builds: boolean,
  chatHref: (chatId: number) => string,
  { currentChatId, previews = false }: { currentChatId?: number; previews?: boolean } = {},
): SidebarChatsData => {
  // Read again, by remounting the reading under another key, once for each chat it lacks.
  const [readFor, setReadFor] = useState<number>()
  const state = useWorkspaceChats(workspaceId, readFor)
  const notifications = useChatNotifications(workspaceId, builds)
  const ready = state.status === 'ready' ? state.chats.filter((chat) => !isAgentRun(chat)) : undefined
  const missing = ready !== undefined && currentChatId !== undefined && !ready.some((chat) => chat.id === currentChatId)
  if (missing && readFor !== currentChatId) setReadFor(currentChatId)
  const byChat = usePreviews(workspaceId, previews ? ready?.map((chat) => chat.id) : undefined)

  if (state.status !== 'ready') return state
  if (ready === undefined) return { status: 'loading' }
  const listed = (chat: AiChatMetadata): ListedChat => ({
    id: chat.id,
    title: chat.title || 'Untitled chat',
    unread: builds ? notifications.rows.get(chat.id)?.unreadMessageCount ?? 0 : 0,
    waiting: chat.awaitingDecision === true,
    working: chat.activeAgent !== undefined,
    href: chatHref(chat.id),
    lastActive: chat.lastActive,
    preview: byChat.get(chat.id),
  })
  return { status: 'ready', chats: ready.map(listed), agents: agentsOf(state.chats) }
}
