import type { ReactNode } from 'react'
import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageJoins } from './MessageBubble'

export type AssistantMessageProps = {
  text: string
  joins?: MessageJoins
  /** What there is to know about the message (see `MessageInfo`), shown when its details are asked for. */
  details?: ReactNode
}

/** What the agent said. */
export const AssistantMessage = ({ text, joins, details }: AssistantMessageProps) => (
  <MessageBubble role="assistant" joins={joins} details={details}>
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
