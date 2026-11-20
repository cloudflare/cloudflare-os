import { ChatCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@gadgets/ui'
import { formatCost } from '@/components/usageFormat'
import { UnreadDot } from './UnreadDot'

export type ChatListItemProps = {
  title: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  /** How many of its messages the viewer has not read, marked by a dot while there are any. */
  unread?: number
  /** It stopped on a decision only a person can make, or with an action waiting to be approved. */
  waiting?: boolean
  /** What the chat has cost, in dollars, shown after the time where it is given. */
  cost?: number
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One chat in a workspace's list of chats, on one line: its title, and when it was last active,
 * after a dot while it has anything the viewer has not read, and after that it is waiting on
 * them, in the colour of something to look at, where it is. What it cost comes last, where asked for.
 */
export const ChatListItem = ({ title, time, unread = 0, waiting = false, cost, href, onSelect }: ChatListItemProps) => (
  <div className="flex items-center rounded-2xl hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
    <LinkButton
      href={href}
      onClick={onSelect}
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-3 text-left text-base"
    >
      <ChatCircleIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />
      <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
      {unread > 0 && <UnreadDot count={unread} />}
      {waiting && <span className="shrink-0 text-kumo-warning">Waiting on you</span>}
      {time && <span className={cn('shrink-0 text-kumo-subtle', waiting && 'max-md:hidden')}>{time}</span>}
      {cost !== undefined && <span className="shrink-0 font-mono text-sm text-kumo-subtle">{formatCost(cost)}</span>}
    </LinkButton>
  </div>
)
