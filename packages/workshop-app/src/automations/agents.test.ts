import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { agentsOf, attentionWords, runStatus, runsWantingAttention, runsWords, isAgentRun, isFailure } from './agents'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata
const signals = (pending: number[] = [], failed: number[] = []) => ({ pending: new Set(pending), failed: new Set(failed) })

describe('isAgentRun', () => {
  it('tells an agent’s run from a chat someone started, by its spawner', () => {
    expect(isAgentRun(chat(1, 0, { spawnerId: 4 }))).toBe(true)
    expect(isAgentRun(chat(1, 0, { spawnerName: 'Old' }))).toBe(true)
    expect(isAgentRun(chat(1, 0))).toBe(false)
  })
})

describe('runStatus', () => {
  it('puts waiting on a person first, then at work, then failed, then changes to keep', () => {
    expect(runStatus(chat(1, 0, { awaitingDecision: true, activeAgent: { type: 'agent', id: 'm', name: 'M' } }))).toBe('waiting')
    expect(runStatus(chat(1, 0), signals([1]))).toBe('waiting')
    expect(runStatus(chat(1, 0, { activeAgent: { type: 'agent', id: 'm', name: 'M' } }), signals([], [1]))).toBe('running')
    expect(runStatus(chat(1, 0, { proposedChangeWorkpieces: [3] }), signals([], [1]))).toBe('failed')
    expect(runStatus(chat(1, 0, { proposedChangeWorkpieces: [3] }))).toBe('changes')
    expect(runStatus(chat(1, 0, { proposedChangeWorkpieces: [] }))).toBe('done')
  })
})

describe('isFailure', () => {
  it('is an error, unless a person stopped the turn', () => {
    const base = { chatId: 1, sequence: 1, timestamp: at(0), author: { type: 'agent', id: 'm', name: 'M' } } as const
    expect(isFailure({ ...base, type: 'error', message: 'Boom' })).toBe(true)
    expect(isFailure({ ...base, type: 'error', message: 'Stopped', code: 'stopped' })).toBe(false)
    expect(isFailure({ ...base, type: 'message', message: 'Hi' })).toBe(false)
  })
})

describe('agentsOf', () => {
  it('gives each agent its runs, latest first, keyed by its spawner, and leaves people’s chats out', () => {
    const chats = [
      chat(1, 5, { spawnerId: 4, spawnerName: 'Inbox helper' }),
      chat(2, 9, { spawnerId: 4, spawnerName: 'Inbox helper', title: '' }),
      chat(3, 12, { spawnerId: 5, spawnerName: 'Triage' }),
      chat(4, 30),
    ]
    const [triage, helper] = agentsOf(chats)
    expect(triage).toMatchObject({ key: '5', spawnerId: 5, name: 'Triage' })
    expect(helper.runs.map(({ chatId, title }) => [chatId, title])).toEqual([[2, 'Untitled run'], [1, 'Run 1']])
    expect(agentsOf([chat(4, 30)])).toEqual([])
  })

  it('keeps two agents of one name apart, and one renamed together, by their spawners', () => {
    const agents = agentsOf([
      chat(1, 5, { spawnerId: 4, spawnerName: 'Helper' }),
      chat(2, 4, { spawnerId: 6, spawnerName: 'Helper' }),
      chat(3, 3, { spawnerId: 4, spawnerName: 'Old name' }),
    ])
    expect(agents.map(({ key, runs }) => [key, runs.map(({ chatId }) => chatId)])).toEqual([['4', [1, 3]], ['6', [2]]])
  })

  it('puts a run from before runs said their spawner with the agent whose latest run has its name', () => {
    const agents = agentsOf([chat(1, 5, { spawnerId: 4, spawnerName: 'Helper' }), chat(2, 1, { spawnerName: 'Helper' }), chat(3, 0, { spawnerName: 'Gone' })])
    expect(agents.map(({ key, runs }) => [key, runs.length])).toEqual([['4', 2], ['name:Gone', 1]])
  })

  it('takes what an agent is from how it was set up, and lists one that has not run after those that have', () => {
    const setups = [
      { spawnerId: 4, name: 'Inbox helper', model: 'Sonnet', gadget: { id: 7, title: 'Inbox', bindingName: 'HELPER' } },
      { spawnerId: 9, name: 'Idle', gadget: { id: 8, title: 'Forecast', bindingName: 'IDLE' } },
    ]
    const [helper, idle] = agentsOf([chat(1, 5, { spawnerId: 4, spawnerName: 'Old name' })], signals(), setups)
    expect(helper).toMatchObject({ name: 'Inbox helper', model: 'Sonnet', gadget: { title: 'Inbox' } })
    expect(idle).toMatchObject({ key: '9', runs: [] })
    expect(runsWords(idle)).toBe('Hasn’t run yet')
  })

  it('counts what waits and what works, says a latest run failed, and puts those that want a person first', () => {
    const agents = agentsOf([
      chat(1, 30, { spawnerId: 1, spawnerName: 'Busy' }),
      chat(2, 20, { spawnerId: 2, spawnerName: 'Waiting', awaitingDecision: true }),
      chat(3, 19, { spawnerId: 2, spawnerName: 'Waiting' }),
      chat(4, 10, { spawnerId: 3, spawnerName: 'Failed' }),
      chat(5, 25, { spawnerId: 4, spawnerName: 'Recovered' }),
      chat(6, 24, { spawnerId: 4, spawnerName: 'Recovered' }),
    ], signals([3], [4, 6]))
    expect(agents.map(({ name, waiting, failed }) => [name, waiting, failed])).toEqual([
      ['Waiting', 2, false],
      ['Failed', 0, true],
      ['Busy', 0, false],
      ['Recovered', 0, false],
    ])
    expect(runsWantingAttention(agents).map(({ run }) => run.chatId)).toEqual([2, 3, 4])
    expect(attentionWords(agents[0])).toBe('2 runs are waiting on you')
    expect(attentionWords(agents[1])).toBe('Its latest run failed')
    expect(attentionWords(agents[2])).toBeUndefined()
  })

  it('says how many runs there were and when the latest was', () => {
    const [one] = agentsOf([chat(1, 0, { spawnerName: 'A' })])
    expect(runsWords(one, at(0))).toBe('One run · latest just now')
    const [many] = agentsOf([chat(1, 0, { spawnerName: 'A' }), chat(2, 0, { spawnerName: 'A' })])
    expect(runsWords(many, new Date(at(0).getTime() + 2 * 3_600_000))).toBe('2 runs · latest 2 hours ago')
  })
})
