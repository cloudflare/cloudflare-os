import { ClockIcon, ScrollIcon } from '@phosphor-icons/react'
import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageBubbleProps, type MessageDetails, type MessageJoins } from './MessageBubble'

export type AssistantMessageProps = {
  text: string
  /** The skills it followed, in plain words: "Meeting brief". */
  skills?: readonly string[]
  /** The automation whose call woke the agent to say it, rather than a person: "Tell a joke". */
  wokenBy?: string
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** The changes its turn kept can be gone back on from here. */
  goBack?: MessageBubbleProps['goBack']
  /** What there is to know about the message (see `messageInfo`), shown under it while open. */
  details?: MessageDetails
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

const Note = ({ icon: NoteIcon, children }: { icon: typeof ClockIcon; children: string }) => (
  <p className="flex items-center gap-1.5 text-sm/5 text-kumo-subtle">
    <NoteIcon aria-hidden="true" className="size-4 shrink-0" />
    <span className="min-w-0 truncate">{children}</span>
  </p>
)

/**
 * What the agent said, after quiet lines naming the automation that woke it to say it, when no
 * person did, and the skills it followed, as they shaped what it says; the call and the steps it
 * took are in its details. Copied, it is the Markdown it was written in.
 */
export const AssistantMessage = ({ text, skills = [], wokenBy, joins, onReply, goBack, details }: AssistantMessageProps) => (
  <MessageBubble role="assistant" joins={joins} onReply={onReply} copyText={text} goBack={goBack} details={details}>
    {(wokenBy || skills.length > 0) && (
      <div className="mb-2 flex flex-col gap-0.5">
        {wokenBy && <Note icon={ClockIcon}>{wokenBy}</Note>}
        {skills.length > 0 && <Note icon={ScrollIcon}>{`Used ${LIST.format(skills)}`}</Note>}
      </div>
    )}
    <Markdown>{text}</Markdown>
  </MessageBubble>
)
