import { NotePencilIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { LinkButton } from '@/components/LinkButton'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { SidebarChatRow, type SidebarChat } from './SidebarChatRow'

/** Chats that belong together, by when: "Today", "October". */
export type ChatsPanelGroup = { key: string; label: string; chats: SidebarChat[] }

/** What is known of the chats: still being read, why they could not be, or the chats in groups. */
export type ChatsPanelState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; groups: ChatsPanelGroup[] }

export type ChatsPanelProps = {
  workspace: {
    title: string
    workspaceLabel: string
    workspaceLook?: WorkspaceLook
    /** Its own page, which the title goes to. */
    href?: string
    onOpen: () => void
  }
  state: ChatsPanelState
  /** The chat on screen, when it is one of these. */
  currentChatId?: number
  onOpenChat: (chat: SidebarChat) => void
  onNewChat: () => void
  /** Puts the panel away. */
  onClose: () => void
}

/**
 * One workspace's chats, in a panel of their own beside the sidebar: the workspace's icon and
 * title, which go to its page, New chat and Close, then the chats by when, most recent first. The
 * chat on screen is filled.
 */
export const ChatsPanel = ({ workspace, state, currentChatId, onOpenChat, onNewChat, onClose }: ChatsPanelProps) => (
  <section aria-label={`${workspace.title}, chats`} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-kumo-base inset-ring inset-ring-kumo-line">
    <header className="flex shrink-0 items-center gap-1 py-2.5 pr-2.5 pl-2">
      <LinkButton
        href={workspace.href}
        onClick={workspace.onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl px-2 py-1.5 text-left text-base font-medium text-kumo-default hover:bg-kumo-fill"
      >
        <WorkspaceIcon label={workspace.workspaceLabel} {...workspace.workspaceLook} small />
        <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
      </LinkButton>
      <Button icon={NotePencilIcon} variant="ghost" aria-label="New chat" onClick={onNewChat} />
      <Button icon={XIcon} variant="ghost" aria-label="Close chats" onClick={onClose} />
    </header>
    <nav aria-label="Chats" className="chat-fade min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:none]">
      {state.status === 'loading' && <p role="status" className="appears-late px-3 py-2 text-base text-kumo-subtle">Loading chats…</p>}
      {state.status === 'failed' && <p className="px-3 py-2 text-base text-kumo-subtle">Couldn’t load chats: {state.message}</p>}
      {state.status === 'ready' && state.groups.length === 0 && <p className="px-3 py-2 text-base text-kumo-subtle">No chats yet.</p>}
      {state.status === 'ready' && state.groups.map(({ key, label, chats }) => (
        <section key={key} aria-label={label} className="flex flex-col gap-px pt-2">
          <h3 className="px-3 pt-1 pb-1.5 text-sm font-medium text-kumo-subtle">{label}</h3>
          {chats.map((chat) => (
            <SidebarChatRow key={chat.id} {...chat} current={chat.id === currentChatId} onSelect={() => onOpenChat(chat)} />
          ))}
        </section>
      ))}
    </nav>
  </section>
)
