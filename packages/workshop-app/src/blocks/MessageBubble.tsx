import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import '@/components/Arrival.css'
import './MessageBubble.css'

/** Which neighbours a message forms a run with: the message before it, the one after, or both. */
export type MessageJoins = { above?: boolean; below?: boolean }

export type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'error'
  children: ReactNode
  /**
   * The neighbours from the same sender, for where bubbles are not siblings in the page and so
   * cannot find each other (a message list wraps every row). Sibling bubbles need not be told.
   */
  joins?: MessageJoins
}

const BUBBLE = {
  user: 'rounded-[21px] bg-kumo-contrast text-kumo-inverse whitespace-pre-wrap',
  assistant: 'rounded-[21px] bg-kumo-fill text-kumo-default',
  error: 'rounded-[21px] bg-kumo-danger-tint text-kumo-danger',
} as const

// Consecutive messages from one sender read as a run: the row moves closer to the one above (the
// feed's `gap-2` is 8px, so -mt-1.5 leaves 2px) and the corners where two bubbles meet shrink, on the
// side the bubbles are aligned to. Per role and in full, because CSS cannot match "same role" between
// siblings generically and Tailwind only picks up class names it can read as literal strings.
// `JOINED` is the same for a bubble that was told its neighbours instead of finding them.
const RUN = {
  user: {
    row: '[[data-role=user]+&]:-mt-1.5',
    bubble:
      '[[data-role=user]+[data-role=user]>&]:rounded-tr-md ' +
      '[[data-role=user]:has(+[data-role=user])>&]:rounded-br-md',
  },
  assistant: {
    row: '[[data-role=assistant]+&]:-mt-1.5',
    bubble:
      '[[data-role=assistant]+[data-role=assistant]>&]:rounded-tl-md ' +
      '[[data-role=assistant]:has(+[data-role=assistant])>&]:rounded-bl-md',
  },
  error: {
    row: '[[data-role=error]+&]:-mt-1.5',
    bubble:
      '[[data-role=error]+[data-role=error]>&]:rounded-tl-md ' +
      '[[data-role=error]:has(+[data-role=error])>&]:rounded-bl-md',
  },
} as const

const JOINED = {
  user: { above: 'rounded-tr-md', below: 'rounded-br-md' },
  assistant: { above: 'rounded-tl-md', below: 'rounded-bl-md' },
  error: { above: 'rounded-tl-md', below: 'rounded-bl-md' },
} as const

/**
 * One chat message: the user's on the right in a dark bubble, the assistant's and errors on the left.
 * Neighbouring messages from the same sender tuck together (see `RUN`). One that has just arrived
 * grows in (see Arrival.css), settling into the run it joins (see MessageBubble.css).
 */
export const MessageBubble = ({ role, children, joins }: MessageBubbleProps) => (
  <div data-role={role} className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start', RUN[role].row, joins?.above && '-mt-1.5')}>
    <div
      className={cn(
        'arrives message-bubble max-w-[min(70%,65ch)] px-5 py-[11px] text-base/5 break-words',
        // It grows in downwards, as the conversation does, from its sender's side.
        role === 'user' ? 'origin-top-right' : 'origin-top-left',
        // A corner tightens gradually when a message joins this one in a run.
        'transition-[border-radius] duration-300 ease-out motion-reduce:transition-none',
        BUBBLE[role],
        RUN[role].bubble,
        joins?.above && JOINED[role].above,
        joins?.below && JOINED[role].below,
      )}
    >
      {children}
    </div>
  </div>
)
