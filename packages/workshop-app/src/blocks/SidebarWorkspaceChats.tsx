import { PlusIcon } from '@phosphor-icons/react'
import { LinkButton } from '@/components/LinkButton'
import { SidebarChatRow, type SidebarChat } from './SidebarChatRow'

/** What is known of a workspace's chats: still being read, why they could not be, or the chats. */
export type SidebarChatsState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; chats: SidebarChat[] }

export type SidebarWorkspaceChatsProps = {
  state: SidebarChatsState
  /** The chat on screen, when it is one of these. */
  currentChatId?: number
  onOpenChat: (chat: SidebarChat) => void
  /** How many are listed before the rest are left to the workspace's page. */
  limit?: number
  /** The workspace's page, which lists all of them, for when there are more than `limit`. */
  allChats?: { href?: string; onOpen: () => void }
  /** Starts a chat in the workspace. */
  newChat?: { href?: string; onOpen: () => void }
}

// In from the sidebar's edge as far as a workspace's title is, past its icon: the row's own room
// (`px-3`), then the icon (32px) and the gap after it, less the chat row's own room.
const INDENT = 'pl-11'

const quietLine = 'flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-base text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default'

/**
 * A workspace's chats under it in the sidebar, the most recent first, in from the edge past its
 * icon, with a line down from the icon beside them. The chat on screen is filled. Past `limit`,
 * the rest are on the workspace's page.
 */
export const SidebarWorkspaceChats = ({ state, currentChatId, onOpenChat, limit = 5, allChats, newChat }: SidebarWorkspaceChatsProps) => {
  const chats = state.status === 'ready' ? state.chats : []
  // The chat on screen is listed even when it is older than those shown.
  const shown = chats.slice(0, limit)
  const current = chats.find((chat) => chat.id === currentChatId)
  if (current && !shown.includes(current)) shown.push(current)
  const more = chats.length - shown.length

  return (
    <div className={`relative flex flex-col gap-px pt-0.5 pb-2 ${INDENT}`}>
      <span aria-hidden="true" className="absolute top-0 bottom-3 left-7 w-px bg-kumo-line" />
      {state.status === 'loading' && <p role="status" className="appears-late px-3 py-1.5 text-base text-kumo-subtle">Loading chats…</p>}
      {state.status === 'failed' && <p className="px-3 py-1.5 text-base text-kumo-subtle">Couldn’t load chats</p>}
      {state.status === 'ready' && chats.length === 0 && <p className="px-3 py-1.5 text-base text-kumo-subtle">No chats yet</p>}
      {shown.map((chat) => (
        <SidebarChatRow key={chat.id} {...chat} current={chat.id === currentChatId} onSelect={() => onOpenChat(chat)} />
      ))}
      {more > 0 && allChats && (
        <LinkButton href={allChats.href} onClick={allChats.onOpen} className={quietLine}>
          {more} more
        </LinkButton>
      )}
      {newChat && (
        <LinkButton href={newChat.href} onClick={newChat.onOpen} className={quietLine}>
          <PlusIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0" />
          New chat
        </LinkButton>
      )}
    </div>
  )
}
