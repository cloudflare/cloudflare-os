import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageDetails, type MessageJoins } from './MessageBubble'

export type AssistantMessageProps = {
  text: string
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

/** What the agent said. */
export const AssistantMessage = ({ text, joins, onReply, details }: AssistantMessageProps) => (
  <MessageBubble role="assistant" joins={joins} onReply={onReply} details={details}>
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
