import type { AgentsMenuProps } from '@/blocks/AgentsMenu'
import { activityWords, runsWords, type Agent } from './agents'

/**
 * What a header's agents menu (`AgentsMenu`) says of the agents working for what it is the
 * header of, the one that ran last first: each with its runs, and when the latest of all was.
 */
export const agentsMenuOf = (
  agents: readonly Agent[],
  onOpenAgent: (agentId: number) => void,
  onOpenAutomations: (() => void) | undefined,
): Omit<AgentsMenuProps, 'title' | 'compact'> => {
  const latest = agents[0]?.runs[0]
  return {
    agents: agents.map((agent) => ({ key: String(agent.id), name: agent.name, runs: runsWords(agent), waiting: agent.runs.some(({ waiting }) => waiting) })),
    latest: latest && activityWords(latest.lastActive),
    onOpenAgent: (key) => onOpenAgent(Number(key)),
    onOpenAutomations,
  }
}
