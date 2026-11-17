import { useMemo, useState } from 'react'
import { ClockIcon, ScrollIcon } from '@phosphor-icons/react'
import { Markdown } from '@/components/Markdown'
import { answerParts, proseOf } from './answerParts'
import { InlineView } from './InlineView'
import { ViewAsk } from './ViewAsk'
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
  /**
   * Sends what one of its live views asks the viewer to send, as their own message; resolves to
   * whether it went, and one that did not says why itself. Absent where nothing can be sent.
   */
  onSendFromView?: (message: string) => Promise<boolean>
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

const Note = ({ icon: NoteIcon, children }: { icon: typeof ClockIcon; children: string }) => (
  <p className="flex items-center gap-1.5 text-sm/5 text-kumo-subtle">
    <NoteIcon aria-hidden="true" className="size-4 shrink-0" />
    <span className="min-w-0 truncate">{children}</span>
  </p>
)

const Notes = ({ wokenBy, skills }: { wokenBy?: string; skills: readonly string[] }) =>
  (wokenBy || skills.length > 0) && (
    <div className="mb-2 flex flex-col gap-0.5">
      {wokenBy && <Note icon={ClockIcon}>{wokenBy}</Note>}
      {skills.length > 0 && <Note icon={ScrollIcon}>{`Used ${LIST.format(skills)}`}</Note>}
    </div>
  )

/**
 * What the agent said, after quiet lines naming the automation that woke it to say it, when no
 * person did, and the skills it followed, as they shaped what it says; the call and the steps it
 * took are in its details. Copied, it is the Markdown it was written in.
 *
 * Live views it drew (`<inline-html>` blocks) stand between what it says on cards of their own,
 * on the agent's side, its words in bubbles around them; what can be done with the message, and
 * its details, are on its last words. Copied, such a message is its words alone. What a view asks
 * the viewer to send waits after the answer, where their next message would go (`ViewAsk`): the
 * latest ask, until it is sent or put away.
 */
export const AssistantMessage = ({ text, skills = [], wokenBy, joins, onReply, goBack, details, onSendFromView }: AssistantMessageProps) => {
  const parts = useMemo(() => answerParts(text), [text])
  const [ask, setAsk] = useState<{ message: string; from: string; sending: boolean }>()
  if (!parts.some(({ kind }) => kind === 'view')) {
    return (
      <MessageBubble role="assistant" joins={joins} onReply={onReply} copyText={text} goBack={goBack} details={details}>
        <Notes wokenBy={wokenBy} skills={skills} />
        <Markdown>{text}</Markdown>
      </MessageBubble>
    )
  }

  const last = parts.findLastIndex(({ kind }) => kind === 'prose')
  return (
    <div className="flex w-full flex-col gap-2">
      {/* A view first, with no words before it to carry them, has the notes above it. */}
      {parts[0]?.kind === 'view' && <div className="px-5"><Notes wokenBy={wokenBy} skills={skills} /></div>}
      {parts.map((part, index) =>
        part.kind === 'view' ? (
          <InlineView
            key={index}
            html={part.html}
            title={part.title}
            error={part.error}
            onAsk={onSendFromView && ((message) => setAsk({ message, from: part.title ?? 'The view', sending: false }))}
          />
        ) : (
          <MessageBubble
            key={index}
            role="assistant"
            // Only its ends meet the messages either side of it.
            joins={{ above: index === 0 && joins?.above, below: index === parts.length - 1 && joins?.below }}
            {...(index === last && { onReply, copyText: proseOf(text), goBack, details })}
          >
            {index === 0 && <Notes wokenBy={wokenBy} skills={skills} />}
            <Markdown>{part.text}</Markdown>
          </MessageBubble>
        ),
      )}
      <div aria-live="polite" className="contents">
        {ask && onSendFromView && (
          <ViewAsk
            message={ask.message}
            from={ask.from}
            sending={ask.sending}
            onDismiss={() => setAsk(undefined)}
            onSend={async () => {
              const { message } = ask
              setAsk({ ...ask, sending: true })
              const sent = await onSendFromView(message).catch(() => false)
              // A view may have asked again meanwhile; the newer ask stays.
              setAsk((current) => (current?.message !== message ? current : sent ? undefined : { ...current, sending: false }))
            }}
          />
        )}
      </div>
    </div>
  )
}
