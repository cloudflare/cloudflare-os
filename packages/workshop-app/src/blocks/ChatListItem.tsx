import { ChatCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { ChatMoreMenu, type ChatMoreMenuProps } from './ChatMoreMenu'
import { RowAction } from './RowAction'
import { LIST_ACTION } from './StarButton'
import { UnreadDot } from './UnreadDot'

export type ChatListItemProps = {
  title: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  /** How many of its messages the viewer has not read, marked by a dot while there are any. */
  unread?: number
  /** It stopped on a decision only a person can make, or with an action waiting to be approved. */
  waiting?: boolean
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
  /** What else can be done with the chat (`ChatMoreMenu`), for whoever may do any of it. */
  more?: Pick<ChatMoreMenuProps, 'read' | 'notifications' | 'onDelete'>
}

/**
 * One chat in a workspace's list of chats, on one line: its title, and when it was last active,
 * after a dot while it has anything the viewer has not read, and after that it is waiting on
 * them, in the colour of something to look at, where it is. Pointed at, more slides out at the
 * end, where there is anything in it for the viewer.
 */
export const ChatListItem = ({ title, time, unread = 0, waiting = false, href, onSelect, more }: ChatListItemProps) => {
  const hasMore = more !== undefined && (more.read !== undefined || Boolean(more.notifications?.choices.length) || more.onDelete !== undefined)
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
        {unread > 0 && <UnreadDot count={unread} />}
        {waiting && <span className="shrink-0 text-kumo-warning">Waiting on you</span>}
        {time && <span className={cn('shrink-0 text-kumo-subtle', waiting && 'max-md:hidden')}>{time}</span>}
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
