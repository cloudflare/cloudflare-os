import { ChatCircleIcon, PlusIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'

/** A chat in the workspace an item is in, to carry on in with the item beside it. */
export type GadgetChatMenuChat = {
  key: string
  title: string
  /** When it was last active: "2h ago". */
  time: string
  /** It had the item beside it when it was last open, in this browser. */
  showing?: boolean
}

export type GadgetChatMenuProps = {
  /** The item's name, which the menu says is shown beside the chat. */
  title: string
  /** Chats to carry on in, those that had it beside them first, then the most recently active. */
  chats: readonly GadgetChatMenuChat[]
  onOpenChat: (key: string) => void
  /** Starts a new chat in its workspace, with it beside it. Absent where it is in a chat on its own. */
  onNewChat?: () => void
  /** The button is its icon alone, as on a phone. */
  compact?: boolean
}

const TRIGGER = 'px-3'

/**
 * The way from an item's own page to a chat with it open beside it: a Chat button in its header,
 * which opens a menu of a new chat in its workspace and the chats there to carry on in, those that
 * last had it open first. With nothing to choose between, the button goes straight to the one
 * there is: a new chat, or the chat on its own that it was made in.
 */
export const GadgetChatMenu = ({ title, chats, onOpenChat, onNewChat, compact = false }: GadgetChatMenuProps) => {
  const label = compact ? undefined : 'Chat'
  const only = chats.length === 0 && onNewChat ? { name: 'New chat', open: onNewChat }
    : chats.length === 1 && !onNewChat ? { name: chats[0].title, open: () => onOpenChat(chats[0].key) }
    : undefined
  if (only) {
    return (
      <Button icon={ChatCircleIcon} aria-label={`Chat with ${title} open: ${only.name}`} title={only.name} onClick={only.open} className={compact ? undefined : TRIGGER}>
        {label}
      </Button>
    )
  }
  if (chats.length === 0) return null
  return (
    <DropdownMenu
      icon={ChatCircleIcon}
      label={label}
      aria-label={`Chat with ${title} open`}
      align="end"
      triggerClassName={compact ? undefined : TRIGGER}
    >
      {onNewChat && (
        <DropdownMenu.Item icon={PlusIcon} label="New chat" onSelect={onNewChat}>
          <ChatRow title="New chat" detail={`With ${title} beside it`} />
        </DropdownMenu.Item>
      )}
      {onNewChat && <DropdownMenu.Separator />}
      {chats.map((chat) => (
        <DropdownMenu.Item key={chat.key} icon={ChatCircleIcon} label={chat.title} onSelect={() => onOpenChat(chat.key)}>
          <ChatRow title={chat.title} detail={chat.showing ? `Had ${title} open · ${chat.time}` : chat.time} />
        </DropdownMenu.Item>
      ))}
    </DropdownMenu>
  )
}

const ChatRow = ({ title, detail }: { title: string; detail: string }) => (
  <span className="flex min-w-0 max-w-72 flex-col">
    <span className="truncate">{title}</span>
    <span className="truncate text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{detail}</span>
  </span>
)
