import { ArrowBendUpLeftIcon, CopyIcon, DotsThreeIcon, EyeSlashIcon, InfoIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'

export type MessageActionsProps = {
  /** Start a reply to the message. */
  onReply?: () => void
  /** What copying the message puts on the clipboard. Without it there is nothing to copy, and no Copy in more. */
  copyText?: string
  /** Marks the chat unread from this message on. Left out where it is not the viewer's to mark. */
  onMarkUnread?: () => void
  /** The message's details can be shown under it: whether they are, and the way to switch. */
  details?: { open: boolean; onToggle: () => void; controls?: string }
}

/** Compact, fill-free actions beside a message or its details panel. */
export const MESSAGE_ACTION_STYLE = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent'

// The clipboard is refused without permission and is not there at all on a page that is not served
// securely: either way nothing is copied, which there is no more to say of.
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

/** What can be done with a message: reply to it, see more about it, and in more, copy it or mark the chat unread from it. */
export const MessageActions = ({ onReply, copyText, onMarkUnread, details }: MessageActionsProps) => (
  <div className="flex items-center">
    <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={MESSAGE_ACTION_STYLE} onClick={onReply} />
    <Button
      variant="ghost"
      icon={InfoIcon}
      aria-label="Details"
      title="Details"
      aria-expanded={details?.open}
      aria-controls={details?.controls}
      className={MESSAGE_ACTION_STYLE}
      onClick={details?.onToggle}
    />
    {(copyText !== undefined || onMarkUnread) && (
      <DropdownMenu icon={DotsThreeIcon} aria-label="More" triggerVariant="ghost" triggerClassName={MESSAGE_ACTION_STYLE}>
        {copyText !== undefined && <DropdownMenu.Item icon={CopyIcon} onSelect={() => copy(copyText)}>Copy</DropdownMenu.Item>}
        {onMarkUnread && <DropdownMenu.Item icon={EyeSlashIcon} onSelect={onMarkUnread}>Mark as unread</DropdownMenu.Item>}
      </DropdownMenu>
    )}
  </div>
)
