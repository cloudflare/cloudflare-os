import { ArrowBendUpLeftIcon, BracketsCurlyIcon, CopyIcon, DotsThreeIcon, EyeSlashIcon, HashIcon, InfoIcon } from '@phosphor-icons/react'
import { Brain03Icon } from '@hugeicons/core-free-icons'
import { Button, DropdownMenu } from '@gadgets/ui'
import { hugeIcon } from '@/components/HugeIcon'

export type MessageActionsProps = {
  /** Start a reply to the message. */
  onReply?: () => void
  /** What copying the message puts on the clipboard. Without it there is nothing to copy, and no Copy in more. */
  copyText?: string
  /**
   * What else can be copied, in developer mode: the message's ID, and the message as the server
   * sent it, which is made when it is copied and is nothing for one that is not loaded.
   */
  developerCopies?: { id: string; json: () => string | undefined }
  /** Marks the chat unread from this message on. Left out where it is not the viewer's to mark. */
  onMarkUnread?: () => void
  /** The message's details can be shown under it, by a click on it too: whether they are, and the way to switch. In more. */
  details?: { open: boolean; onToggle: () => void; controls?: string }
  /** How the message came about can be shown above it: whether it is, and the way to switch. */
  thinking?: { open: boolean; onToggle: () => void; controls?: string }
}

/** Compact, fill-free actions beside a message or its details panel. */
export const MESSAGE_ACTION_STYLE = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent'

// The thinking button's brain, from Hugeicons, the free set, as the steps' icons are.
const Brain = hugeIcon(Brain03Icon)

// The clipboard is refused without permission and is not there at all on a page that is not served
// securely: either way nothing is copied, which there is no more to say of.
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

/** What can be done with a message: reply to it, see how it came about, and in more, its details (a click on the message shows them as well), copy it (and in developer mode its ID and raw JSON) or mark the chat unread from it. */
export const MessageActions = ({ onReply, copyText, developerCopies, onMarkUnread, details, thinking }: MessageActionsProps) => (
  <div className="flex items-center">
    <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={MESSAGE_ACTION_STYLE} onClick={onReply} />
    {thinking && (
      <Button
        variant="ghost"
        icon={Brain}
        aria-label={thinking.open ? 'Hide thinking' : 'Show thinking'}
        title={thinking.open ? 'Hide thinking' : 'Show thinking'}
        aria-expanded={thinking.open}
        aria-controls={thinking.controls}
        className={MESSAGE_ACTION_STYLE}
        onClick={thinking.onToggle}
      />
    )}
    {(copyText !== undefined || developerCopies || onMarkUnread || details) && (
      <DropdownMenu icon={DotsThreeIcon} aria-label="More" triggerVariant="ghost" triggerClassName={MESSAGE_ACTION_STYLE}>
        {details && <DropdownMenu.Item icon={InfoIcon} onSelect={details.onToggle}>{details.open ? 'Hide details' : 'Show details'}</DropdownMenu.Item>}
        {copyText !== undefined && <DropdownMenu.Item icon={CopyIcon} onSelect={() => copy(copyText)}>Copy</DropdownMenu.Item>}
        {developerCopies && <DropdownMenu.Item icon={HashIcon} onSelect={() => copy(developerCopies.id)}>Copy message ID</DropdownMenu.Item>}
        {developerCopies && <DropdownMenu.Item icon={BracketsCurlyIcon} onSelect={() => { const json = developerCopies.json(); if (json !== undefined) copy(json) }}>Copy raw JSON</DropdownMenu.Item>}
        {onMarkUnread && <DropdownMenu.Item icon={EyeSlashIcon} onSelect={onMarkUnread}>Mark as unread</DropdownMenu.Item>}
      </DropdownMenu>
    )}
  </div>
)
