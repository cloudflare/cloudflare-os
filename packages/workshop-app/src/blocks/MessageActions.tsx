import type { ReactNode } from 'react'
import { ArrowBendUpLeftIcon, CopyIcon, InfoIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Popover } from '@/components/Popover'

export type MessageActionsProps = {
  /** What there is to know about the message, shown when its details are asked for. */
  details?: ReactNode
}

// Smaller and quieter than a button elsewhere: these sit beside a line of text and should not
// outweigh it. One that is pointed at only comes to full strength; it gets no fill.
const QUIET = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent'

/**
 * What can be done with a message: reply to it, copy it, see more about it.
 *
 * TODO: replying and copying do nothing yet. Each will take its callback from whoever shows the
 * message. Details do nothing either for a message that was given none.
 */
export const MessageActions = ({ details }: MessageActionsProps) => {
  // Full strength while its popup is open, like the one being pointed at.
  const info = <Button variant="ghost" icon={InfoIcon} aria-label="Details" title="Details" className={`${QUIET} data-popup-open:text-kumo-default`} />

  return (
    <div className="flex items-center">
      <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={QUIET} />
      <Button variant="ghost" icon={CopyIcon} aria-label="Copy" title="Copy" className={QUIET} />
      {details ? <Popover trigger={info} title="About this message">{details}</Popover> : info}
    </div>
  )
}
