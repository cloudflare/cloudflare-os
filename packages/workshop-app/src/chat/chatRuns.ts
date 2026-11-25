import type { Agent, AgentRun, RunStatus } from '@/automations/agents'
import type { ChatItem } from './chatItems'

/** A run a chat's agent started, with the agent it is a run of. */
export type ChatRun = AgentRun & { agent: { key: string; name: string } }

/**
 * A point in a chat that is about an agent it started rather than said in it: the agent starting,
 * where it started, or ending, where it ended.
 */
export type RunMark = { kind: 'started' | 'ended'; key: string; at: Date; run: ChatRun }

/** Where a chat's run marks go among its rows: before the row at each index, and after them all. */
export type PlacedRunMarks = { before: ReadonlyMap<number, RunMark[]>; after: RunMark[] }

/** How a run stands once it has ended: done, with changes to keep, or failed. */
export const ENDED: ReadonlySet<RunStatus> = new Set(['done', 'changes', 'failed'])

/** The runs `chatId`'s agent started, of those the agents were read with, the first started first. */
export const runsStartedBy = (agents: readonly Agent[], chatId: number): ChatRun[] =>
  agents
    .flatMap(({ key, name, runs }) => runs.filter((run) => run.spawnedByChatId === chatId).map((run) => ({ ...run, agent: { key, name } })))
    .toSorted((a, b) => a.started.getTime() - b.started.getTime() || a.chatId - b.chatId)

// When a row was said, for those that say so: what a person sent once the agent read it, and what the agent wrote.
const timeOf = (item: ChatItem) => (item.kind === 'user' || item.kind === 'assistant' ? item.sentAt : undefined)

/**
 * Whether two readings of a chat's runs show the same: the same runs, each standing as it did,
 * so that what is drawn of them can stay as it is while other runs of the workspace change.
 */
export const sameRuns = (a: readonly ChatRun[], b: readonly ChatRun[]) =>
  a.length === b.length &&
  a.every((run, index) => {
    const other = b[index]
    return run.chatId === other.chatId && run.status === other.status && run.title === other.title && run.agent.name === other.agent.name &&
      run.started.getTime() === other.started.getTime() && run.lastActive.getTime() === other.lastActive.getTime()
  })

/**
 * Where the marks of a chat's runs go among its rows (`items`): each where it happened, before
 * the first row said after then, or after everything while nothing has been, so that what the
 * agent says of the agents it started ("I've set up five agents and am waiting for them") comes
 * after them, and how each ended after that. While the earlier history is still to be read
 * (`hasEarlier`), what happened before the first row said is left out, as its place is among what
 * is not read yet. A run's end is when it was last active, as one that has ended does nothing
 * more until someone asks it to, and is never above its start. Marks in one place are in the
 * order they happened, the first started first.
 */
export const placeRunMarks = (items: readonly ChatItem[], runs: readonly ChatRun[], hasEarlier = false): PlacedRunMarks => {
  const firstAfter = (at: Date) => {
    const index = items.findIndex((item) => {
      const time = timeOf(item)
      return time !== undefined && time.getTime() > at.getTime()
    })
    return index === -1 ? items.length : index
  }
  const readFrom = hasEarlier ? items.map(timeOf).find((time) => time !== undefined) : undefined
  const read = (at: Date) => readFrom === undefined || at.getTime() >= readFrom.getTime()
  const marks: Array<{ index: number; mark: RunMark }> = []
  for (const run of runs) {
    const started = firstAfter(run.started)
    if (read(run.started)) marks.push({ index: started, mark: { kind: 'started', key: `run-started:${run.chatId}`, at: run.started, run } })
    // Never before it started, even were the two to say otherwise.
    const ended = run.lastActive.getTime() < run.started.getTime() ? run.started : run.lastActive
    if (!ENDED.has(run.status) || !read(ended)) continue
    marks.push({ index: Math.max(firstAfter(ended), started), mark: { kind: 'ended', key: `run-ended:${run.chatId}`, at: ended, run } })
  }
  const before = new Map<number, RunMark[]>()
  const after: RunMark[] = []
  // A run's start comes before its end however close the two were, and runs started at once in
  // the order they were.
  const order = (a: RunMark, b: RunMark) =>
    a.at.getTime() - b.at.getTime() || Number(a.kind === 'ended') - Number(b.kind === 'ended') || a.run.chatId - b.run.chatId
  for (const { index, mark } of marks) {
    const place = index >= items.length ? after : before.get(index) ?? (before.set(index, []).get(index)!)
    place.push(mark)
  }
  for (const place of before.values()) place.sort(order)
  after.sort(order)
  return { before, after }
}

/**
 * The steps among which `marks` happened, split at them: for each mark, those started before it
 * and after the mark before it, and the rest, started after them all, so that where the steps are
 * shown each mark is after the step that was under way when it happened (the code that started an
 * agent, or waited for it to end). Steps are taken one after another, and a step says when it was
 * done (`at`: when the message it is in was written, once it was): one starts as the one before it
 * is done, the first before anything is marked. One after a step that does not say (being taken
 * still, or what was thought) is never before a mark.
 */
export const splitSteps = <Step extends object>(steps: readonly Step[], marks: readonly RunMark[]): { before: Step[][]; rest: Step[] } => {
  const doneAt = (step: Step) => ('at' in step && step.at instanceof Date ? step.at.getTime() : Infinity)
  const startedBefore = (index: number, at: Date) => index === 0 || doneAt(steps[index - 1]) < at.getTime()
  let from = 0
  const before = marks.map(({ at }) => {
    let to = from
    while (to < steps.length && startedBefore(to, at)) to++
    const these = steps.slice(from, to)
    from = to
    return these
  })
  return { before, rest: steps.slice(from) }
}
