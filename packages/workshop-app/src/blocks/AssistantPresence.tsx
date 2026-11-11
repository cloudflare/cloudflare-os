import { useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Disclosure } from '@/components/Disclosure'
import { Mascot } from '@/components/mascot/Mascot'

export type AssistantPresenceProps = {
  /** The assistant is working on its reply. */
  working: boolean
  /** What it is doing right now, e.g. "Running code…". */
  status?: string
  /** What is behind the status, shown beneath it when it is clicked. Without it the status is only text. */
  details?: { open: boolean; onToggle: () => void; content: ReactNode }
}

/**
 * The assistant at work, at the end of the conversation: the mascot grows in when a reply is on
 * its way, with what it is doing beside it, and shrinks away once it is done. How the reply comes
 * about can be looked into only here, while it happens.
 *
 * Its room is always kept, so the mascot coming and going moves nothing, and the conversation
 * ends in that much space while it is away.
 */
export const AssistantPresence = ({ working, status, details }: AssistantPresenceProps) => {
  // The last thing it was doing stays written while it fades out.
  const [said, setSaid] = useState(status)
  if (status && status !== said) setSaid(status)
  const label = <span role="status">{status ?? said}</span>

  return (
    <div inert={!working} className="flex min-h-8 items-start gap-1 px-2 text-kumo-subtle">
      <Mascot emotion="thinking" shown={working} className="w-8 shrink-0" />
      <div className={cn('min-w-0 flex-1 transition-opacity duration-200 motion-reduce:transition-none', !working && 'opacity-0')}>
        {details
          ? (
            <Disclosure open={working && details.open} onToggle={details.onToggle} summary={label} hideCaret>
              {/* Back out under the mascot, so that the icons of the steps (8px in from a
                  step's edge, 16px wide) run down from its middle: its 16px less theirs, less
                  the 36px the mascot and the gap after it take before this column starts. */}
              <div className="-ms-9">{details.content}</div>
            </Disclosure>
          )
          : <div className="px-2 py-1 text-base/5">{label}</div>}
      </div>
    </div>
  )
}
