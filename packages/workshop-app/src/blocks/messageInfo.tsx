import { CalendarBlankIcon, CpuIcon, UserIcon } from '@phosphor-icons/react'
import type { ToolStepEntry } from './ToolStep'
import { WorkLog } from './WorkLog'

export type MessageInfoProps = {
  /** The model or other sender. Omitted for the viewer's own messages. */
  sender?: string
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
 * Metadata for a message, followed by its trace when there is one.
 */
export const MessageInfo = ({ sender, sentAt, trace }: MessageInfoProps) => {
  const SenderIcon = trace ? CpuIcon : UserIcon

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2 text-sm/5 text-kumo-subtle">
        {sender && (
          <div className="flex items-center gap-2">
            <dt className="shrink-0">
              <SenderIcon aria-hidden="true" className="size-4" />
              <span className="sr-only">From</span>
            </dt>
            <dd className="min-w-0">{sender}</dd>
          </div>
        )}
        <div className="flex items-center gap-2">
          <dt className="shrink-0">
            <CalendarBlankIcon aria-hidden="true" className="size-4" />
            <span className="sr-only">Sent</span>
          </dt>
          <dd className="min-w-0">
            {sentAt ? <time dateTime={sentAt.toISOString()}>{WHEN.format(sentAt)}</time> : 'Not read yet'}
          </dd>
        </div>
      </dl>
      {trace && trace.steps.length > 0 && (
        <section aria-label="What led to this message" className="border-t border-kumo-line pt-2 text-start">
          {/* Compensate for each step's hit-area padding so its icon aligns with the metadata. */}
          <div className="-mx-2">
            <WorkLog steps={trace.steps} openSteps={trace.openSteps} onToggleStep={trace.onToggleStep} />
          </div>
        </section>
      )}
    </div>
  )
}
