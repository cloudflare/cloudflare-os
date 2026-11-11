import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageDetails, type MessageJoins } from './MessageBubble'

export type AssistantMessageProps = {
  text: string
  joins?: MessageJoins
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

/** What the agent said. */
export const AssistantMessage = ({ text, joins, details }: AssistantMessageProps) => (
  <MessageBubble role="assistant" joins={joins} details={details}>
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
