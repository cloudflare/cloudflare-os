import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'error'
  children: ReactNode
}

const BUBBLE = {
  user: 'rounded-3xl bg-kumo-contrast text-kumo-inverse whitespace-pre-wrap',
  assistant: 'rounded-2xl bg-kumo-fill text-kumo-default',
  error: 'rounded-2xl bg-kumo-danger-tint text-kumo-danger',
} as const

/** One chat message: the user's on the right in a dark bubble, the assistant's and errors on the left. */
export const MessageBubble = ({ role, children }: MessageBubbleProps) => (
  <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
    <div className={cn('max-w-2xl px-5 py-3 text-base break-words', BUBBLE[role])}>{children}</div>
  </div>
)
