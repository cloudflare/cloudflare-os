import type { ReactNode } from 'react'
import { CirclesFourIcon, FolderIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { LogoIcon } from '@/components/LogoIcon'
import { ConversationListItem, type ConversationListItemProps } from './ConversationListItem'

export type SidebarConversation = Omit<ConversationListItemProps, 'selected' | 'onSelect'> & { id: string }

export type SidebarProps = {
  user: { name: string; avatarUrl?: string }
  conversations: SidebarConversation[]
  selectedConversationId?: string
  onSelectConversation: (id: string) => void
  /** Shown in place of the list when there is nothing to list, e.g. "No conversations yet." */
  notice?: string
  /** Logos of the connected apps, shown in the connect button. */
  connections?: ReactNode
}

/** The sidebar: global buttons on top, the conversations, then the user and connections. */
export const Sidebar = ({
  user,
  conversations,
  selectedConversationId,
  onSelectConversation,
  notice,
  connections,
}: SidebarProps) => (
  <div className="flex min-h-0 flex-1 flex-col gap-3 p-0.5">
    <header className="flex items-center gap-2">
      <Button icon={<LogoIcon />} aria-label="Home" className="mr-auto [&>svg]:size-[1.5em]" />
      <Button icon={FolderIcon} aria-label="Workspaces" />
      <Button icon={CirclesFourIcon} aria-label="Library" />
      <Button icon={MagnifyingGlassIcon} aria-label="Search" />
    </header>
    <nav aria-label="Conversations" className="flex min-h-0 flex-1 flex-col overflow-y-auto gap-0.5">
      {conversations.map(({ id, ...conversation }) => (
        <ConversationListItem
          key={id}
          {...conversation}
          selected={id === selectedConversationId}
          onSelect={() => onSelectConversation(id)}
        />
      ))}
      {notice && <p className="px-3 py-2 text-base text-kumo-subtle">{notice}</p>}
    </nav>
    <footer className="flex items-center justify-between">
      <Button icon={<Avatar name={user.name} src={user.avatarUrl} />} aria-label="Account" />
      <ConnectButton>{connections}</ConnectButton>
    </footer>
  </div>
)
