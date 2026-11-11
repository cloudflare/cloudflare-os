import { ArrowBendUpLeftIcon, CopyIcon, InfoIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type MessageActionsProps = {
  /** Start a reply to the message. */
  onReply?: () => void
  /** The message's details can be shown under it: whether they are, and the way to switch. */
  details?: { open: boolean; onToggle: () => void; controls?: string }
}

/** Compact, fill-free actions beside a message or its details panel. */
export const MESSAGE_ACTION_STYLE = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent'

/**
 * What can be done with a message: reply to it, copy it, see more about it.
 *
 * TODO: copying does nothing yet. It will take its callback from whoever shows the message, as
 * the others do.
 */
export const MessageActions = ({ onReply, details }: MessageActionsProps) => (
  <div className="flex items-center">
    <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={MESSAGE_ACTION_STYLE} onClick={onReply} />
    <Button variant="ghost" icon={CopyIcon} aria-label="Copy" title="Copy" className={MESSAGE_ACTION_STYLE} />
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
  </div>
)
