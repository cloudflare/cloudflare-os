import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { ChatMark } from './ChatMark'
import { UnreadDot } from './UnreadDot'

export type SidebarChatItemProps = {
  title: string
  /** The last thing said in it and who said it ("Bot", "You"), under the title. */
  preview?: { from: string; text: string }
  /** How many of its messages the viewer has not read, marked by a dot while there are any. */
  unread?: number
  /** It stopped on a decision only a person can make, or with an action waiting to be approved. */
  waiting?: boolean
  /** The agent is answering in it now, which is said in the preview's place. */
  working?: boolean
  /** It is the chat on screen. */
  current?: boolean
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One chat in the sidebar, laid out as a workspace's row is: its mark, its title, and under it
 * what was said last, or that it waits on the viewer, or that the
 * agent is at work in it. Filled by the list’s shared highlight (`data-sidebar-row`).
 */
export const SidebarChatItem = ({ title, preview, unread = 0, waiting = false, working = false, current = false, href, onSelect }: SidebarChatItemProps) => {
  const line = waiting
    ? <span className="block truncate text-kumo-warning">Waiting on you</span>
    : working
      ? <span className="block truncate text-kumo-subtle">Working…</span>
      : preview && <span className="block truncate text-kumo-subtle">{preview.from}: {preview.text}</span>
  return (
    <LinkButton
      href={href}
      data-sidebar-row=""
      onClick={onSelect}
      aria-current={current ? 'page' : undefined}
      className={cn(
        // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
        "relative after:absolute after:inset-0 after:content-['']",
        'flex w-full items-center gap-3 rounded-2xl px-3 py-3 pr-4 text-left text-base not-data-underlay:hover:bg-kumo-fill',
        current && 'not-data-underlay:bg-kumo-fill',
      )}
    >
      <ChatMark />
      <span className="min-w-0 flex-1 leading-snug">
        <span className="block truncate font-medium text-kumo-default">{title}</span>
        {line}
      </span>
      {waiting
        ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-warning" />
        : unread > 0 && <UnreadDot count={unread} />}
    </LinkButton>
  )
}
