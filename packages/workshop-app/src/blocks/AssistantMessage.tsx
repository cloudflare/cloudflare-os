import { Markdown } from '@/components/Markdown'
import { MessageBubble } from './MessageBubble'
import { ReasoningTrace } from './ReasoningTrace'

export type AssistantMessageProps = {
  text: string
  /** With `text` empty this is a reply that has only been thought about so far. */
  reasoning?: { text: string; open: boolean; onToggle: () => void }
  /** Still being written. */
  live?: boolean
}

/** What the agent said, with what it thought first tucked above it. */
export const AssistantMessage = ({ text, reasoning, live }: AssistantMessageProps) => (
  <div className="flex flex-col gap-1">
    {reasoning && <ReasoningTrace {...reasoning} live={live && !text} />}
    {text && (
      <MessageBubble role="assistant">
        <Markdown>{text}</Markdown>
      </MessageBubble>
    )}
  </div>
)
