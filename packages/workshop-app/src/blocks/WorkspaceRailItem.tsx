import { cn } from '@cloudflare/kumo/utils'
import { closeHoverCards, HoverCard } from '@/components/HoverCard'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { FOCUS_RING } from '@/components/focusRing'
import { SidebarChatItem, type SidebarChat } from './SidebarChatItem'
import type { WorkspaceListItemProps } from './WorkspaceListItem'

export type WorkspaceRailItemProps = WorkspaceListItemProps & {
  /** The recent chats in it that the expanded sidebar lists, which the card beside it lists. */
  chats?: SidebarChat[]
  /** The chat that is open. */
  selectedChatId?: string
  onSelectChat?: (chat: SidebarChat) => void
}

/**
 * One workspace on the collapsed sidebar's rail: its icon alone, with the unread dot on its
 * corner, or the dot of what waits on the user in it, which goes to the workspace. Pointed at, one
 * with recent chats opens a card of them beside it, each going to its chat; one with none has its
 * title and subtitle, or what waits, in a tooltip at once.
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
  menuOpen,
  href,
  onSelect,
  chats = [],
  selectedChatId,
  onSelectChat,
}: WorkspaceRailItemProps) => {
  const button = (
    <LinkButton
      href={href}
      data-workspace-id={id}
      data-menu-open={menuOpen || undefined}
      onClick={onSelect}
      // Its tooltip takes the place of another's card, which would be left open beside it.
      onPointerEnter={chats.length === 0 ? closeHoverCards : undefined}
      aria-label={attention ? `${title}, ${attention.toLowerCase()}` : unread ? `${title}, unread` : title}
      aria-current={selected || undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'grid size-10 place-items-center rounded-xl not-data-underlay:hover:bg-kumo-contrast/8', FOCUS_RING,
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
        delay={0}
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
        <div className="flex flex-col gap-0.5">
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
        </div>
      )}
    </HoverCard>
  )
}
