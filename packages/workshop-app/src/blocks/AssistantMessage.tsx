import type { ReactNode } from 'react'
import { Markdown } from '@gadgets/ui'
import { InlineView } from './InlineView'
import { MessageBubble, type MessageBubbleProps, type MessageDetails, type MessageJoins } from './MessageBubble'

/** A stretch of what the agent said: prose, or a live view it drew between `<inline-html>` tags. */
export type AnswerPart =
  | { type: 'text'; text: string }
  | {
      type: 'view'
      html: string
      title?: string
      /** Why it must not run, such as that it has nothing in it. */
      error?: string
      /** Its block is still being written, in a reply that is being drafted. */
      drawing?: boolean
    }

export type AssistantMessageProps = {
  /** All of it as it was written, which is what copying it gives. */
  text: string
  /** It in order, where it is more than prose. Without them it is all `text`, as Markdown. */
  parts?: AnswerPart[]
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** Marks the chat unread from the message on. */
  onMarkUnread?: () => void
  /** In developer mode, what else its more menu can copy. */
  developerCopies?: MessageBubbleProps['developerCopies']
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
  /**
   * How it came about (see `thinkingOf`): above the message while open, with the way to switch it among
   * its actions. Above the first of its bubbles, where it has several, and the button on the last.
   */
  thinking?: { open: boolean; onToggle: () => void; content: ReactNode; shownAlready?: boolean }
  /** Sends what one of its views suggested, as the viewer's own message (`InlineView`'s `onSend`). */
  onSendSuggestion?: (message: string) => Promise<boolean>
}

/**
 * What the agent said. Prose is a bubble, and each view it drew is a bubble of its own in the run
 * (`MessageBubble`'s `view`), live, in order; what can be done with the message is on the last.
 * Copied, it is the Markdown it was written in.
 */
export const AssistantMessage = ({ text, parts, joins, onReply, onMarkUnread, developerCopies, details, thinking, onSendSuggestion }: AssistantMessageProps) => {
  const trace = thinking && { open: thinking.open, content: thinking.content, shownAlready: thinking.shownAlready }
  const button = thinking && { open: thinking.open, onToggle: thinking.onToggle }
  if (!parts || (parts.length === 1 && parts[0].type === 'text')) {
    return (
      <MessageBubble role="assistant" joins={joins} onReply={onReply} onMarkUnread={onMarkUnread} copyText={text} developerCopies={developerCopies} details={details} thinking={button} trace={trace}>
        <Markdown>{parts?.[0]?.type === 'text' ? parts[0].text : text}</Markdown>
      </MessageBubble>
    )
  }
  const last = parts.length - 1
  return (
    // Spaced as the conversation is, so the bubbles find each other and tuck together as a run.
    <div className="flex flex-col gap-2">
      {parts.map((part, index) => {
        const ends = index === last
        const bubble = {
          role: 'assistant',
          joins: { above: index === 0 && joins?.above, below: ends && joins?.below },
          onReply: ends ? onReply : undefined,
          onMarkUnread: ends ? onMarkUnread : undefined,
          developerCopies: ends ? developerCopies : undefined,
          copyText: ends ? text : undefined,
          details: ends ? details : undefined,
          thinking: ends ? button : undefined,
          trace: index === 0 ? trace : undefined,
        } as const
        return part.type === 'text'
          ? <MessageBubble key={index} {...bubble}><Markdown>{part.text}</Markdown></MessageBubble>
          : (
            <MessageBubble key={index} {...bubble} view>
              <InlineView html={part.html} title={part.title} error={part.error} onSend={onSendSuggestion} />
            </MessageBubble>
          )
      })}
    </div>
  )
}
