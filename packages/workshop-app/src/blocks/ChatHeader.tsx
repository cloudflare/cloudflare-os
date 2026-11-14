import { CaretRightIcon, ClockIcon, ExportIcon } from '@phosphor-icons/react'
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
  /** What the chat set up to run by itself, while it has any: a clock that opens them. */
  automations?: { count: number; onOpen: () => void }
  /** Shares the workspace the chat is in, from the header's far end. */
  onShare?: () => void
}

/**
 * A chat's header: the way back to its workspace, then the chat's title, which opens its settings,
 * and at the far end a clock while the chat has automations, which opens them, and the way to share
 * the workspace. Each is a bubble of the header it is put in, so the clock pops in as the first
 * automation is set up.
 */
export const ChatHeader = ({ workspace, title, onOpenSettings, automations, onShare }: ChatHeaderProps) => (
  <>
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
    {automations && (
      <HeaderBubble className="ms-auto shrink-0">
        <Button
          icon={ClockIcon}
          aria-label={automations.count === 1 ? 'Automations: 1' : `Automations: ${automations.count}`}
          title="Automations"
          onClick={automations.onOpen}
        />
      </HeaderBubble>
    )}
    {onShare && (
      <HeaderBubble className={automations ? 'shrink-0' : 'ms-auto shrink-0'}>
        <Button icon={ExportIcon} aria-label="Share" title="Share" onClick={onShare} />
      </HeaderBubble>
    )}
  </>
)
