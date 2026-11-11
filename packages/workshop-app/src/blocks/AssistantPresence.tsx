import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Mascot } from '@/components/mascot/Mascot'

export type AssistantPresenceProps = {
  /** The assistant is working on its reply. */
  working: boolean
  /** What it is doing, when the conversation itself does not show it yet. */
  children?: string
}

const TRANSITION = { duration: 0.24, ease: [0.25, 0.1, 0.25, 1] } as const
// An empty row would still be given the feed's `gap-2`, so while hidden it takes that back.
const ROW = {
  hidden: { height: 0, marginTop: '-0.5rem' },
  shown: { height: 'auto', marginTop: 0 },
}
const CONTENT = { hidden: { opacity: 0 }, shown: { opacity: 1 } }
const MASCOT = { hidden: { scale: 0.4 }, shown: { scale: 1 } }

/**
 * The assistant at work, below the last thing in the conversation: the mascot grows in when a
 * reply is on its way and shrinks away once it is done.
 */
export const AssistantPresence = ({ working, children }: AssistantPresenceProps) => {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION

  return (
    // Stays mounted, so the row can close as the mascot leaves and what it starts doing is
    // announced as a change.
    <motion.div
      role="status"
      initial={false}
      animate={working ? 'shown' : 'hidden'}
      variants={ROW}
      transition={transition}
      className="px-2 text-base text-kumo-subtle"
    >
      <AnimatePresence initial={false}>
        {working && (
          <motion.div
            initial="hidden"
            animate="shown"
            exit="hidden"
            variants={CONTENT}
            transition={transition}
            className="flex items-center gap-2"
          >
            <motion.div variants={MASCOT} transition={transition} className="w-9 shrink-0 origin-bottom">
              <Mascot emotion="thinking" />
            </motion.div>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
