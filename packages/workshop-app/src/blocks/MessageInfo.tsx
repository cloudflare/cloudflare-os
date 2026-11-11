import type { ToolStepEntry } from './ToolStep'
import { WorkLog } from './WorkLog'

export type MessageInfoProps = {
  /** Who sent the message: a person's name, "You", or the model that wrote it. */
  sender: string
  /** When it joined the conversation. Absent for a message that has not yet. */
  sentAt?: Date
  /**
   * How the message came about, for one the agent wrote: the steps it took and what it thought.
   * Left out for a message a person sent. Nothing is shown for a reply that took no steps.
   */
  trace?: {
    steps: ToolStepEntry[]
    /** The keys of the steps whose detail is showing. */
    openSteps: ReadonlySet<string>
    onToggleStep: (key: string) => void
  }
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * What there is to know about a message, to go under it: who sent it and when, on one line, then
 * the steps that led to it.
 */
export const MessageInfo = ({ sender, sentAt, trace }: MessageInfoProps) => (
  <div className="flex flex-col gap-2">
    <p className="text-sm text-kumo-subtle">
      {sender}
      <span aria-hidden="true"> · </span>
      {sentAt ? <time dateTime={sentAt.toISOString()}>{WHEN.format(sentAt)}</time> : 'Not read yet'}
    </p>
    {trace && trace.steps.length > 0 && (
      // Each step has room around it to be pointed at. Taking it back here lines their icons up
      // with the line above.
      <section aria-label="What led to this message" className="-mx-2 text-start">
        <WorkLog steps={trace.steps} openSteps={trace.openSteps} onToggleStep={trace.onToggleStep} />
      </section>
    )}
  </div>
)
