import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import '@/components/Arrival.css'
import { MessageActions } from './MessageActions'
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
  /** What there is to know about the message (see `MessageInfo`), shown when its details are asked for. */
  details?: ReactNode
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

// Beside the bubble, on the side the row has room, level with its middle. They are there all
// along, so showing them moves nothing, and show while the bubble or the place they are in is
// pointed at, or one of them has focus; the rest of the row does not bring them up. They touch
// the bubble (the gap is their own padding), so the pointer crosses to them without leaving both.
// They stay while one of them has something open, which is elsewhere on the page.
const ACTIONS =
  'shrink-0 opacity-0 transition-opacity motion-reduce:transition-none ' +
  'peer-hover/bubble:opacity-100 hover:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100'

/**
 * One chat message: the user's on the right in a dark bubble, the assistant's and errors on the left.
 * What can be done with a message shows beside it while it is pointed at (see `MessageActions`).
 * Neighbouring messages from the same sender tuck together (see `RUN`). One that has just arrived
 * grows in (see Arrival.css), settling into the run it joins (see MessageBubble.css).
 */
export const MessageBubble = ({ role, children, joins, details }: MessageBubbleProps) => (
  <div
    data-role={role}
    className={cn('flex items-center', role === 'user' ? 'justify-end' : 'justify-start', RUN[role].row, joins?.above && '-mt-1.5')}
  >
    <div
      className={cn(
        'peer/bubble arrives message-bubble max-w-[min(70%,65ch)] px-5 py-[11px] text-base/5 break-words',
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
    {/* After the bubble for both, so each can tell when it is pointed at; the user's are put before it. */}
    {role === 'user' && <div className={cn(ACTIONS, 'order-first pe-2')}><MessageActions details={details} /></div>}
    {role === 'assistant' && <div className={cn(ACTIONS, 'ps-2')}><MessageActions details={details} /></div>}
  </div>
)
