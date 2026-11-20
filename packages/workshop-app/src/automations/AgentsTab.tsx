import { AgentRow } from '@/blocks/AgentRow'
import { AgentRunRow } from '@/blocks/AgentRunRow'
import { ListGroup } from '@/blocks/ListGroup'
import { PlusIcon, RobotIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { EmptyState } from '@/components/EmptyState'
import { formatActivity } from '@/workspaces/formatActivity'
import { attentionWords, runsWantingAttention, runsWords, STATUS_WORDS, type Agent } from './agents'
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
  /** Starts a chat that asks for an agent, offered while there are none. */
  onAddAgent?: () => void
}

/** What an agent is and has done, in words, as its row says it: the gadget that starts it, then its runs. */
export const agentDetail = (agent: Agent, now?: Date) =>
  [agent.gadget && `Started by ${agent.gadget.title}`, runsWords(agent, now)].filter(Boolean).join(' · ')

/**
 * A workspace's agents, as a tab of its page: first the runs that want the user (waiting on them,
 * or the latest an agent had, which failed), each opening its conversation, so that nobody has to
 * look through an agent's runs to find them; then every agent, each opening its page, those that
 * want the user first.
 */
export const AgentsTab = ({ state, onRetry, onOpenAgent, agentHref, onOpenRun, runHref, now, onAddAgent }: AgentsTabProps) => {
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
    if (!state.setUpRead) return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading agents…</p>
    return (
      <EmptyState
        size="section"
        tinted
        icon={RobotIcon}
        title="No agents yet"
        description="An app can have agents of its own that work while you’re away, such as one that answers each email that arrives. Ask for one in a chat."
        actions={onAddAgent && [{ label: 'Add agent', icon: PlusIcon, variant: 'primary', onClick: onAddAgent }]}
      />
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
                detail={agentDetail(agent, date)}
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
