import { AgentRow } from '@/blocks/AgentRow'
import { AgentRunRow } from '@/blocks/AgentRunRow'
import { Button, ListGroup, formatActivity } from '@gadgets/ui'
import { attentionWords, gadgetsOf, gadgetTitles, runsWantingAttention, runsWords, STATUS_WORDS, type Agent } from './agents'
import type { WorkspaceAgentsSnapshot } from './WorkspaceAgents'

export type AgentsTabProps = {
  /** The workspace's agents, as `useWorkspaceAgents` reads them. */
  state: WorkspaceAgentsSnapshot
  /** Reads them again, after they could not be. */
  onRetry: () => void
  onOpenAgent: (agent: Agent) => void
  /** An agent's page's address, for its row to link to so that it can be opened in another tab. */
  agentHref?: (agent: Agent) => string
  /** Opens one of an agent's runs. */
  onOpenRun: (run: { chatId: number; title: string }) => void
  /** A run's address, for its row to link to so that it can be opened in another tab. */
  runHref?: (chatId: number) => string
  /** The clock it is shown by, which moves on while it is shown. */
  now: number
}

/**
 * What an agent is and has done, in words, as its row says it: the gadgets bound to it, then its
 * runs, of `all` of them or of those read.
 */
export const agentDetail = (agent: Agent, all: boolean, now?: Date) => {
  const gadgets = gadgetsOf(agent)
  return [gadgets.length > 0 && `Started by ${gadgetTitles(gadgets)}`, runsWords(agent, all, now)].filter(Boolean).join(' · ')
}

/**
 * A workspace's agents, as a tab of its page: first the runs that want the user (waiting on them,
 * or the latest an agent had, which failed), each opening its conversation, so that nobody has to
 * look through an agent's runs to find them; then every agent, each opening its page, those that
 * want the user first. Of the runs, the workspace's latest are what it says (`allRuns`).
 */
export const AgentsTab = ({ state, onRetry, onOpenAgent, agentHref, onOpenRun, runHref, now }: AgentsTabProps) => {
  if (state.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading agents…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
        Couldn’t load agents: {state.message}
        <Button variant="ghost" onClick={onRetry}>Try again</Button>
      </p>
    )
  }
  const { agents } = state
  if (agents.length === 0) {
    return (
      <p className="px-4 text-center text-base text-pretty text-kumo-subtle">
        {state.setUpRead
          ? 'No agents here yet. A gadget can have agents of its own, such as one that answers each email that arrives: ask for one in a chat.'
          : 'Loading agents…'}
      </p>
    )
  }
  const date = new Date(now)
  const wanting = runsWantingAttention(agents)
  return (
    <>
      {wanting.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="px-4 text-sm font-medium text-kumo-subtle">Needs you</h2>
          <ListGroup label="Needs you">
            {wanting.map(({ agent, run }) => (
              <AgentRunRow
                key={run.chatId}
                title={run.title}
                status={run.status}
                statusWords={STATUS_WORDS[run.status]}
                agent={agent.name}
                time={formatActivity(run.lastActive, date)}
                href={runHref?.(run.chatId)}
                onSelect={() => onOpenRun(run)}
              />
            ))}
          </ListGroup>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="px-4 text-sm font-medium text-kumo-subtle">Agents</h2>
        <ListGroup label="Agents">
          {agents.map((agent) => {
            const words = attentionWords(agent)
            return (
              <AgentRow
                key={agent.key}
                name={agent.name}
                detail={agentDetail(agent, state.allRuns, date)}
                attention={words ? { words, tone: agent.waiting > 0 ? 'warning' : 'danger' } : undefined}
                running={agent.running > 0}
                href={agentHref?.(agent)}
                onSelect={() => onOpenAgent(agent)}
              />
            )
          })}
        </ListGroup>
      </section>
    </>
  )
}
