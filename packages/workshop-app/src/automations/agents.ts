import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { formatActivity } from '@/workspaces/formatActivity'

/** One run of an agent: the conversation it had, as its workspace lists it. */
export type AgentRun = {
  chatId: number
  title: string
  lastActive: Date
}

/**
 * An agent a workspace's gadgets call on (an agent spawner), as its runs say: a chat names the
 * spawner that started it (`AiChatMetadata.spawnerName`), so an agent that has never run is not
 * known here.
 */
export type Agent = {
  /** Its name, which is all a run says of it. */
  key: string
  name: string
  /** Its conversations, latest first. */
  runs: AgentRun[]
}

/** A workspace's agents, by the runs among its chats, the one that ran last first. */
export const agentsOf = (chats: readonly AiChatMetadata[]): Agent[] => {
  const byName = new Map<string, AgentRun[]>()
  for (const chat of chats) {
    if (chat.spawnerName === undefined) continue
    const runs = byName.get(chat.spawnerName) ?? []
    runs.push({ chatId: chat.id, title: chat.title || 'Untitled run', lastActive: chat.lastActive })
    byName.set(chat.spawnerName, runs)
  }
  return [...byName]
    .map(([name, runs]) => ({ key: name, name, runs: runs.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime()) }))
    .toSorted((a, b) => b.runs[0].lastActive.getTime() - a.runs[0].lastActive.getTime())
}

const COUNT = new Intl.NumberFormat('en')

/** When something was, in words that can follow others: "2 hours ago", "just now", "yesterday". */
export const activityWords = (at: Date, now?: Date) => formatActivity(at, now).replace(/^(Just now|Yesterday)$/, (word) => word.toLowerCase())

/** An agent's runs, in words: how many, and when the latest was. */
export const runsWords = ({ runs }: Agent, now?: Date) =>
  `${runs.length === 1 ? 'One run' : `${COUNT.format(runs.length)} runs`} · latest ${activityWords(runs[0].lastActive, now)}`
