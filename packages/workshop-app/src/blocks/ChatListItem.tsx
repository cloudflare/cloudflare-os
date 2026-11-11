import { ChatCircleIcon } from '@phosphor-icons/react'

export type ChatListItemProps = {
  title: string
  /** A line under the title, e.g. when the chat was last active. */
  subtitle?: string
  onSelect: () => void
}

/** One chat in a workspace's list of chats. */
export const ChatListItem = ({ title, subtitle, onSelect }: ChatListItemProps) => (
  <button
    type="button"
    onClick={onSelect}
    className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-base hover:bg-kumo-fill"
  >
    <ChatCircleIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-subtle" />
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{title}</span>
      {subtitle && <span className="block truncate text-kumo-subtle">{subtitle}</span>}
    </span>
  </button>
)
