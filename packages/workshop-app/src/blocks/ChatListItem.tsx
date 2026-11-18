import { ChatCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { ChatMoreMenu, type ChatMoreMenuProps } from './ChatMoreMenu'
import { RowAction } from './RowAction'
import { LIST_ACTION } from './StarButton'

export type ChatListItemProps = {
  title: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
  /** What else can be done with the chat (`ChatMoreMenu`), for whoever may do any of it. */
  more?: Pick<ChatMoreMenuProps, 'notifications' | 'onDelete'>
}

/**
 * One chat in a workspace's list of chats, on one line: its title, and when it was last active.
 * Pointed at, more slides out at the end, where there is anything in it for the viewer.
 */
export const ChatListItem = ({ title, time, href, onSelect, more }: ChatListItemProps) => {
  const hasMore = more !== undefined && (Boolean(more.notifications?.choices.length) || more.onDelete !== undefined)
  return (
    <div className={cn('group relative flex items-center rounded-2xl hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5', hasMore && 'pr-1.5')}>
      <LinkButton
        href={href}
        onClick={onSelect}
        // The whole row opens the chat, apart from the button over it.
        className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']", hasMore ? 'pr-2.5' : 'pr-3')}
      >
        <ChatCircleIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />
        <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
        {time && <span className="shrink-0 text-kumo-subtle">{time}</span>}
      </LinkButton>
      {hasMore && (
        <RowAction>
          <span className="relative flex">
            <ChatMoreMenu title={title} {...more} triggerClassName={LIST_ACTION} />
          </span>
        </RowAction>
      )}
    </div>
  )
}
