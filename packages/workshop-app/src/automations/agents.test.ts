import { describe, expect, it } from 'vitest'
import type { AgentSpawnerInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { agentsOf, type AgentRun, type AgentSetup, attentionWords, foldRuns, gadgetsOf, gadgetTitles, runFilterCounts, runsMatching, runStatus, runsWantingAttention, runsWords, setupsOf } from './agents'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata
const signals = (pending: number[] = []) => ({ pending: new Set(pending) })
const spawner = (id: number, displayName: string, bindings: AgentSpawnerInfo['bindings'] = [], modelName?: string): AgentSpawnerInfo =>
  ({ id, config: { displayName, modelId: modelName ?? null }, ...(modelName ? { modelName } : {}), bindings })
const setup = (spawnerId: number, name: string, more: Partial<AgentSetup> = {}): AgentSetup => ({ spawnerId, name, gadgets: [], ...more })

describe('runStatus', () => {
  it('puts waiting on a person first, then at work, then failed, then changes to keep', () => {
    expect(runStatus(chat(1, 0, { awaitingDecision: true, activeAgent: { type: 'agent', id: 'm', name: 'M' } }))).toBe('waiting')
    expect(runStatus(chat(1, 0), signals([1]))).toBe('waiting')
    expect(runStatus(chat(1, 0, { activeAgent: { type: 'agent', id: 'm', name: 'M' }, lastTurnFailed: true }))).toBe('running')
    expect(runStatus(chat(1, 0, { proposedChangeWorkpieces: [3], lastTurnFailed: true }))).toBe('failed')
    expect(runStatus(chat(1, 0, { proposedChangeWorkpieces: [3] }))).toBe('changes')
    expect(runStatus(chat(1, 0, { proposedChangeWorkpieces: [] }))).toBe('done')
  })
})

describe('setupsOf', () => {
  const gadgets = new Map([[7, 'Inbox'], [8, 'Triage']])

  it('makes one agent of each spawner, named and given its model as it was made, bound to every gadget it is', () => {
    const setups = setupsOf([
      spawner(4, 'Inbox helper', [{ gadgetId: 8, name: 'HELPER' }, { gadgetId: 7, name: 'HELPER' }], 'Sonnet'),
      spawner(5, 'Idle'),
    ], gadgets)
    expect(setups).toEqual([
      { spawnerId: 4, name: 'Inbox helper', model: 'Sonnet', gadgets: [{ id: 8, title: 'Triage', bindingName: 'HELPER' }, { id: 7, title: 'Inbox', bindingName: 'HELPER' }] },
      { spawnerId: 5, name: 'Idle', gadgets: [] },
    ])
  })

  it('leaves out a binding still waiting in a chat, and one to a gadget not listed', () => {
    const [only] = setupsOf([spawner(4, 'A', [{ gadgetId: 7, name: 'A', chatId: 3 }, { gadgetId: 99, name: 'A' }, { gadgetId: 8, name: 'A' }])], gadgets)
    expect(only.gadgets.map(({ id }) => id)).toEqual([8])
  })

  it('says each gadget once, though it knows the agent by two names', () => {
    const [only] = setupsOf([spawner(4, 'A', [{ gadgetId: 7, name: 'A' }, { gadgetId: 7, name: 'B' }, { gadgetId: 8, name: 'A' }])], gadgets)
    expect(gadgetTitles(gadgetsOf(only))).toBe('Inbox and Triage')
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

  it('joins runs by their spawner, whatever name they were started under, and two agents of one name stay apart', () => {
    const agents = agentsOf([
      chat(1, 5, { spawnerId: 4, spawnerName: 'Helper' }),
      chat(2, 4, { spawnerId: 6, spawnerName: 'Helper' }),
      chat(3, 3, { spawnerId: 4, spawnerName: 'Old name' }),
    ])
    expect(agents.map(({ key, name, runs }) => [key, name, runs.map(({ chatId }) => chatId)])).toEqual([['4', 'Helper', [1, 3]], ['6', 'Helper', [2]]])
  })

  it('joins a run that names no spawner to no agent, even one of its name', () => {
    const agents = agentsOf([chat(1, 5, { spawnerId: 4, spawnerName: 'Helper' }), chat(2, 1, { spawnerName: 'Helper' })], signals(), [setup(4, 'Helper')])
    expect(agents.map(({ key, runs }) => [key, runs.map(({ chatId }) => chatId)])).toEqual([['4', [1]]])
  })

  it('takes what an agent is from how it was set up, and lists one that has not run after those that have', () => {
    const helper = setup(4, 'Inbox helper', { model: 'Sonnet', gadgets: [{ id: 7, title: 'Inbox', bindingName: 'HELPER' }] })
    const [found, idle] = agentsOf([chat(1, 5, { spawnerId: 4, spawnerName: 'Old name' })], signals(), [helper, setup(9, 'Idle')])
    expect(found).toMatchObject({ key: '4', name: 'Inbox helper', model: 'Sonnet', gadgets: helper.gadgets, runs: [{ chatId: 1 }] })
    expect(idle).toMatchObject({ key: '9', runs: [] })
    expect(runsWords(idle, true)).toBe('Hasn’t run yet')
    expect(runsWords(idle, false)).toBe('No recent runs')
  })

  it('counts what waits and what works, says a latest run failed, and puts those that want a person first', () => {
    const agents = agentsOf([
      chat(1, 30, { spawnerId: 1, spawnerName: 'Busy' }),
      chat(2, 20, { spawnerId: 2, spawnerName: 'Waiting', awaitingDecision: true }),
      chat(3, 19, { spawnerId: 2, spawnerName: 'Waiting' }),
      chat(4, 10, { spawnerId: 3, spawnerName: 'Failed', lastTurnFailed: true }),
      chat(5, 25, { spawnerId: 4, spawnerName: 'Recovered' }),
      chat(6, 24, { spawnerId: 4, spawnerName: 'Recovered', lastTurnFailed: true }),
    ], signals([3]))
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

  it('says how many runs there were and when the latest was, or at least how many where not all were read', () => {
    const [one] = agentsOf([chat(1, 0, { spawnerId: 1 })])
    expect(runsWords(one, true, at(0))).toBe('One run · latest just now')
    expect(runsWords(one, false, at(0))).toBe('At least one run · latest just now')
    const [many] = agentsOf([chat(1, 0, { spawnerId: 1 }), chat(2, 0, { spawnerId: 1 })])
    expect(runsWords(many, true, new Date(at(0).getTime() + 2 * 3_600_000))).toBe('2 runs · latest 2 hours ago')
    expect(runsWords(many, false, new Date(at(0).getTime() + 2 * 3_600_000))).toBe('At least 2 runs · latest 2 hours ago')
  })
})

const agentRun = (chatId: number, title: string, status: AgentRun['status']): AgentRun => ({ chatId, title, status, started: at(chatId), lastActive: at(chatId) })

describe('the runs an agent page lists', () => {
  const runs = [agentRun(6, 'Digest', 'failed'), agentRun(5, 'Digest', 'done'), agentRun(4, 'Digest', 'done'), agentRun(3, 'Other', 'waiting'), agentRun(2, 'Digest', 'done'), agentRun(1, 'Digest', 'changes')]

  it('folds the runs after one that finished the same way, with the same title, under it', () => {
    expect(foldRuns(runs).map(({ run: { chatId }, folded }) => [chatId, folded.map(({ chatId: id }) => id)])).toEqual([[6, []], [5, [4]], [3, []], [2, []], [1, []]])
  })

  it('keeps for each filter what it says, and counts them', () => {
    expect(runsMatching(runs, 'attention').map(({ chatId }) => chatId)).toEqual([6, 3])
    expect(runsMatching(runs, 'failed').map(({ chatId }) => chatId)).toEqual([6])
    expect(runFilterCounts(runs)).toEqual({ all: 6, attention: 2, failed: 1, changes: 1 })
  })
})
