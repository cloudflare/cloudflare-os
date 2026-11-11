import { ArrowBendUpLeftIcon, CopyIcon, InfoIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

// Smaller and quieter than a button elsewhere: these sit beside a line of text and should not
// outweigh it. Each comes to full strength when it is the one pointed at.
const SMALL = 'size-7 text-sm text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default'

/**
 * What can be done with a message: reply to it, copy it, see more about it.
 *
 * TODO: these do nothing yet. Each will take its callback from whoever shows the message.
 */
export const MessageActions = () => (
  <div className="flex items-center">
    <Button variant="ghost" icon={ArrowBendUpLeftIcon} aria-label="Reply" title="Reply" className={SMALL} />
    <Button variant="ghost" icon={CopyIcon} aria-label="Copy" title="Copy" className={SMALL} />
    <Button variant="ghost" icon={InfoIcon} aria-label="Details" title="Details" className={SMALL} />
  </div>
)
