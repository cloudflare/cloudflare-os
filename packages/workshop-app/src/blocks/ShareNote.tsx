import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { CheckCircleIcon, InfoIcon, ShieldWarningIcon, WarningCircleIcon } from '@phosphor-icons/react'

const TONES = {
  /** Something went wrong: what was asked was not done. */
  error: { icon: WarningCircleIcon, role: 'alert', colour: 'text-kumo-danger' },
  /** It changed nothing, and why. */
  info: { icon: InfoIcon, role: 'status', colour: 'text-kumo-subtle' },
  /** It was done. */
  success: { icon: CheckCircleIcon, role: 'status', colour: 'text-kumo-success' },
  /** Something to know before sharing, such as that it holds data others need access to. */
  caution: { icon: ShieldWarningIcon, role: undefined, colour: 'text-kumo-warning' },
} as const

export type ShareNoteProps = {
  tone: keyof typeof TONES
  /** What happened, or what to know. */
  children: ReactNode
  /** A second, quieter line. */
  detail?: ReactNode
  /** What can be done about it, at the end of the note. */
  action?: ReactNode
  id?: string
}

/**
 * A short note in a sharing dialog: what an invite did, or what to know before sharing. Errors and
 * outcomes are read out as they appear; a caution is there from the start, to be read in order.
 */
export const ShareNote = ({ tone, children, detail, action, id }: ShareNoteProps) => {
  const { icon: Icon, role, colour } = TONES[tone]
  return (
    <div id={id} role={role} className="appears flex items-center gap-3 rounded-2xl bg-kumo-tint py-2.5 ps-3 pe-2 text-sm/5">
      <Icon aria-hidden="true" weight="fill" className={cn('size-4 shrink-0 self-start mt-0.5', colour)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={tone === 'error' ? 'text-kumo-danger' : 'text-kumo-default'}>{children}</span>
        {detail && <span className="text-kumo-subtle">{detail}</span>}
      </span>
      {action && <span className="shrink-0">{action}</span>}
    </div>
  )
}
