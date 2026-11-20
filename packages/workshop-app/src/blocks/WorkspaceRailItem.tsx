import { PlusIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { HoverCard } from '@/components/HoverCard'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { SidebarChatItem, type SidebarChat } from './SidebarChatItem'
import type { WorkspaceListItemProps } from './WorkspaceListItem'

export type WorkspaceRailItemProps = WorkspaceListItemProps & {
  /**
   * The recent chats in it that the expanded sidebar lists, which a card beside it lists while it
   * is pointed at, in place of the tooltip.
   */
  chats?: SidebarChat[]
  /** The chat that is open. */
  selectedChatId?: string
  onSelectChat?: (chat: SidebarChat) => void
  onNewChat?: () => void
}

/**
 * One workspace on the collapsed sidebar's rail: its icon alone, with the unread dot on its
 * corner, or the dot of what waits on the user in it. Pointed at, a card beside it lists its
 * recent chats, under its title, which goes to it as the icon does; one with none has its title
 * and subtitle, or what waits, in a tooltip.
 */
export const WorkspaceRailItem = ({
  id,
  workspaceLabel,
  workspaceLook,
  title,
  subtitle,
  unread,
  attention,
  selected,
  href,
  onSelect,
  chats = [],
  selectedChatId,
  onSelectChat,
  onNewChat,
}: WorkspaceRailItemProps) => {
  const button = (
    <LinkButton
      href={href}
      data-workspace-id={id}
      onClick={onSelect}
      aria-label={attention ? `${title}, ${attention.toLowerCase()}` : unread ? `${title}, unread` : title}
      aria-current={selected || undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'grid size-10 place-items-center rounded-xl not-data-underlay:hover:bg-kumo-contrast/8',
        selected && 'not-data-underlay:bg-kumo-contrast/8',
      )}
    >
      <WorkspaceIcon label={workspaceLabel} {...workspaceLook} small />
      {(attention || unread) && <span aria-hidden="true" className={cn('absolute right-1 bottom-1.5 size-2.5 rounded-full ring-2 ring-kumo-canvas', attention ? 'bg-kumo-warning' : 'bg-kumo-brand')} />}
    </LinkButton>
  )

  if (chats.length === 0) {
    return (
      <Tooltip
        side="right"
        content={(
          <>
            <span className="block font-medium">{title}</span>
            {attention
              ? <span className="block text-kumo-warning">{attention}</span>
              : subtitle && <span className="block text-kumo-subtle">{subtitle}</span>}
          </>
        )}
      >
        {button}
      </Tooltip>
    )
  }

  return (
    <HoverCard trigger={button} nativeButton={!href} aria-label={`Recent chats in ${title}`}>
      {(close) => (
        <div className="flex flex-col">
          <LinkButton
            href={href}
            onClick={() => {
              close()
              onSelect()
            }}
            className="flex items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left hover:bg-kumo-fill"
          >
            <WorkspaceIcon label={workspaceLabel} {...workspaceLook} small />
            <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
          </LinkButton>
          <div className="mx-2.5 my-1 h-px bg-kumo-line" />
          {chats.map((chat) => (
            <SidebarChatItem
              key={chat.id}
              {...chat}
              compact
              selected={chat.id === selectedChatId}
              onSelect={() => {
                close()
                onSelectChat?.(chat)
              }}
            />
          ))}
          {onNewChat && (
            <button
              type="button"
              onClick={() => {
                close()
                onNewChat()
              }}
              className="flex cursor-pointer items-center gap-2.5 rounded-2xl px-2.5 py-2 text-left text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default"
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              New chat
            </button>
          )}
        </div>
      )}
    </HoverCard>
  )
}
