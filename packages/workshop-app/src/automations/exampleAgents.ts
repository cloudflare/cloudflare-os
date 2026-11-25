import type { AgentSpawnerInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { setupsOf, type RunSignals } from './agents'

/** The time the examples are shown at, so that what they say of when stays the same. */
export const EXAMPLE_NOW = new Date(2026, 10, 17, 15, 0)

const minutesAgo = (minutes: number) => new Date(EXAMPLE_NOW.getTime() - minutes * 60_000)
const run = (id: number, spawnerId: number, spawnerName: string, title: string, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id,
  title,
  started: minutesAgo(minutes + 2),
  lastActive: minutesAgo(minutes),
  spawnerId,
  spawnerName,
  notificationsRequireParticipation: true,
  ...more,
})

/** The gadgets that start them, by id, with their titles. */
export const EXAMPLE_GADGETS: ReadonlyMap<number, string> = new Map([[7, 'Inbox'], [8, 'Changelog'], [9, 'Issue triage'], [10, 'Forecast']])

/**
 * A workspace's agent spawners, for the gallery and the scripted chats: the Ticket summarizer
 * bound by two gadgets, and the Forecast checker with no model.
 */
export const EXAMPLE_AGENT_SPAWNERS: AgentSpawnerInfo[] = [
  { id: 41, config: { displayName: 'Inbox helper', modelId: 'sonnet' }, modelName: 'Claude Sonnet 4.6', bindings: [{ gadgetId: 7, name: 'HELPER' }] },
  { id: 42, config: { displayName: 'Release notes', modelId: 'haiku' }, modelName: 'Claude Haiku 4.5', bindings: [{ gadgetId: 8, name: 'WRITER' }] },
  { id: 43, config: { displayName: 'Ticket summarizer', modelId: 'haiku' }, modelName: 'Claude Haiku 4.5', bindings: [{ gadgetId: 9, name: 'SUMMARIZER' }, { gadgetId: 7, name: 'SUMMARIZER' }] },
  { id: 44, config: { displayName: 'Forecast checker', modelId: null }, bindings: [{ gadgetId: 10, name: 'CHECKER' }] },
]

/** What those spawners set up, one agent each. */
export const EXAMPLE_AGENT_SETUPS = setupsOf(EXAMPLE_AGENT_SPAWNERS, EXAMPLE_GADGETS)

/**
 * Their runs: one of the Inbox helper's waiting on a decision and another with an action of its
 * own waiting, the latest of Release notes' failed and an older one with changes still to keep,
 * and the Ticket summarizer at work. The Forecast checker has not run.
 */
export const EXAMPLE_AGENT_CHATS: AiChatMetadata[] = [
  run(101, 41, 'Inbox helper', 'Reply to “Invoice 4471 overdue”', 5, { awaitingDecision: true, spawnedByGadgetId: 7 }),
  // Named as it was started, before the agent was renamed.
  run(102, 41, 'Inbox assistant', 'Reply to “Lunch on Friday?”', 48),
  run(103, 41, 'Inbox helper', 'Reply to “Contract renewal”', 90),
  run(104, 41, 'Inbox helper', 'Reply to “Refund for order 2210”', 60 * 26),
  run(105, 41, 'Inbox helper', 'Reply to “Welcome aboard”', 60 * 24 * 9),
  run(201, 42, 'Release notes', 'Notes for 4.12', 60 * 20, { lastTurnFailed: true }),
  run(202, 42, 'Release notes', 'Notes for 4.11', 60 * 24 * 7),
  run(203, 42, 'Release notes', 'Notes for 4.10', 60 * 24 * 14, { proposedChangeWorkpieces: [12] }),
  run(301, 43, 'Ticket summarizer', 'Summarize PLAT-2291', 1, { activeAgent: { type: 'agent', id: 'haiku', name: 'Claude Haiku 4.5' } }),
  run(302, 43, 'Ticket summarizer', 'Summarize PLAT-2290', 12),
  // Someone's own chat, which is not an agent's run.
  { id: 1, title: 'Plan the support rota', started: minutesAgo(400), lastActive: minutesAgo(30) },
]

/** What else says how they stand: an action of run 103's waiting. */
export const EXAMPLE_SIGNALS: RunSignals = { pending: new Set([103]) }
