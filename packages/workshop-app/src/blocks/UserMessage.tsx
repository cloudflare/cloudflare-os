import { useState } from 'react'
import { Link04Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { Chip } from '@/components/Chip'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { CommandIcon } from './CommandIcon'
import { commandTitle } from './composerCommand'
import { MessageAttachment } from './MessageAttachment'
import { clampParts } from './clampParts'
import { MessageBubble, type MessageBubbleProps, type MessageDetails, type MessageJoins } from './MessageBubble'

/** A stretch of the message: plain text, or something the user mentioned. */
export type UserMessagePart =
  | { type: 'text'; text: string }
  | { type: 'capsule'; title: string; url?: string; snippet?: string }
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
  /**
   * What whoever has the chat knows of something the message mentions, for the card over its
   * chip: what a skill is for and where it is kept, say. Asked as the card is about to show.
   * Nothing, where they know no more than its name.
   */
  describe?: (part: UserMessagePart) => { description?: string; facts?: readonly string[] } | undefined
  /** Who sent it, when it was not the person looking. */
  from?: string
  /** Sent while the agent was working, which has not read it yet. It is dimmed until then. */
  unread?: boolean
  onOpenAttachment?: (id: string) => void
  /** Fetches a file's bytes, for a glimpse of it on its tile. */
  loadAttachment?: (id: string) => Promise<Uint8Array>
  /** The neighbouring messages from the same sender, when the bubbles are not siblings in the page. */
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** Marks the chat unread from the message on. */
  onMarkUnread?: () => void
  /** In developer mode, what else its more menu can copy. */
  developerCopies?: MessageBubbleProps['developerCopies']
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

// Where a connection's link goes, for its card: the site alone.
const siteOf = (url: string | undefined) => {
  try {
    return url ? [new URL(url).hostname.replace(/^www\./, '')] : undefined
  } catch {
    return undefined
  }
}

// A chip's card says only what is not on the chip: what the message carries of what it mentions
// (what a connection holds, and where it is), and what whoever has the chat knows of it.
const Part = ({ part, describe }: { part: UserMessagePart; describe: UserMessageProps['describe'] }) => {
  const known = (title: string) => () => {
    const found = describe?.(part)
    return found && { title, ...found }
  }
  switch (part.type) {
    case 'text':
      return part.text
    case 'capsule':
      return <Chip icon={<Link04Icon aria-hidden="true" />} href={part.url} about={{ title: part.title, description: part.snippet?.trim() || undefined, facts: siteOf(part.url) }}>{part.title}</Chip>
    case 'format':
      return <Chip icon={<FormatIcon name={part.icon} />} about={known(part.noun)}>{part.noun}</Chip>
    case 'command': {
      // By its name in plain words, as its pill in the draft was; the app's own are not skills.
      const title = commandTitle(part.name)
      return <Chip icon={<CommandIcon command={{ kind: part.name === 'compact' ? 'builtin' : 'skill', name: part.name }} />} about={known(title)}>{title}</Chip>
    }
  }
}

// A part as it reads in plain text, for copying: what was mentioned, by its name.
const written = (part: UserMessagePart) =>
  part.type === 'text' ? part.text : part.type === 'capsule' ? part.title : part.type === 'format' ? part.noun : `/${part.name}`

// How many characters of a long message are shown until the rest is asked for, as long things
// said in a connection's dialog are (`ClampedText`).
const LONG = 600

/**
 * What a person sent: their words with what they mentioned as pills where the message names
 * them, the files they attached in a bubble of their own above, and ahead of the words, set apart
 * and quieter, the message they were replying to. The two bubbles join as a run does, and what can be done with the message is on
 * the last. One that runs long is cut short, with "more" right after what is left of it, which
 * shows the rest. Copied, it is what they wrote, whole, without the quote.
 */
export const UserMessage = ({ parts, quote, onShowQuoted, attachments = [], describe, from, unread, onOpenAttachment, loadAttachment, joins, onReply, onMarkUnread, developerCopies, details }: UserMessageProps) => {
  const [whole, setWhole] = useState(false)
  const head = whole ? undefined : clampParts(parts, LONG, (part) => written(part).length)
  const shown = (head ?? parts).map((part, index) => <Part key={index} part={part} describe={describe} />)
  const more = head && (
    <>
      …{' '}
      <button type="button" aria-label="Read more" onClick={() => setWhole(true)} className="cursor-pointer font-medium opacity-70 hover:opacity-100">
        more
      </button>
    </>
  )
  return (
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
            onMarkUnread={parts.length === 0 ? onMarkUnread : undefined}
            developerCopies={parts.length === 0 ? developerCopies : undefined}
            details={parts.length === 0 ? details : undefined}
          >
            <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-[5px]">
              {attachments.map(({ id, ...attachment }) => (
                <li key={id} className="flex">
                  <MessageAttachment {...attachment} load={loadAttachment && (() => loadAttachment(id))} onOpen={() => onOpenAttachment?.(id)} />
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
            onMarkUnread={onMarkUnread}
            developerCopies={developerCopies}
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
            {/* On lines as tall as the draft's were, which a pill is drawn for. */}
            {parts.some(({ type }) => type !== 'text')
              ? <div className="chips-on-dark leading-6">{shown}{more}</div>
              : <>{shown}{more}</>}
          </MessageBubble>
        )}
      </div>
      {/* Said only to those who cannot see the dimming. */}
      {unread && <span className="sr-only">Not read yet</span>}
    </div>
  )
}
