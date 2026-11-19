import { ArrowUUpLeftIcon, ChatCircleIcon, PlusIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'

/** A chat in the workspace an item is in, to carry on in with the item beside it. */
export type GadgetChatMenuChat = {
  key: string
  title: string
  /** When it was last active: "2 hours ago". */
  time: string
  /** It had the item beside it when it was last open, in this browser. */
  showing?: boolean
}

export type GadgetChatMenuProps = {
  /** The item's name, which the menu says is shown beside the chat. */
  title: string
  /**
   * Chats to carry on in, those that had it beside them first, then the most recently active.
   * Left out while they are read.
   */
  chats?: readonly GadgetChatMenuChat[]
  onOpenChat: (key: string) => void
  /** Starts a new chat in its workspace, with it beside it. */
  onNewChat: () => void
  /**
   * The chat the page was opened from, first of all, as the way back to it; left out of `chats`.
   * Its title is left out while it is not known.
   */
  back?: { title?: string; onBack: () => void }
  /** The button is its icon alone, as on a phone. */
  compact?: boolean
}

const TRIGGER = 'px-3'

/**
 * The way from an item's own page to a chat with it open beside it: a Chat button, the header's
 * one primary action, at its end, which opens a menu of the chat the page was opened from, as the
 * way back, then a new chat in its workspace and the chats there to carry on in, those that last
 * had it open first. With no chats there to choose between, the button starts a new one.
 */
export const GadgetChatMenu = ({ title, chats, onOpenChat, onNewChat, back, compact = false }: GadgetChatMenuProps) => {
  const label = compact ? undefined : 'Chat'
  if (chats?.length === 0 && !back) {
    return (
      <Button variant="primary" icon={ChatCircleIcon} aria-label={`New chat with ${title} beside it`} title="New chat" onClick={onNewChat} className={compact ? undefined : TRIGGER}>
        {label}
      </Button>
    )
  }
  return (
    <DropdownMenu
      icon={ChatCircleIcon}
      label={label}
      aria-label={`Chat with ${title} beside it`}
      triggerVariant="primary"
      align="end"
      inPlace
      triggerClassName={compact ? undefined : TRIGGER}
    >
      {back && (
        <>
          <DropdownMenu.Item icon={ArrowUUpLeftIcon} label={back.title ?? 'Back to the chat'} onSelect={back.onBack}>
            <ChatRow title={back.title ?? 'The chat'} detail="Back to where you were" />
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
        </>
      )}
      <DropdownMenu.Item icon={PlusIcon} label="New chat" onSelect={onNewChat}>
        <ChatRow title="New chat" detail={`With ${title} beside it`} />
      </DropdownMenu.Item>
      {chats?.length !== 0 && <DropdownMenu.Separator />}
      {chats === undefined ? (
        <DropdownMenu.Item icon={ChatCircleIcon} disabled>Loading chats…</DropdownMenu.Item>
      ) : chats.map((chat) => (
        <DropdownMenu.Item key={chat.key} icon={ChatCircleIcon} label={chat.title} onSelect={() => onOpenChat(chat.key)}>
          <ChatRow title={chat.title} detail={chat.showing ? `Had ${title} open · ${chat.time}` : chat.time} />
        </DropdownMenu.Item>
      ))}
    </DropdownMenu>
  )
}

const ChatRow = ({ title, detail }: { title: string; detail: string }) => (
  <span className="flex min-w-0 max-w-72 flex-col gap-0.5">
    <span className="truncate">{title}</span>
    <span className="truncate text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{detail}</span>
  </span>
)
