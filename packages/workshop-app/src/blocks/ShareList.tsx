import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

// The list's own rows open and close on the clock a conversation's live rows do (`LiveRows`).
const TRANSITION = { duration: 0.24, ease: [0.25, 0.1, 0.25, 1] } as const
const SHUT = { height: 0, opacity: 0 }
const OPEN = { height: 'auto', opacity: 1 }

/**
 * One row of who something is shared with. Arriving after the list was first drawn, it opens to
 * its height as what is in it fades in, so the rows below move down rather than jump; leaving, it
 * closes the same way. Give each a key.
 */
const Row = ({ children }: { children: ReactNode }) => {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION
  return (
    <motion.div initial={SHUT} animate={OPEN} exit={SHUT} transition={transition} className="overflow-y-clip">
      {children}
    </motion.div>
  )
}

export type ShareListProps = {
  /** What the rows are, as the list's accessible name: "People with access". */
  label: string
  children: ReactNode
}

/** Who something is shared with, on a surface of its own as a list's group is (`ListGroup`). */
const ShareListRoot = ({ label, children }: ShareListProps) => (
  <section aria-label={label} className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
    <AnimatePresence initial={false}>{children}</AnimatePresence>
  </section>
)

export const ShareList = Object.assign(ShareListRoot, { Row })
