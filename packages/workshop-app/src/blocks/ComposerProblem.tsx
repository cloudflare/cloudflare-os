import { useState } from 'react'
import { Banner } from '@cloudflare/kumo'
import { motion, useReducedMotion } from 'motion/react'
import { InfoIcon, XIcon } from '@phosphor-icons/react'

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

/**
 * Why what was sent did not go, in a bar over the composer until it is dismissed or the next send.
 * It opens and closes the way the composer's reply line does.
 */
export const ComposerProblem = ({ message, onDismiss }: {
  /** Left out while nothing has gone wrong. */
  message?: string
  onDismiss: () => void
}) => {
  // The message stays written while the bar closes.
  const [written, setWritten] = useState(message)
  if (message !== undefined && message !== written) setWritten(message)
  const open = message !== undefined
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION

  return (
    <motion.div
      initial={false}
      animate={open ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
      transition={transition}
      className="overflow-hidden"
      inert={!open}
    >
      {/* The gap to the composer is part of what closes, so the bar closes to nothing. */}
      <div className="pb-2">
        {written !== undefined && <Banner
          role="alert"
          variant="error"
          icon={<InfoIcon className="size-4" />}
          title={written}
          // Centred on the first line. The text and icon get 1px more padding above than below,
          // and the button reaches 1px further above its row than below to keep its place.
          action={<Banner.Action variant="ghost" icon={<XIcon weight="bold" />} aria-label="Dismiss" onClick={onDismiss} shape="circle" className="-mt-[3px] -mb-px" />}
          // The icon's own box is one line tall; the text and the button need to be held to the top.
          className="items-start rounded-[21px] pt-[11px] pb-[9px] ps-4 pe-2 [&>div]:items-start"
        />}
      </div>
    </motion.div>
  )
}
