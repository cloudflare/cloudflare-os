import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { MASCOT_ARRIVAL_SECONDS, Mascot } from '@/components/mascot/Mascot'

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

/**
 * The assistant at work, below the last thing in the conversation: the mascot grows in when a
 * reply is on its way and shrinks away once it is done.
 */
export const AssistantPresence = ({ working, children }: AssistantPresenceProps) => {
  const reducedMotion = useReducedMotion()
  const transition = reducedMotion ? { duration: 0 } : TRANSITION

  return (
    // Stays mounted, so what the assistant starts doing is announced as a change, and so the row
    // can close once the mascot has gone. Closing it any sooner would carry the mascot up over the
    // message above as it shrinks, when it should shrink where it stands.
    <motion.div
      role="status"
      initial={false}
      animate={working ? 'shown' : 'hidden'}
      variants={ROW}
      transition={working || reducedMotion ? transition : { ...transition, delay: MASCOT_ARRIVAL_SECONDS }}
      className="flex items-center gap-2 px-2 text-base text-kumo-subtle"
    >
      <Mascot emotion="thinking" shown={working} className="w-9 shrink-0" />
      <AnimatePresence initial={false}>
        {working && children && (
          <motion.span key={children} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}>
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
