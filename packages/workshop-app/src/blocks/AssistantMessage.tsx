import { ScrollIcon } from '@phosphor-icons/react'
import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageBubbleProps, type MessageDetails, type MessageJoins } from './MessageBubble'

export type AssistantMessageProps = {
  text: string
  /** The skills it followed, in plain words: "Meeting brief". */
  skills?: readonly string[]
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** The changes its turn kept can be gone back on from here. */
  goBack?: MessageBubbleProps['goBack']
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/**
 * What the agent said, after a quiet line naming the skills it followed, as they shaped what it
 * says; the steps it took are in its details. Copied, it is the Markdown it was written in.
 */
export const AssistantMessage = ({ text, skills = [], joins, onReply, goBack, details }: AssistantMessageProps) => (
  <MessageBubble role="assistant" joins={joins} onReply={onReply} copyText={text} goBack={goBack} details={details}>
    {skills.length > 0 && (
      <p className="mb-2 flex items-center gap-1.5 text-sm/5 text-kumo-subtle">
        <ScrollIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0">Used {LIST.format(skills)}</span>
      </p>
    )}
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
