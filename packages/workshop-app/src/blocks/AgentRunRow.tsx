import { LinkButton } from '@gadgets/ui'
import { RUN_STATUS_WORDS_COLOUR, RunStatusMark, type AgentRunStatus } from './RunStatusMark'

export type { AgentRunStatus }

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

/**
 * One run of an agent in a list of them: a mark of how it stands, its title over how it stands
 * (and whose run it is, where the list is not one agent's), and when it was last active at the end.
 * What wants the user (waiting on them, failed) is in its colour. The row opens its conversation.
 */
export const AgentRunRow = ({ title, status, statusWords, time, agent, href, onSelect }: AgentRunRowProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    className="flex w-full items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5"
  >
    <RunStatusMark status={status} className="size-5" />
    <span className="flex min-w-0 flex-1 flex-col leading-snug">
      <span className="truncate font-medium text-kumo-default">{title}</span>
      <span className="truncate text-kumo-subtle">
        {agent && <>{agent} · </>}
        <span className={RUN_STATUS_WORDS_COLOUR[status]}>{statusWords}</span>
      </span>
    </span>
    {time && <span className="shrink-0 self-start text-kumo-subtle">{time}</span>}
  </LinkButton>
)
