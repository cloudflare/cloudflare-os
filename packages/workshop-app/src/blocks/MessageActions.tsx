import { ArrowBendUpLeftIcon, CopyIcon, InfoIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

// Smaller and quieter than a button elsewhere: these sit beside a line of text and should not
// outweigh it. One that is pointed at only comes to full strength; it gets no fill.
const QUIET =
  'size-7 text-sm text-kumo-subtle transition-colors hover:text-kumo-default focus-visible:text-kumo-default ' +
  'not-data-disabled:hover:bg-transparent motion-reduce:transition-none'

/**
 * What can be done with a message: reply to it, copy it, see more about it.
 *
 * TODO: these do nothing yet. Each will take its callback from whoever shows the message.
 */
export const MessageActions = () => (
  <div className="flex items-center">
    <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={QUIET} />
    <Button variant="ghost" icon={CopyIcon} aria-label="Copy" title="Copy" className={QUIET} />
    <Button variant="ghost" icon={InfoIcon} aria-label="Details" title="Details" className={QUIET} />
  </div>
)
