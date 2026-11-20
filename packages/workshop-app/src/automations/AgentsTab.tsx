import { AgentRow } from '@/blocks/AgentRow'
import { PlusIcon, RobotIcon } from '@phosphor-icons/react'
import { Button, EmptyState, ListGroup } from '@gadgets/ui'
import { attentionWords, gadgetsOf, gadgetTitles, runsWords, type Agent } from './agents'
import type { WorkspaceAgentsSnapshot } from './WorkspaceAgents'

export type AgentsTabProps = {
  /** The workspace's agents, as `useWorkspaceAgents` reads them. */
  state: WorkspaceAgentsSnapshot
  /** Reads them again, after they could not be. */
  onRetry: () => void
  onOpenAgent: (agent: Agent) => void
  /** An agent's page's address, for its row to link to so that it can be opened in another tab. */
  agentHref?: (agent: Agent) => string
  /** The clock it is shown by, which moves on while it is shown. */
  now: number
  /** Starts a chat that asks for an agent, offered while there are none. */
  onAddAgent?: () => void
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
 * A workspace's agents, as a tab of its page: every agent, each opening its page, those that want
 * the user first, its row saying so ("2 runs are waiting on you"). The runs themselves are on the
 * Chats tab, which lists those that want the user first. Of the runs, the workspace's latest are
 * what it says (`allRuns`).
 */
export const AgentsTab = ({ state, onRetry, onOpenAgent, agentHref, now, onAddAgent }: AgentsTabProps) => {
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
  return (
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
  )
}
