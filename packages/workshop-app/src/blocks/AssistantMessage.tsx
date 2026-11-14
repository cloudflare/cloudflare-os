import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageBubbleProps, type MessageDetails, type MessageJoins } from './MessageBubble'

export type AssistantMessageProps = {
  text: string
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** The changes its turn kept can be gone back on from here. */
  goBack?: MessageBubbleProps['goBack']
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

/** What the agent said. Copied, it is the Markdown it was written in. */
export const AssistantMessage = ({ text, joins, onReply, goBack, details }: AssistantMessageProps) => (
  <MessageBubble role="assistant" joins={joins} onReply={onReply} copyText={text} goBack={goBack} details={details}>
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
