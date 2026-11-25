import { AlertCircleIcon, CheckmarkCircle02Icon, HandIcon, LoaderCircleIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'

/** How a run stands, as `automations/agents.ts` says. */
export type AgentRunStatus = 'running' | 'waiting' | 'failed' | 'changes' | 'done'

const MARKS = {
  running: { Icon: LoaderCircleIcon, colour: 'text-kumo-default motion-safe:animate-spin' },
  waiting: { Icon: HandIcon, colour: 'text-kumo-brand' },
  failed: { Icon: AlertCircleIcon, colour: 'text-kumo-danger' },
  changes: { Icon: HandIcon, colour: 'text-kumo-brand' },
  done: { Icon: CheckmarkCircle02Icon, colour: 'text-kumo-subtle' },
} as const

/**
 * A mark of how a run stands: a spinner while it works, a hand in the primary colour for what
 * wants the user, as it waits on them or has changes for them to keep or discard, a mark in the
 * colour of danger once it failed, and a tick once done. It says nothing
 * itself: whatever it is beside says how the run stands in words.
 */
export const RunStatusMark = ({ status, className }: { status: AgentRunStatus; className?: string }) => {
  const { Icon, colour } = MARKS[status]
  return <Icon aria-hidden="true" weight="regular" className={cn('shrink-0', colour, className)} />
}
