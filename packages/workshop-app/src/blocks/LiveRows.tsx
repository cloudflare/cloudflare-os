import type { ReactNode } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'

const TRANSITION = { duration: 0.24, ease: [0.25, 0.1, 0.25, 1] } as const
// A row of no height would still be given the list's `gap-2`, so it ends by taking that back.
const GONE = { height: 0, marginTop: '-0.5rem', opacity: 0 }

/**
 * One row that can leave: it fades and closes, so what is below it moves up gradually instead of
 * jumping. Arriving is the message list's doing, like any row's.
 */
const Row = ({ children }: { children: ReactNode }) => {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION
  const leaving = !useIsPresent()
  return (
    // Cut off at the closing edge while it leaves: what spilled out of the row would otherwise
    // still count towards the scrolling height, and the conversation would only catch up, in one
    // jump, when the row was finally gone.
    <motion.div exit={GONE} transition={transition} className={leaving ? 'overflow-y-clip' : undefined}>
      {children}
    </motion.div>
  )
}

/**
 * The rows of a conversation's live output that come and go: a card waiting on the user, a message
 * not read yet, an error. Give each `LiveRows.Row` a key.
 */
const LiveRowsRoot = ({ children }: { children: ReactNode }) => <AnimatePresence initial={false}>{children}</AnimatePresence>

export const LiveRows = Object.assign(LiveRowsRoot, { Row })
