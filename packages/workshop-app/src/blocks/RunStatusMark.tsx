import { AlertCircleIcon, CheckmarkCircle02Icon, HandIcon, LoaderCircleIcon, PenLineIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'

/** How a run stands, as `automations/agents.ts` says. */
export type AgentRunStatus = 'running' | 'waiting' | 'failed' | 'changes' | 'done'

const MARKS = {
  running: { Icon: LoaderCircleIcon, colour: 'text-kumo-default motion-safe:animate-spin' },
  waiting: { Icon: HandIcon, colour: 'text-kumo-warning' },
  failed: { Icon: AlertCircleIcon, colour: 'text-kumo-danger' },
  changes: { Icon: PenLineIcon, colour: 'text-kumo-default' },
  done: { Icon: CheckmarkCircle02Icon, colour: 'text-kumo-subtle' },
} as const

/** The colour of how a run stands in words, for those that want the user: waiting on them, failed. */
export const RUN_STATUS_WORDS_COLOUR: Record<AgentRunStatus, string> = {
  running: 'text-kumo-subtle',
  waiting: 'text-kumo-warning',
  failed: 'text-kumo-danger',
  changes: 'text-kumo-subtle',
  done: 'text-kumo-subtle',
}

/**
 * A mark of how a run stands: a spinner while it works, a hand while it waits on the user, in the
 * colour of what wants them, a pen for changes to keep, and a tick once done. It says nothing
 * itself: whatever it is beside says how the run stands in words.
 */
export const RunStatusMark = ({ status, className }: { status: AgentRunStatus; className?: string }) => {
  const { Icon, colour } = MARKS[status]
  return <Icon aria-hidden="true" weight={status === 'done' ? 'regular' : 'bold'} className={cn('shrink-0', colour, className)} />
}
