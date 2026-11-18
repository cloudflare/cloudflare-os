import { CaretRightIcon, ClockIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { ChatMoreMenu, type ChatMoreMenuProps } from './ChatMoreMenu'
import { WorkspaceCrumb } from './WorkspaceCrumb'

export type ChatHeaderProps = {
  /** The workspace the chat is in, once it is known. */
  workspace?: {
    id: string
    title: string
    /** Two letters shown on the icon. */
    label: string
    /** How its icon is drawn, when not as any workspace's is. */
    look?: WorkspaceLook
    onOpen: () => void
  }
  /** The chat's title, once it is known. */
  title?: string
  /** Opens the chat's settings, from its title. */
  onOpenSettings?: () => void
  /** What the chat has set up to run by itself, while there is any: how many, and the way to them. */
  automations?: { count: number; onOpen: () => void }
  /** What else can be done with the chat (`ChatMoreMenu`), for whoever may do any of it. */
  more?: Pick<ChatMoreMenuProps, 'notifications' | 'onDelete'>
}

/**
 * A chat's header: the way back to its workspace, then the chat's title, which opens its settings,
 * and while the chat has set something up to run by itself, a clock with how many, which opens
 * them. The clock is a bubble of its own, so it pops in as the first is set up. Last, once the
 * title is there, more: its notifications and deleting it.
 */
export const ChatHeader = ({ workspace, title, onOpenSettings, automations, more }: ChatHeaderProps) => (
  <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
    {workspace && <WorkspaceCrumb {...workspace} />}
    {title && (
      // Cut off where there is not room for all of it, as on a phone.
      <HeaderBubble className="min-w-0">
        <Button title={onOpenSettings && 'Chat settings'} onClick={onOpenSettings} className="min-w-0 shrink">
          {/* Wrapped, so the caret keeps a chevron's size rather than an icon's. */}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{title}</span>
            {onOpenSettings && <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />}
          </span>
        </Button>
      </HeaderBubble>
    )}
    {automations && (
      <HeaderBubble className="shrink-0">
        <Button
          icon={ClockIcon}
          aria-label={automations.count === 1 ? 'Automations: 1' : `Automations: ${automations.count}`}
          title="Automations"
          onClick={automations.onOpen}
        >
          {automations.count}
        </Button>
      </HeaderBubble>
    )}
    {title && more && (more.notifications?.choices.length || more.onDelete) && (
      <HeaderBubble className="shrink-0">
        <ChatMoreMenu title={title} {...more} triggerVariant="secondary" />
      </HeaderBubble>
    )}
  </nav>
)
