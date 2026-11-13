import { CaretRightIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { WorkspaceCrumb } from './WorkspaceCrumb'

export type ChatHeaderProps = {
  /** The workspace the chat is in, once it is known. */
  workspace?: {
    id: string
    title: string
    /** Two letters shown on the folder. */
    label: string
    onOpen: () => void
  }
  /** The chat's title, once it is known. */
  title?: string
  /** Opens the chat's settings, from its title. */
  onOpenSettings?: () => void
}

/** A chat's header: the way back to its workspace, then the chat's title, which opens its settings. */
export const ChatHeader = ({ workspace, title, onOpenSettings }: ChatHeaderProps) => (
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
  </nav>
)
