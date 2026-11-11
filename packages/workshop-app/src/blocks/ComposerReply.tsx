import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowBendUpLeftIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

/**
 * The message a draft replies to, as one line at the top of the composer, with the way to make it
 * an ordinary message again. It opens and closes the way the attachment tray below it does.
 */
export const ComposerReply = ({ quote, onShow, onCancel }: {
  /** A line of the message being replied to. Left out while the draft is not a reply. */
  quote?: string
  /** Go to that message in the conversation. The line is a button for it. */
  onShow?: () => void
  onCancel: () => void
}) => {
  // The line stays written while the row closes.
  const [written, setWritten] = useState(quote)
  if (quote !== undefined && quote !== written) setWritten(quote)
  const open = quote !== undefined
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION

  return (
    <motion.div
      initial={false}
      animate={open ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
      transition={transition}
      className="overflow-hidden"
      inert={!open}
    >
      {/* As far in from the composer's edge as the buttons at its bottom, with a corner that
          follows the composer's. */}
      <div className="px-1.5 pt-1.5">
        <div className="flex h-9 items-center rounded-[15px] bg-kumo-base pe-1.5 text-sm text-kumo-subtle ring-1 ring-kumo-line ring-inset">
          <button
            type="button"
            title={onShow && 'Show the message'}
            disabled={!onShow}
            onClick={onShow}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-s-[inherit] ps-3 pe-2 text-start enabled:cursor-pointer enabled:hover:text-kumo-default"
          >
            <ArrowBendUpLeftIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="sr-only">Replying to:</span>
            <span className="min-w-0 flex-1 truncate">{written}</span>
          </button>
          {/* Quiet until pointed at, as the actions beside a message are. */}
          <Button
            variant="ghost"
            icon={<XIcon weight="bold" />}
            aria-label="Cancel reply"
            title="Cancel reply"
            onClick={onCancel}
            className="size-6 text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3"
          />
        </div>
      </div>
    </motion.div>
  )
}
