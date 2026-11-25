import type { Agent, AgentRun, RunStatus } from '@/automations/agents'
import type { ChatItem } from './chatItems'

/** A run a chat's agent started, with the agent it is a run of. */
export type ChatRun = AgentRun & { agent: { key: string; name: string } }

/**
 * A point in a chat that is about the agents it started rather than said in it: the agents one
 * turn started, at the end of that turn, or one of them ending, where it ended.
 */
export type RunMark =
  | { kind: 'started'; key: string; at: Date; runs: ChatRun[] }
  | { kind: 'ended'; key: string; at: Date; run: ChatRun }

/** Where a chat's run marks go among its rows: before the row at each index, and after them all. */
export type PlacedRunMarks = { before: ReadonlyMap<number, RunMark[]>; after: RunMark[] }

/** How a run stands once it has ended: done, with changes to keep, or failed. */
export const ENDED: ReadonlySet<RunStatus> = new Set(['done', 'changes', 'failed'])

/** How a run ended, as its mark says it after its title. */
export const ENDED_WORDS: Partial<Record<RunStatus, string>> = {
  done: 'Finished',
  changes: 'Finished · changes to keep',
  failed: 'Failed',
}

/** The runs `chatId`'s agent started, of those the agents were read with, the first started first. */
export const runsStartedBy = (agents: readonly Agent[], chatId: number): ChatRun[] =>
  agents
    .flatMap(({ key, name, runs }) => runs.filter((run) => run.spawnedByChatId === chatId).map((run) => ({ ...run, agent: { key, name } })))
    .toSorted((a, b) => a.started.getTime() - b.started.getTime() || a.chatId - b.chatId)

// When a row was said, for those that say so: what a person sent once the agent read it, and what the agent wrote.
const timeOf = (item: ChatItem) => (item.kind === 'user' || item.kind === 'assistant' ? item.sentAt : undefined)

/**
 * Where the marks of a chat's runs go among its rows (`items`). The agents a turn started are
 * what it produced, so they go at its end, as its artefacts do: before the next message a person
 * sent after the first of them started, or after everything while that turn is still the last.
 * A run that ended goes where it ended, before the first row said after then, but never above
 * the mark of its start. A run's end is when it was last active, as one that has ended does
 * nothing more until someone asks it to. Marks in one place are in the order they happened.
 */
export const placeRunMarks = (items: readonly ChatItem[], runs: readonly ChatRun[]): PlacedRunMarks => {
  const firstAfter = (at: Date, counts: (item: ChatItem) => boolean) => {
    const index = items.findIndex((item) => {
      const time = timeOf(item)
      return time !== undefined && counts(item) && time.getTime() > at.getTime()
    })
    return index === -1 ? items.length : index
  }
  const marks: Array<{ index: number; mark: RunMark }> = []
  const startedAt = new Map<number, number>()
  const turns = new Map<number, ChatRun[]>()
  for (const run of runs) {
    const index = firstAfter(run.started, (item) => item.kind === 'user')
    startedAt.set(run.chatId, index)
    turns.set(index, [...(turns.get(index) ?? []), run])
  }
  for (const [index, started] of turns) {
    marks.push({ index, mark: { kind: 'started', key: `runs-started:${started[0].chatId}`, at: started[0].started, runs: started } })
  }
  for (const run of runs) {
    if (!ENDED.has(run.status)) continue
    const index = Math.max(firstAfter(run.lastActive, () => true), startedAt.get(run.chatId)!)
    marks.push({ index, mark: { kind: 'ended', key: `run-ended:${run.chatId}`, at: run.lastActive, run } })
  }
  const before = new Map<number, RunMark[]>()
  const after: RunMark[] = []
  // Where a run started and ended in one place, its start comes first however close the two were.
  const order = (a: RunMark, b: RunMark) => a.at.getTime() - b.at.getTime() || (a.kind === 'started' ? -1 : 0) - (b.kind === 'started' ? -1 : 0)
  for (const { index, mark } of marks) {
    const place = index >= items.length ? after : before.get(index) ?? (before.set(index, []).get(index)!)
    place.push(mark)
  }
  for (const place of before.values()) place.sort(order)
  after.sort(order)
  return { before, after }
}
