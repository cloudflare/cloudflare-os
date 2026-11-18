import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { AgentSetup, RunSignals } from './agents'

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

/** A workspace's agents as their gadgets set them up, for the gallery and the scripted chats. */
export const EXAMPLE_AGENT_SETUPS: AgentSetup[] = [
  { spawnerId: 41, name: 'Inbox helper', model: 'Claude Sonnet 4.6', gadget: { id: 7, title: 'Inbox', bindingName: 'HELPER' } },
  { spawnerId: 42, name: 'Release notes', model: 'Claude Haiku 4.5', gadget: { id: 8, title: 'Changelog', bindingName: 'WRITER' } },
  { spawnerId: 43, name: 'Ticket summarizer', model: 'Claude Haiku 4.5', gadget: { id: 9, title: 'Issue triage', bindingName: 'SUMMARIZER' } },
  { spawnerId: 44, name: 'Forecast checker', gadget: { id: 10, title: 'Forecast', bindingName: 'CHECKER' } },
]

/**
 * Their runs: one of the Inbox helper's waiting on a decision and another with an action of its
 * own waiting, the latest of Release notes' failed and an older one with changes still to keep,
 * and the Ticket summarizer at work. The Forecast checker has not run.
 */
export const EXAMPLE_AGENT_CHATS: AiChatMetadata[] = [
  run(101, 41, 'Inbox helper', 'Reply to “Invoice 4471 overdue”', 5, { awaitingDecision: true }),
  // Named as it was started, before the agent was renamed.
  run(102, 41, 'Inbox assistant', 'Reply to “Lunch on Friday?”', 48),
  run(103, 41, 'Inbox helper', 'Reply to “Contract renewal”', 90),
  run(104, 41, 'Inbox helper', 'Reply to “Refund for order 2210”', 60 * 26),
  run(105, 41, 'Inbox helper', 'Reply to “Welcome aboard”', 60 * 24 * 9),
  run(201, 42, 'Release notes', 'Notes for 4.12', 60 * 20),
  run(202, 42, 'Release notes', 'Notes for 4.11', 60 * 24 * 7),
  run(203, 42, 'Release notes', 'Notes for 4.10', 60 * 24 * 14, { proposedChangeWorkpieces: [12] }),
  run(301, 43, 'Ticket summarizer', 'Summarize PLAT-2291', 1, { activeAgent: { type: 'agent', id: 'haiku', name: 'Claude Haiku 4.5' } }),
  run(302, 43, 'Ticket summarizer', 'Summarize PLAT-2290', 12),
  // Someone's own chat, which is not an agent's run.
  { id: 1, title: 'Plan the support rota', started: minutesAgo(400), lastActive: minutesAgo(30) },
]

/** What else says how they stand: an action of run 103's waiting, and run 201 having failed. */
export const EXAMPLE_SIGNALS: RunSignals = { pending: new Set([103]), failed: new Set([201]) }
