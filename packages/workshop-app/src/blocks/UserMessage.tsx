import { LinkSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Chip } from '@/components/Chip'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { MessageAttachment } from './MessageAttachment'
import { MessageBubble, type MessageDetails, type MessageJoins } from './MessageBubble'

/** A stretch of the message: plain text, or something the user mentioned. */
export type UserMessagePart =
  | { type: 'text'; text: string }
  | { type: 'capsule'; title: string; url?: string }
  | { type: 'format'; noun: string; icon: FormatIconName }
  | { type: 'command'; name: string }

export type UserMessageAttachment = { id: string; name: string; mimeType: string; content?: Uint8Array }

export type UserMessageProps = {
  parts: UserMessagePart[]
  /** The message this one replies to, as a line of it. */
  quote?: string
  /** Go to the message replied to. The quote is a button for it. */
  onShowQuoted?: () => void
  attachments?: UserMessageAttachment[]
  /** Who sent it, when it was not the person looking. */
  from?: string
  /** Sent while the agent was working, which has not read it yet. It is dimmed until then. */
  unread?: boolean
  onOpenAttachment?: (id: string) => void
  /** The neighbouring messages from the same sender, when the bubbles are not siblings in the page. */
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

const Part = ({ part }: { part: UserMessagePart }) => {
  switch (part.type) {
    case 'text':
      return part.text
    case 'capsule':
      return <Chip icon={<LinkSimpleIcon aria-hidden="true" />} href={part.url}>{part.title}</Chip>
    case 'format':
      return <Chip icon={<FormatIcon name={part.icon} />}>{part.noun}</Chip>
    case 'command':
      return <Chip>/{part.name}</Chip>
  }
}

// A part as it reads in plain text, for copying: what was mentioned, by its name.
const written = (part: UserMessagePart) =>
  part.type === 'text' ? part.text : part.type === 'capsule' ? part.title : part.type === 'format' ? part.noun : `/${part.name}`

/**
 * What a person sent: their words with what they mentioned as chips, the files they attached in a
 * bubble of their own above, and ahead of the words, set apart and quieter, the message they were
 * replying to. The two bubbles join as a run does, and what can be done with the message is on
 * the last. Copied, it is what they wrote, without the quote.
 */
export const UserMessage = ({ parts, quote, onShowQuoted, attachments = [], from, unread, onOpenAttachment, joins, onReply, details }: UserMessageProps) => (
  <div className={cn('flex flex-col gap-1 transition-opacity duration-300 motion-reduce:transition-none', unread && 'opacity-60')}>
    {from && <span className="px-2 text-end text-xs text-kumo-subtle">{from}</span>}
    {/* Spaced as the conversation is, so the bubbles find each other and tuck together as a run. */}
    <div className="flex flex-col gap-2">
      {attachments.length > 0 && (
        <MessageBubble
          role="user"
          media
          joins={{ above: joins?.above, below: parts.length === 0 && joins?.below }}
          onReply={parts.length === 0 ? onReply : undefined}
          details={parts.length === 0 ? details : undefined}
        >
          <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-[5px]">
            {attachments.map(({ id, ...attachment }) => (
              <li key={id} className="flex">
                <MessageAttachment {...attachment} onOpen={() => onOpenAttachment?.(id)} />
              </li>
            ))}
          </ul>
        </MessageBubble>
      )}
      {parts.length > 0 && (
        <MessageBubble
          role="user"
          joins={{ above: attachments.length === 0 && joins?.above, below: joins?.below }}
          onReply={onReply}
          copyText={parts.map(written).join('')}
          details={details}
        >
          {quote && (
            // Capped in width, so that a long quote over a short reply does not stretch the bubble
            // to its limit.
            <button
              type="button"
              title={onShowQuoted && 'Show the message'}
              disabled={!onShowQuoted}
              onClick={onShowQuoted}
              className="mb-1.5 block max-w-[45ch] border-s-2 border-current/40 ps-2 text-start text-sm/5 whitespace-normal opacity-70 enabled:cursor-pointer enabled:hover:opacity-100"
            >
              <span className="line-clamp-2">
                <span className="sr-only">In reply to: </span>
                {quote}
              </span>
            </button>
          )}
          {parts.map((part, index) => <Part key={index} part={part} />)}
        </MessageBubble>
      )}
    </div>
    {/* Said only to those who cannot see the dimming. */}
    {unread && <span className="sr-only">Not read yet</span>}
  </div>
)
