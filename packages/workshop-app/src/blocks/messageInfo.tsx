import type { ReactNode } from 'react'
import { Calendar04Icon, ChipIcon, StopWatchIcon, UserIcon, type Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { formatDuration } from '@/components/usageFormat'
import type { ToolStepEntry } from './ToolStep'
import { WorkLog } from './WorkLog'

export type MessageInfo = {
  /** The model or other sender. Omitted for the viewer's own messages. */
  sender?: string
  /** When it joined the conversation. Absent for a message that has not yet. */
  sentAt?: Date
  /** The agent wrote it (its sender is a model, not a person). */
  reply?: boolean
  /** For developer mode: how long a reply took to make, in milliseconds. */
  workedFor?: number
}

/** How a reply came about: the steps it took and what it thought, for `thinkingOf`. */
export type MessageTrace = {
  steps: ToolStepEntry[]
  /** The keys of the steps opened or put away by hand (`WorkLog`). */
  toggledSteps: ReadonlySet<string>
  onToggleStep: (key: string) => void
  /** Its steps start open, as where they were watched as they happened (`WorkLog`). */
  startOpen?: boolean
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const Line = ({ icon: LineIcon, name, children }: { icon: Icon; name: string; children: ReactNode }) => (
  <p className="flex items-center gap-2 text-sm/5 text-kumo-subtle">
    <LineIcon aria-hidden="true" className="size-4 shrink-0" />
    <span className="sr-only">{name}</span>
    <span className="min-w-0">{children}</span>
  </p>
)

/**
 * What there is to know about a message, as the two parts a message's details show it in (see
 * `MessageBubble`), under it: their first line, and the rest, when there is more.
 */
export const messageInfo = ({ sender, sentAt, reply, workedFor }: MessageInfo): { summary: ReactNode; more?: ReactNode } => {
  const from = sender && <Line icon={reply ? ChipIcon : UserIcon} name="From">{sender}</Line>
  const sent = (
    <Line icon={Calendar04Icon} name="Sent">
      {sentAt ? <time dateTime={sentAt.toISOString()}>{WHEN.format(sentAt)}</time> : 'Not read yet'}
    </Line>
  )
  const took = workedFor !== undefined && <Line icon={StopWatchIcon} name="Took">{formatDuration(workedFor)}</Line>

  if (!from && !took) return { summary: sent }
  return {
    summary: from || sent,
    // The space above is part of it, so that folded away it leaves exactly the one line.
    more: (
      <div className={cn('flex flex-col gap-3', from ? 'pt-2' : 'pt-3')}>
        {from && sent}
        {took}
      </div>
    ),
  }
}

/**
 * How a reply came about, for `MessageBubble`'s `trace`, shown above the message: the steps it took, as
 * the thinking indicator has them while it works, as the history that led up to it. Nothing for a reply
 * that took no steps.
 */
export const thinkingOf = ({ steps, toggledSteps, onToggleStep, startOpen }: MessageTrace): ReactNode =>
  steps.length > 0 && (
    <section aria-label="What led to this message">
      <WorkLog steps={steps} toggledSteps={toggledSteps} onToggleStep={onToggleStep} startOpen={startOpen} />
    </section>
  )
