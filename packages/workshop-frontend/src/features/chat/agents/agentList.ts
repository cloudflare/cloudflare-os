import type { AiChatMetadata } from '@gadgets/workshop-shared/api'

/**
 * Why an agent is asking for the user, in the order the list surfaces it.
 *
 * A run awaiting review outranks unreviewed work: the agent needs a decision before the user can
 * consider it dealt with, where proposed changes merely sit there.
 */
export type AgentAttention = 'review' | 'changes'

/**
 * One agent's standing in the workspace: what it has done, and whether it needs the user.
 *
 * `key` names the spawner itself, so renaming it keeps one agent and two spawners that share a
 * name stay two. `name` is what the newest run calls it.
 */
export type AgentSummary = {
  key: string
  name: string
  /** This agent's runs, newest first, matching the chat list's own ordering. */
  runs: AiChatMetadata[]
  /** Runs whose agent is working right now. */
  running: number
  /** Why this agent needs the user, or undefined when it does not. */
  attention: AgentAttention | undefined
  /** Runs that need the user, however they need it; drives the count beside the agent's name. */
  waiting: number
  /** Unread messages across this agent's runs. */
  unread: number
  /** Runs active today, by last activity rather than start, as the list's own ordering is. */
  today: number
  /** Last activity across the agent's runs. */
  lastRun: Date
  /** Summed `totalCost` of every run, omitted when none reported one. */
  cost: number | undefined
}

/** A chat has work the user has not accepted yet. */
export const hasPendingChanges = (chat: AiChatMetadata): boolean =>
  (chat.proposedChangeWorkpieces?.length ?? 0) > 0

/**
 * A run has a request for the user to review: an action awaiting approval, `withApprovals`
 * holding the runs that have one, or a decision its agent stopped to wait for.
 */
export const needsReview = (
  run: AiChatMetadata,
  withApprovals: { has(runId: number): boolean },
): boolean => withApprovals.has(run.id) || run.awaitingDecision === true

/**
 * Collapses the workspace's chats into one entry per agent that has run.
 *
 * Agents are derived from the chats they produced rather than listed outright, because the client
 * has no view of a workspace's spawners: `subscribeToWorkpieces` delivers gadgets and worktrees,
 * not gatekeepers. An agent therefore appears once it has run at least once, and a spawner created
 * a moment ago is not here yet.
 *
 * `chats` must already be in display order (newest activity first); `runs` preserves it.
 * `withApprovals` holds the runs with an action awaiting approval (see `needsReview`).
 */
export const deriveAgents = (
  chats: readonly AiChatMetadata[],
  withApprovals: { has(runId: number): boolean },
  now: Date,
  unreadByRun: ReadonlyMap<number, number> = new Map(),
): AgentSummary[] => {
  // Runs from before chats recorded their spawner's id carry only its name. They join the agent
  // whose newest run goes by that name, so an existing agent does not split in two.
  const keyByName = new Map<string, string>()
  for (const chat of chats) {
    if (chat.spawnerId !== undefined && chat.spawnerName && !keyByName.has(chat.spawnerName)) {
      keyByName.set(chat.spawnerName, `spawner:${chat.spawnerId}`)
    }
  }

  const agents = new Map<string, AgentSummary>()
  for (const chat of chats) {
    const name = chat.spawnerName
    if (!name) continue
    const key = chat.spawnerId !== undefined
      ? `spawner:${chat.spawnerId}`
      : keyByName.get(name) ?? `name:${name}`

    let agent = agents.get(key)
    if (!agent) {
      agent = {
        key, name, runs: [], running: 0,
        attention: undefined, waiting: 0, unread: 0, today: 0,
        lastRun: chat.lastActive, cost: undefined,
      }
      agents.set(key, agent)
    }

    agent.runs.push(chat)
    if (chat.activeAgent) agent.running++
    if (chat.lastActive > agent.lastRun) agent.lastRun = chat.lastActive
    if (isSameDay(chat.lastActive, now)) agent.today++
    if (chat.totalCost != null) agent.cost = (agent.cost ?? 0) + chat.totalCost
    agent.unread += unreadByRun.get(chat.id) ?? 0

    const waiting = needsReview(chat, withApprovals)
    if (waiting || hasPendingChanges(chat)) agent.waiting++
    if (waiting) agent.attention = 'review'
    else if (hasPendingChanges(chat) && !agent.attention) agent.attention = 'changes'
  }
  return [...agents.values()]
}

/** The chats the user started themselves, which are all the Chats tab shows. */
export const ownConversations = (chats: readonly AiChatMetadata[]): AiChatMetadata[] =>
  chats.filter(chat => !chat.spawnerName)

/** Agents the user has to deal with, which is what the Agents tab badges. */
export const agentsNeedingAttention = (agents: readonly AgentSummary[]): number =>
  agents.filter(agent => agent.attention || agent.unread > 0).length

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const WEEKDAY_TIME = new Intl.DateTimeFormat(undefined,
  { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "2:35 PM" today, "Mon 11:08 AM" within the week, "12 Nov" beyond it. */
export const formatLastRun = (at: Date, now: Date): string => {
  if (isSameDay(at, now)) return TIME.format(at)
  return now.getTime() - at.getTime() < 7 * DAY_MS ? WEEKDAY_TIME.format(at) : DATE.format(at)
}

/**
 * How long ago a run last did anything: "11m", "3h", "2d".
 *
 * Runs in a list are read against each other rather than against the clock — which of these
 * happened most recently — and an elapsed time compares at a glance where a wall time does not.
 */
export const formatRunAge = (at: Date, now: Date): string => {
  const elapsed = now.getTime() - at.getTime()
  if (elapsed < MINUTE_MS) return 'now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`
  return DATE.format(at)
}
