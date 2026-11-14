import { ChatCircleIcon } from '@phosphor-icons/react'
import { LinkButton } from '@/components/LinkButton'

export type ChatListItemProps = {
  title: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  /** The chat's address, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/** One chat in a workspace's list of chats, on one line: its title, and when it was last active. */
export const ChatListItem = ({ title, time, href, onSelect }: ChatListItemProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-base hover:bg-kumo-contrast/5"
  >
    <ChatCircleIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />
    <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
    {time && <span className="shrink-0 text-kumo-subtle">{time}</span>}
  </LinkButton>
)
