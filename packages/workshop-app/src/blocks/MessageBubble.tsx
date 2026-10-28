import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type MessageBubbleProps = {
  role: 'user' | 'assistant'
  children: ReactNode
}

/** One chat message: the user's on the right in a dark bubble, the assistant's on the left. */
export const MessageBubble = ({ role, children }: MessageBubbleProps) => (
  <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
    <div
      className={cn(
        'max-w-2xl px-5 py-3 text-base',
        role === 'user'
          ? 'rounded-3xl bg-kumo-contrast text-kumo-inverse'
          : 'rounded-2xl bg-kumo-fill text-kumo-default',
      )}
    >
      {children}
    </div>
  </div>
)
