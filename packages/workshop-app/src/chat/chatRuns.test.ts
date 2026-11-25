import { describe, expect, it } from 'vitest'
import type { Agent, RunStatus } from '@/automations/agents'
import type { ChatItem } from './chatItems'
import { placeRunMarks, runsStartedBy, sameRuns, type ChatRun } from './chatRuns'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 25, 12, minutes))
const said = (id: number, kind: 'user' | 'assistant', minutes: number) =>
  ({ kind, id, key: `${kind}-${id}`, sentAt: at(minutes) }) as unknown as ChatItem
const output = (id: number) => ({ kind: 'output', id, key: `output-${id}` }) as unknown as ChatItem
const run = (chatId: number, started: number, status: RunStatus = 'running', lastActive = started): ChatRun =>
  ({ chatId, title: `Run ${chatId}`, started: at(started), lastActive: at(lastActive), status, spawnedByChatId: 1, agent: { key: '4', name: 'General' } })

const keysOf = ({ before, after }: ReturnType<typeof placeRunMarks>) => ({
  before: Object.fromEntries([...before].map(([index, marks]) => [index, marks.map(({ key }) => key)])),
  after: after.map(({ key }) => key),
})

describe('runsStartedBy', () => {
  it('lists the runs the chat’s agent started, of every agent, the first started first, each with its agent', () => {
    const agents = [
      { key: '4', name: 'General', runs: [run(12, 3), { ...run(13, 1), spawnedByChatId: 2 }] },
      { key: '5', name: 'Reviewer', runs: [run(11, 2), { ...run(14, 0), spawnedByChatId: undefined }] },
    ] as unknown as Agent[]
    const runs = runsStartedBy(agents, 1)
    expect(runs.map(({ chatId, agent }) => [chatId, agent.name])).toEqual([[11, 'Reviewer'], [12, 'General']])
  })
})

describe('placeRunMarks', () => {
  const items = [said(0, 'user', 0), said(1, 'assistant', 2), output(1), said(2, 'user', 10), said(3, 'assistant', 12)]

  it('puts the agents started where they started, before what the agent says of them, the first started first', () => {
    expect(keysOf(placeRunMarks(items, [run(21, 1), run(20, 1)]))).toEqual({ before: { 1: ['run-started:20', 'run-started:21'] }, after: [] })
  })

  it('puts each where it started where the agent said something between them', () => {
    expect(keysOf(placeRunMarks(items, [run(20, 1), run(21, 3)]))).toEqual({ before: { 1: ['run-started:20'], 3: ['run-started:21'] }, after: [] })
  })

  it('puts them before the next message a person sent where the agent said nothing more', () => {
    expect(keysOf(placeRunMarks(items, [run(20, 5)]))).toEqual({ before: { 3: ['run-started:20'] }, after: [] })
  })

  it('puts them after everything while nothing has been said since', () => {
    expect(keysOf(placeRunMarks(items, [run(20, 13)]))).toEqual({ before: {}, after: ['run-started:20'] })
  })

  it('marks a run that ended where it ended, and none that is still at work or waits', () => {
    const marks = placeRunMarks(items, [run(20, 1, 'done', 11), run(21, 1, 'waiting', 11), run(22, 1, 'failed', 20)])
    expect(keysOf(marks)).toEqual({ before: { 1: ['run-started:20', 'run-started:21', 'run-started:22'], 4: ['run-ended:20'] }, after: ['run-ended:22'] })
  })

  it('puts the end after the start of a run that ended as soon as it started', () => {
    const marks = placeRunMarks(items, [run(20, 1, 'changes', 1)])
    expect(keysOf(marks)).toEqual({ before: { 1: ['run-started:20', 'run-ended:20'] }, after: [] })
  })

  it('keeps marks in one place in the order they happened', () => {
    const marks = placeRunMarks(items, [run(20, 1, 'done', 7), run(21, 1, 'done', 5), run(22, 11)])
    expect(keysOf(marks).before).toEqual({ 1: ['run-started:20', 'run-started:21'], 3: ['run-ended:21', 'run-ended:20'], 4: ['run-started:22'] })
  })

  it('leaves out what happened before the first row read while the earlier history is still to be read', () => {
    const marks = placeRunMarks(items.slice(3), [run(20, 1, 'done', 5), run(21, 1, 'done', 11), run(22, 11)], true)
    expect(keysOf(marks)).toEqual({ before: { 1: ['run-started:22', 'run-ended:21'] }, after: [] })
  })

  it('places the same marks however much was read once it is all read', () => {
    expect(keysOf(placeRunMarks(items.slice(3), [run(20, 1, 'done', 5)]))).toEqual({ before: { 0: ['run-started:20', 'run-ended:20'] }, after: [] })
  })

  it('puts a run’s end after its start where it says it was last active before it started', () => {
    const marks = placeRunMarks(items, [run(20, 11, 'done', 1)])
    expect(keysOf(marks)).toEqual({ before: { 4: ['run-started:20', 'run-ended:20'] }, after: [] })
  })

  it('places a run whose start is after everything said with its end after it', () => {
    expect(keysOf(placeRunMarks(items, [run(20, 13, 'failed', 14)]))).toEqual({ before: {}, after: ['run-started:20', 'run-ended:20'] })
  })
})

describe('sameRuns', () => {
  it('holds while each run stands as it did, and not once one changes', () => {
    const runs = [run(20, 1), run(21, 1, 'done', 5)]
    expect(sameRuns(runs, runs.map((one) => ({ ...one, started: at(1), lastActive: new Date(one.lastActive) })))).toBe(true)
    expect(sameRuns(runs, [runs[0], { ...runs[1], status: 'failed' }])).toBe(false)
    expect(sameRuns(runs, [runs[0], { ...runs[1], lastActive: at(6) }])).toBe(false)
    expect(sameRuns(runs, runs.slice(1))).toBe(false)
  })
})
