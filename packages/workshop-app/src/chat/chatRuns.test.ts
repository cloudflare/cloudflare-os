import { describe, expect, it } from 'vitest'
import type { Agent, RunStatus } from '@/automations/agents'
import type { ChatItem } from './chatItems'
import { placeRunMarks, runsStartedBy, type ChatRun } from './chatRuns'

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

  it('puts the agents started under what the agent says next, as one mark', () => {
    expect(keysOf(placeRunMarks(items, [run(20, 1), run(21, 1)]))).toEqual({ before: { 2: ['runs-started:20'] }, after: [] })
  })

  it('puts them at the end of the turn where the agent says nothing more in it', () => {
    const quiet = [said(0, 'user', 0), said(1, 'assistant', 2), output(1), said(2, 'user', 10)]
    expect(keysOf(placeRunMarks(quiet, [run(20, 5)]))).toEqual({ before: { 3: ['runs-started:20'] }, after: [] })
  })

  it('puts them after everything while what the agent says next is still to come', () => {
    expect(keysOf(placeRunMarks(items, [run(20, 13)]))).toEqual({ before: {}, after: ['runs-started:20'] })
  })

  it('marks a run that ended where it ended, and none that is still at work or waits', () => {
    const marks = placeRunMarks(items, [run(20, 1, 'done', 11), run(21, 1, 'waiting', 11), run(22, 1, 'failed', 20)])
    expect(keysOf(marks)).toEqual({ before: { 2: ['runs-started:20'], 4: ['run-ended:20'] }, after: ['run-ended:22'] })
  })

  it('never marks the end above the start, for a run that ended before the agent said anything', () => {
    const marks = placeRunMarks(items, [run(20, 1, 'changes', 1)])
    expect(keysOf(marks)).toEqual({ before: { 2: ['runs-started:20', 'run-ended:20'] }, after: [] })
  })

  it('keeps marks in one place in the order they happened', () => {
    const marks = placeRunMarks(items, [run(20, 1, 'done', 7), run(21, 1, 'done', 5), run(22, 11)])
    expect(keysOf(marks).before[3]).toEqual(['run-ended:21', 'run-ended:20'])
  })
})
