import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'error'
  children: ReactNode
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
const RUN = {
  user: {
    row: '[[data-role=user]+&]:-mt-1.5',
    bubble:
      'transition-[border-radius] motion-reduce:transition-none ' +
      '[[data-role=user]+[data-role=user]>&]:rounded-tr-md ' +
      '[[data-role=user]:has(+[data-role=user])>&]:rounded-br-md',
  },
  assistant: {
    row: '[[data-role=assistant]+&]:-mt-1.5',
    bubble:
      'transition-[border-radius] motion-reduce:transition-none ' +
      '[[data-role=assistant]+[data-role=assistant]>&]:rounded-tl-md ' +
      '[[data-role=assistant]:has(+[data-role=assistant])>&]:rounded-bl-md',
  },
  error: {
    row: '[[data-role=error]+&]:-mt-1.5',
    bubble:
      'transition-[border-radius] motion-reduce:transition-none ' +
      '[[data-role=error]+[data-role=error]>&]:rounded-tl-md ' +
      '[[data-role=error]:has(+[data-role=error])>&]:rounded-bl-md',
  },
} as const

/**
 * One chat message: the user's on the right in a dark bubble, the assistant's and errors on the left.
 * Neighbouring messages from the same sender tuck together (see `RUN`).
 */
export const MessageBubble = ({ role, children }: MessageBubbleProps) => (
  <div data-role={role} className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start', RUN[role].row)}>
    <div className={cn('max-w-[min(70%,65ch)] px-5 py-[11px] text-base/5 break-words', BUBBLE[role], RUN[role].bubble)}>
      {children}
    </div>
  </div>
)
