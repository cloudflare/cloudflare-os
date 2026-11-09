import { useEffect, useRef } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { UnreadThread } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { ContextMenu, type MenuEntry } from '../../components/ContextMenu'
import { logRpcFailure } from '../../rpcErrors'
import { isNamedWorkspace, useWorkspaces } from '../workspaces/WorkspacesContext'
import { RecentChatRow } from './RecentChatRow'
import { useRecentChats } from './useRecentChats'
import type { ChatGlyphKind } from './ChatGlyph'

/** The chat the current route shows, if any. */
const useSelectedChat = () => useRouterState({
  select: (s) => {
    const match = /^\/workspace\/([^/]+)/.exec(s.location.pathname)
    const chat = (s.location.search as { chat?: unknown }).chat
    return match && typeof chat === 'number' ? `${match[1]}:${chat}` : undefined
  },
})

/** The sidebar's list of recent chats across every workspace. */
export const RecentChatList = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const threads = useRecentChats(authenticatedApi)
  const { byId, loading: workspacesLoading, refresh } = useWorkspaces()
  const selected = useSelectedChat()
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  // The conversations agents start live under their agent in Automations, never here, even while
  // one is open. Archived chats stay out too (see AuthenticatedApi.setChatArchived()), and so do
  // chats others started in a shared workspace until the user opens or writes in one: those are
  // the workspace's, found on its page. Either still shows while it is the one open, so it
  // doesn't vanish from under the user.
  const chats = threads?.filter(chat => !chat.spawnerName &&
    ((!chat.archived && !chat.unjoined) || selected === `${chat.workspaceId}:${chat.chatId}`))

  // A chat in a workspace the listing hasn't seen yet (just created, or just shared) needs the
  // listing again to draw its glyph. Ask once per unknown workspace.
  const requested = useRef(new Set<string>())
  const unknown = workspacesLoading ? undefined :
    chats?.find(chat => !byId(chat.workspaceId) && !requested.current.has(chat.workspaceId))?.workspaceId
  useEffect(() => {
    if (!unknown) return
    requested.current.add(unknown)
    refresh()
  }, [unknown, refresh])

  const glyphFor = (chat: UnreadThread): ChatGlyphKind => {
    const workspace = byId(chat.workspaceId)
    if (isNamedWorkspace(workspace)) return { kind: 'workspace', title: workspace!.title }
    return chat.spawnerName ? { kind: 'agent' } : { kind: 'chat' }
  }

  // A row's right-click menu stands in for the browser's own, so it keeps the link actions too.
  const actionsFor = (chat: UnreadThread): MenuEntry[] => {
    const link = `${window.location.origin}/workspace/${chat.workspaceId}?chat=${chat.chatId}`
    return [
      { label: 'Open', onSelect: () => navigate({ to: '/workspace/$id', params: { id: chat.workspaceId }, search: { chat: chat.chatId } }) },
      { label: 'Open in new tab', onSelect: () => window.open(link, '_blank', 'noopener') },
      { label: 'Copy link', onSelect: () => {
        navigator.clipboard.writeText(link).then(
          () => toasts.add({ title: 'Link copied' }),
          () => toasts.add({ title: "Couldn't copy the link", variant: 'error' }))
      } },
      { label: 'Details', onSelect: () => navigate({ to: '/workspace/$id', params: { id: chat.workspaceId }, search: { chat: chat.chatId, details: 'library' } }) },
      'separator',
      { label: chat.archived ? 'Unarchive' : 'Archive', onSelect: () => {
        authenticatedApi.setChatArchived(chat.workspaceId, chat.chatId, !chat.archived).catch(err => {
          logRpcFailure('Failed to archive chat:', err)
          toasts.add({ title: chat.archived ? "Couldn't unarchive the chat" : "Couldn't archive the chat", variant: 'error' })
        })
      } },
    ]
  }

  if (!chats) return null
  if (chats.length === 0) {
    return <p className="px-3 py-2 text-[13px] leading-4 text-kumo-subtle">Your chats will show up here.</p>
  }
  return (
    <nav aria-label="Recent chats" className="flex flex-col gap-0.5">
      {chats.map(chat => (
        <ContextMenu key={`${chat.workspaceId}:${chat.chatId}`} items={actionsFor(chat)}>
          <RecentChatRow
            chat={chat}
            glyph={glyphFor(chat)}
            selected={selected === `${chat.workspaceId}:${chat.chatId}`}
          />
        </ContextMenu>
      ))}
    </nav>
  )
}
