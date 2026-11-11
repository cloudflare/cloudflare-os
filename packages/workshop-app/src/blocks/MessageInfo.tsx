import { useId } from 'react'
import type { ToolStepEntry } from './ToolStep'
import { WorkLog } from './WorkLog'

export type MessageInfoProps = {
  /** Who sent the message: a person's name, "You", or the model that wrote it. */
  sender: string
  /** When it joined the conversation. Absent for a message that has not yet. */
  sentAt?: Date
  /**
   * How the message came about, for one the agent wrote: the steps it took and what it thought.
   * Left out for a message a person sent.
   */
  trace?: {
    steps: ToolStepEntry[]
    /** The keys of the steps whose detail is showing. */
    openSteps: ReadonlySet<string>
    onToggleStep: (key: string) => void
  }
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** What there is to know about a message: who sent it, when, and how it came about. */
export const MessageInfo = ({ sender, sentAt, trace }: MessageInfoProps) => {
  const heading = useId()

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-kumo-subtle">From</dt>
        <dd className="min-w-0 break-words">{sender}</dd>
        <dt className="text-kumo-subtle">Sent</dt>
        <dd>{sentAt ? <time dateTime={sentAt.toISOString()}>{WHEN.format(sentAt)}</time> : 'Not yet: the assistant has not read it'}</dd>
      </dl>
      {trace && (
        <section aria-labelledby={heading} className="flex flex-col gap-1 border-t border-kumo-line pt-3">
          <h3 id={heading} className="text-kumo-subtle">How it came about</h3>
          {trace.steps.length > 0
            ? <WorkLog steps={trace.steps} openSteps={trace.openSteps} onToggleStep={trace.onToggleStep} />
            : <p>It was written straight away: nothing was looked up, run or thought through first.</p>}
        </section>
      )}
    </div>
  )
}
