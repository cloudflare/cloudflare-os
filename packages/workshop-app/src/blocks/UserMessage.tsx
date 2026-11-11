import { LinkSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Chip } from '@/components/Chip'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { MessageAttachment } from './MessageAttachment'
import { MessageBubble, type MessageJoins } from './MessageBubble'

/** A stretch of the message: plain text, or something the user mentioned. */
export type UserMessagePart =
  | { type: 'text'; text: string }
  | { type: 'capsule'; title: string; url?: string }
  | { type: 'format'; noun: string; icon: FormatIconName }
  | { type: 'command'; name: string }

export type UserMessageAttachment = { id: string; name: string; mimeType: string; content?: Uint8Array }

export type UserMessageProps = {
  parts: UserMessagePart[]
  attachments?: UserMessageAttachment[]
  /** Who sent it, when it was not the person looking. */
  from?: string
  /** Sent while the agent was working, which has not read it yet. It is dimmed until then. */
  unread?: boolean
  onOpenAttachment?: (id: string) => void
  /** The neighbouring messages from the same sender, when the bubbles are not siblings in the page. */
  joins?: MessageJoins
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

/** What a person sent: their words with what they mentioned as chips, and the files they attached. */
export const UserMessage = ({ parts, attachments = [], from, unread, onOpenAttachment, joins }: UserMessageProps) => (
  <div className={cn('flex flex-col gap-1 transition-opacity duration-300 motion-reduce:transition-none', unread && 'opacity-60')}>
    {from && <span className="px-2 text-end text-xs text-kumo-subtle">{from}</span>}
    {attachments.length > 0 && (
      <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-2">
        {attachments.map(({ id, ...attachment }) => (
          <li key={id} className="flex">
            <MessageAttachment {...attachment} onOpen={() => onOpenAttachment?.(id)} />
          </li>
        ))}
      </ul>
    )}
    {parts.length > 0 && (
      <MessageBubble role="user" joins={joins}>
        {parts.map((part, index) => <Part key={index} part={part} />)}
      </MessageBubble>
    )}
    {/* Said only to those who cannot see the dimming. */}
    {unread && <span className="sr-only">Not read yet</span>}
  </div>
)
