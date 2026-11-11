import { ArrowBendUpLeftIcon, CopyIcon, InfoIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

export type MessageActionsProps = {
  /** The message's details can be shown under it: whether they are, and the way to switch. */
  details?: { open: boolean; onToggle: () => void }
}

// Smaller and quieter than a button elsewhere: these sit beside a line of text and should not
// outweigh it. One that is pointed at only comes to full strength; it gets no fill.
const QUIET = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent'

/**
 * What can be done with a message: reply to it, copy it, see more about it.
 *
 * TODO: replying and copying do nothing yet. Each will take its callback from whoever shows the
 * message, as the details do.
 */
export const MessageActions = ({ details }: MessageActionsProps) => (
  <div className="flex items-center">
    <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={QUIET} />
    <Button variant="ghost" icon={CopyIcon} aria-label="Copy" title="Copy" className={QUIET} />
    <Button
      variant="ghost"
      icon={InfoIcon}
      aria-label="Details"
      title="Details"
      aria-expanded={details?.open}
      // At full strength while its details are showing, like the one being pointed at.
      className={details?.open ? `${QUIET} text-kumo-default` : QUIET}
      onClick={details?.onToggle}
    />
  </div>
)
