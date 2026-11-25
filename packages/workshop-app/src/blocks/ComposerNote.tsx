import { useState } from 'react'
import { motion } from 'motion/react'
import { useReducedMotion } from '@gadgets/ui'

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

/**
 * Why a draft cannot go as it is, such as files with a skill, which goes alone: one line at the
 * top of the composer, over the draft, which opens and closes as a reply's line does. What is to
 * be done about it is in the draft itself: the pill to take off, or the files.
 */
export const ComposerNote = ({ refusal }: {
  /** Left out while the draft can go, or has nothing to say of why not. */
  refusal?: string
}) => {
  // The line stays written while the row closes.
  const [written, setWritten] = useState(refusal)
  if (refusal !== undefined && refusal !== written) setWritten(refusal)
  const open = refusal !== undefined
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION

  return (
    <motion.div
      initial={false}
      animate={open ? { opacity: 1, height: 'auto' } : { opacity: 0, height: 0 }}
      transition={transition}
      className="overflow-hidden"
    >
      {/* In line with the draft once it is over the buttons, which is where its pills are. */}
      <p role={open ? 'alert' : undefined} className="px-4 pt-3 text-sm text-kumo-danger">{written}</p>
    </motion.div>
  )
}
