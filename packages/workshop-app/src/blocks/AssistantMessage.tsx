import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageJoins } from './MessageBubble'

/** What the agent said. */
export const AssistantMessage = ({ text, joins }: { text: string; joins?: MessageJoins }) => (
  <MessageBubble role="assistant" joins={joins}>
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
