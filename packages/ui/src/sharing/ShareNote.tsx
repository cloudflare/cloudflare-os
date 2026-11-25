import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { CheckmarkCircle02Icon, InformationCircleIcon, SecurityWarningIcon } from '../icons/icons'

const TONES = {
  /** It changed nothing, and why. */
  info: { icon: InformationCircleIcon, role: 'status', colour: 'text-kumo-subtle' },
  /** It was done. */
  success: { icon: CheckmarkCircle02Icon, role: 'status', colour: 'text-kumo-success' },
  /** Something to know before sharing, such as that it holds data others need access to. */
  caution: { icon: SecurityWarningIcon, role: undefined, colour: 'text-kumo-warning' },
} as const

export type ShareNoteProps = {
  tone: keyof typeof TONES
  /** What happened, or what to know. */
  children: ReactNode
  /** A second, quieter line. */
  detail?: ReactNode
  id?: string
}

/**
 * A short note in a sharing dialog: what an invite did, or what to know before sharing, on a
 * surface of its own. What went wrong is a `Banner` instead. Outcomes are read out as they appear;
 * a caution is there from the start, to be read in order.
 */
export const ShareNote = ({ tone, children, detail, id }: ShareNoteProps) => {
  const { icon: Icon, role, colour } = TONES[tone]
  return (
    <div id={id} role={role} className="appears flex items-start gap-3 rounded-(--surface-radius) bg-kumo-tint px-4 py-3 text-sm leading-snug">
      {/* On the middle of the first line. */}
      <span className="flex h-[1lh] shrink-0 items-center">
        <Icon aria-hidden="true" weight="fill" className={cn('size-4', colour)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-kumo-default">{children}</span>
        {detail && <span className="text-kumo-subtle">{detail}</span>}
      </span>
    </div>
  )
}
