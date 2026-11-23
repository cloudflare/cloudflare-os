import { AlertCircleIcon, CheckmarkCircle02Icon, HandIcon, LoaderCircleIcon, PenLineIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@gadgets/ui'

/** How a run stands, as `automations/agents.ts` says. */
export type AgentRunStatus = 'running' | 'waiting' | 'failed' | 'changes' | 'done'

export type AgentRunRowProps = {
  title: string
  status: AgentRunStatus
  /** How it stands, in a word or two: "Waiting on you". */
  statusWords: string
  /** When it was last active, as the list it is in puts it. */
  time?: string
  /** The agent it is a run of, where the list is not one agent's. */
  agent?: string
  /** The run's address, so that it can be opened in another tab. */
  href?: string
  /** Opens the run's conversation. */
  onSelect: () => void
}

const MARKS = {
  running: { Icon: LoaderCircleIcon, colour: 'text-kumo-default motion-safe:animate-spin', words: 'text-kumo-subtle' },
  waiting: { Icon: HandIcon, colour: 'text-kumo-warning', words: 'text-kumo-warning' },
  failed: { Icon: AlertCircleIcon, colour: 'text-kumo-danger', words: 'text-kumo-danger' },
  changes: { Icon: PenLineIcon, colour: 'text-kumo-default', words: 'text-kumo-subtle' },
  done: { Icon: CheckmarkCircle02Icon, colour: 'text-kumo-subtle', words: 'text-kumo-subtle' },
} as const

/**
 * One run of an agent in a list of them: a mark of how it stands, its title over how it stands
 * (and whose run it is, where the list is not one agent's), and when it was last active at the end.
 * What wants the user (waiting on them, failed) is in its colour. The row opens its conversation.
 */
export const AgentRunRow = ({ title, status, statusWords, time, agent, href, onSelect }: AgentRunRowProps) => {
  const { Icon, colour, words } = MARKS[status]
  return (
    <LinkButton
      href={href}
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5"
    >
      <Icon aria-hidden="true" weight={status === 'done' ? 'regular' : 'bold'} className={cn('size-5 shrink-0', colour)} />
      <span className="flex min-w-0 flex-1 flex-col leading-snug">
        <span className="truncate font-medium text-kumo-default">{title}</span>
        <span className="truncate text-kumo-subtle">
          {agent && <>{agent} · </>}
          <span className={words}>{statusWords}</span>
        </span>
      </span>
      {time && <span className="shrink-0 self-start text-kumo-subtle">{time}</span>}
    </LinkButton>
  )
}
