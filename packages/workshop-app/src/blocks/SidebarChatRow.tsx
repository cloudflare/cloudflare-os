import { LinkButton } from '@/components/LinkButton'
import { UnreadDot } from './UnreadDot'

/** A chat as the sidebar and the panel beside it list it. */
export type SidebarChat = {
  id: number
  title: string
  /** How many of its messages the viewer has not read, marked by a dot while there are any. */
  unread?: number
  /** It stopped on a decision only a person can make, or with an action waiting to be approved. */
  waiting?: boolean
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
}

export type SidebarChatRowProps = SidebarChat & {
  /** It is the chat on screen. */
  current?: boolean
  onSelect: () => void
}

/**
 * One chat on one quiet line: its title, then a dot while it waits on the viewer or has anything
 * they have not read. Filled while pointed at or on screen.
 */
export const SidebarChatRow = ({ title, unread = 0, waiting = false, href, current = false, onSelect }: SidebarChatRowProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    aria-current={current ? 'page' : undefined}
    aria-label={waiting ? `${title}, waiting on you` : undefined}
    className="flex w-full min-w-0 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-base text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default aria-[current=page]:bg-kumo-fill aria-[current=page]:font-medium aria-[current=page]:text-kumo-default"
  >
    <span className={unread > 0 || waiting ? 'min-w-0 flex-1 truncate text-kumo-default' : 'min-w-0 flex-1 truncate'}>{title}</span>
    {waiting
      ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-warning" />
      : unread > 0 && <UnreadDot count={unread} />}
  </LinkButton>
)
