import { AgentRunPill } from '@/blocks/AgentRunPill'
import { STATUS_WORDS } from '@/automations/agents'
import type { RunMark } from './chatRuns'

export type RunMarkViewProps = {
  mark: RunMark
  /** Opens a run's conversation, by its chat's id. Left out where none can be: the pills are then not pressed. */
  onOpen?: (chatId: number) => void
  /** A run's address, by its chat's id, so that it can be opened in another tab. */
  href?: (chatId: number) => string
}

/**
 * A point in the conversation about an agent it started: a pill where it started, saying only
 * that it did (how it is getting on is beside the composer), and one where it ended, saying how.
 * Each is a row of its own, growing in from the top corner on the agent's side as its messages do.
 */
export const RunMarkView = ({ mark: { kind, run }, onOpen, href }: RunMarkViewProps) => (
  <div className="arrives flex origin-top-left">
    <AgentRunPill
      title={run.title}
      agent={run.agent.name}
      status={kind === 'started' ? 'started' : run.status}
      statusWords={kind === 'started' ? 'Started' : STATUS_WORDS[run.status]}
      href={href?.(run.chatId)}
      onOpen={onOpen && (() => onOpen(run.chatId))}
    />
  </div>
)
