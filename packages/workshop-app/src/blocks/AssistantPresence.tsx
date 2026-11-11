import { useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { motion, useReducedMotion } from 'motion/react'
import { Disclosure } from '@/components/Disclosure'
import { MASCOT_ARRIVAL_SECONDS, Mascot } from '@/components/mascot/Mascot'

export type AssistantPresenceProps = {
  /** The assistant is working on its reply. */
  working: boolean
  /** What it is doing right now, e.g. "Running code…". */
  status?: string
  /** What is behind the status, shown beneath it when it is clicked. Without it the status is only text. */
  details?: { open: boolean; onToggle: () => void; content: ReactNode }
}

const TRANSITION = { duration: 0.24, ease: [0.25, 0.1, 0.25, 1] } as const
// An empty row would still be given the feed's `gap-2`, so while hidden it takes that back.
const ROW = {
  hidden: { height: 0, marginTop: '-0.5rem' },
  shown: { height: 'auto', marginTop: 0 },
}

/**
 * The assistant at work, below the last thing in the conversation: the mascot grows in when a
 * reply is on its way, with what it is doing beside it, and shrinks away once it is done. How the
 * reply comes about can be looked into only here, while it happens.
 */
export const AssistantPresence = ({ working, status, details }: AssistantPresenceProps) => {
  const reducedMotion = useReducedMotion()
  const transition = reducedMotion ? { duration: 0 } : TRANSITION
  // The last thing it was doing stays written while it fades out.
  const [said, setSaid] = useState(status)
  if (status && status !== said) setSaid(status)
  const label = <span role="status">{status ?? said}</span>

  return (
    // Stays mounted, so what the assistant starts doing is announced as a change, and so the row
    // can close once the mascot has gone. Closing it any sooner would carry the mascot up over the
    // message above as it shrinks, when it should shrink where it stands.
    <motion.div
      inert={!working}
      initial={false}
      animate={working ? 'shown' : 'hidden'}
      variants={ROW}
      transition={working || reducedMotion ? transition : { ...transition, delay: MASCOT_ARRIVAL_SECONDS }}
      className="flex items-start gap-1 px-2 text-kumo-subtle"
    >
      <Mascot emotion="thinking" shown={working} className="w-9 shrink-0" />
      <div className={cn('mt-0.5 min-w-0 flex-1 transition-opacity duration-200 motion-reduce:transition-none', !working && 'opacity-0')}>
        {details
          ? <Disclosure open={working && details.open} onToggle={details.onToggle} summary={label}>{details.content}</Disclosure>
          : <div className="px-2 py-1 text-base/5">{label}</div>}
      </div>
    </motion.div>
  )
}
