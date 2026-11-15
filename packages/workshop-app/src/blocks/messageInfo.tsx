import type { ReactNode } from 'react'
import { CalendarBlankIcon, ClockIcon, CpuIcon, UserIcon, type Icon } from '@phosphor-icons/react'
import { CodeBlock } from '@/components/CodeBlock'
import { cn } from '@cloudflare/kumo/utils'
import type { ToolStepEntry } from './ToolStep'
import { WorkLog } from './WorkLog'

export type MessageInfo = {
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
  /** The call that woke the agent to write it, when an automation did rather than a person. */
  prompt?: { label: string; call: string; args?: string }
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
 * `MessageBubble`): their first line, and the rest, when there is more.
 */
export const messageInfo = ({ sender, sentAt, trace, prompt }: MessageInfo): { summary: ReactNode; more?: ReactNode } => {
  const from = sender && <Line icon={trace ? CpuIcon : UserIcon} name="From">{sender}</Line>
  const sent = (
    <Line icon={CalendarBlankIcon} name="Sent">
      {sentAt ? <time dateTime={sentAt.toISOString()}>{WHEN.format(sentAt)}</time> : 'Not read yet'}
    </Line>
  )
  const woken = prompt && (
    <section aria-label="What woke it" className="flex flex-col gap-2 border-t border-kumo-line pt-2 text-start">
      <Line icon={ClockIcon} name="Woken by">{prompt.label}, which called <code className="font-mono text-xs">{prompt.call}</code></Line>
      {prompt.args && <CodeBlock label="With">{prompt.args}</CodeBlock>}
    </section>
  )
  const steps = trace && trace.steps.length > 0 && (
    <section aria-label="What led to this message" className="border-t border-kumo-line pt-2 text-start">
      {/* Compensate for each step's hit-area padding so its icon aligns with the lines above. */}
      <div className="-mx-2">
        <WorkLog steps={trace.steps} openSteps={trace.openSteps} onToggleStep={trace.onToggleStep} />
      </div>
    </section>
  )

  if (!from && !steps && !woken) return { summary: sent }
  return {
    summary: from || sent,
    // The space above is part of it, so that folded away it leaves exactly the one line.
    more: (
      <div className={cn('flex flex-col gap-3', from ? 'pt-2' : 'pt-3')}>
        {from && sent}
        {woken}
        {steps}
      </div>
    ),
  }
}
