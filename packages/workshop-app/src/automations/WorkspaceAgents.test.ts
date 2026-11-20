import { describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry, AgentSpawnerInfo, AiChatMessage, AiChatMetadata, ChatListOptions, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { RUNS_READ, WorkspaceAgents, type AgentsOverseer } from './WorkspaceAgents'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata
const spawner = (id: number, displayName: string, bindings: AgentSpawnerInfo['bindings'] = [], more: Partial<AgentSpawnerInfo> = {}): AgentSpawnerInfo =>
  ({ id, config: { displayName, modelId: 'm' }, bindings, ...more })

type Fake = {
  runs: AiChatMetadata[]
  pending?: ActionLogEntry[]
  gadgets?: WorkpieceSummary[]
  spawners?: AgentSpawnerInfo[]
}

const fake = ({ runs, pending = [], gadgets = [], spawners = [] }: Fake) => {
  const events: {
    chat?: { metadata(chat: AiChatMetadata): void; message(message: AiChatMessage): void; deleted(id: number): void }
    actions?: { entry(record: ActionLogEntry): void }
    workpieces?: { entry(summary: WorkpieceSummary): void; removed(id: number): void; ready(): void }
  } = {}
  const lease = Promise.resolve({ [Symbol.dispose]: () => {} })
  const listChats = vi.fn<(options?: ChatListOptions) => Promise<AiChatMetadata[]>>(async () => runs)
  const listAgentSpawners = vi.fn<() => Promise<AgentSpawnerInfo[]>>(async () => spawners)
  const overseer = {
    subscribeToChat: (subscriber: never) => {
      events.chat = subscriber
      return lease
    },
    subscribeToActions: (subscriber: never) => {
      events.actions = subscriber
      return lease
    },
    subscribeToWorkpieces: (subscriber: NonNullable<typeof events.workpieces>) => {
      events.workpieces = subscriber
      for (const gadget of gadgets) subscriber.entry(gadget)
      subscriber.ready()
      return lease
    },
    listChats,
    listAgentSpawners,
    listActions: async () => ({ entries: pending }),
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  }
  return { overseer: overseer as unknown as AgentsOverseer, events, listChats, listAgentSpawners }
}

const ready = (agents: WorkspaceAgents) => {
  const snapshot = agents.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`not ready: ${snapshot.status}`)
  return snapshot
}

describe('WorkspaceAgents', () => {
  it('reads the latest runs alone, and an agent for each spawner, with every gadget bound to it', async () => {
    const { overseer, listChats } = fake({
      runs: [chat(1, 5, { spawnerId: 40, spawnerName: 'Old name' })],
      gadgets: [{ id: 7, type: 'gadget', title: 'Inbox', commitId: 'c' }, { id: 8, type: 'gadget', title: 'Triage', commitId: 'c' }],
      spawners: [
        spawner(40, 'Inbox helper', [{ gadgetId: 7, name: 'HELPER' }, { gadgetId: 8, name: 'HELPER' }], { modelName: 'Sonnet' }),
        spawner(41, 'Idle', [{ gadgetId: 7, name: 'IDLE' }]),
      ],
    })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).setUpRead).toBe(true))
    expect(listChats).toHaveBeenCalledWith({ kind: 'runs', limit: RUNS_READ })
    expect(ready(agents).allRuns).toBe(true)
    expect(ready(agents).agents.map(({ key, name, model, gadgets, runs }) => [key, name, model, gadgets.map(({ title }) => title), runs.map(({ chatId }) => chatId)])).toEqual([
      ['40', 'Inbox helper', 'Sonnet', ['Inbox', 'Triage'], [1]],
      ['41', 'Idle', undefined, ['Inbox'], []],
    ])
  })

  it('says when a full page of runs was read, as there may be more', async () => {
    const { overseer } = fake({ runs: Array.from({ length: RUNS_READ }, (_, index) => chat(index + 1, index, { spawnerId: 40 })) })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).allRuns).toBe(false))
  })

  it('names an agent only runs know by its latest run, and joins a run that names no spawner to none', async () => {
    const { overseer } = fake({ runs: [chat(1, 5, { spawnerId: 40, spawnerName: 'Renamed' }), chat(2, 4, { spawnerId: 40, spawnerName: 'Old' }), chat(3, 6, { spawnerName: 'Renamed' })] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).setUpRead).toBe(true))
    expect(ready(agents).agents.map(({ key, name, gadgets, runs }) => [key, name, gadgets, runs.length])).toEqual([['40', 'Renamed', [], 2]])
  })

  it('reads the spawners again as the workpieces change, one read at a time', async () => {
    const { overseer, events, listAgentSpawners } = fake({ runs: [], gadgets: [{ id: 7, type: 'gadget', title: 'Inbox', commitId: 'c' }], spawners: [spawner(40, 'Helper', [{ gadgetId: 7, name: 'HELPER' }])] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).setUpRead).toBe(true))
    expect(listAgentSpawners).toHaveBeenCalledTimes(1)
    events.workpieces!.entry({ id: 7, type: 'gadget', title: 'Mail', commitId: 'd' })
    // The new title shows at once.
    expect(ready(agents).agents[0].gadgets[0].title).toBe('Mail')
    events.workpieces!.entry({ id: 7, type: 'gadget', title: 'Mail', commitId: 'e' })
    await vi.waitFor(() => expect(listAgentSpawners).toHaveBeenCalledTimes(3))
    events.workpieces!.removed(7)
    expect(ready(agents).agents[0].gadgets).toEqual([])
  })

  it('says a run waits on an action of its own, as listed and as it changes', async () => {
    const pending = { id: 3, chatId: 1, state: 'pending', type: 'action' } as ActionLogEntry
    const { overseer, events } = fake({ runs: [chat(1, 5, { spawnerId: 40 })], pending: [pending] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents[0].runs[0].status).toBe('waiting'))
    expect([...ready(agents).actionsWaiting]).toEqual([1])
    events.actions!.entry({ ...pending, state: 'approved' })
    expect(ready(agents).agents[0].runs[0].status).toBe('done')
    expect([...ready(agents).actionsWaiting]).toEqual([])
  })

  it('says which chats have an action waiting, a person’s as much as a run, and takes no person’s chat in', async () => {
    const pending = { id: 3, chatId: 2, state: 'pending', type: 'action' } as ActionLogEntry
    const { overseer, events } = fake({ runs: [chat(1, 5, { spawnerId: 40 })], pending: [pending] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect([...ready(agents).actionsWaiting]).toEqual([2]))
    events.chat!.metadata(chat(2, 9, { awaitingDecision: true }))
    expect(ready(agents).agents.flatMap(({ runs }) => runs.map(({ chatId }) => chatId))).toEqual([1])
  })

  it('finds the run an action that does not say its chat was made from, by the run’s message that names it', async () => {
    const pending = { id: 3, state: 'pending', type: 'action' } as ActionLogEntry
    const named = { chatId: 1, sequence: 4, timestamp: at(0), author: { type: 'agent', id: 'm', name: 'M' }, type: 'action', actionId: 3 } as AiChatMessage
    const { overseer, events } = fake({ runs: [chat(1, 5, { spawnerId: 40 }), chat(2, 4, { spawnerId: 40 })], pending: [pending] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents).toHaveLength(1))
    events.chat!.message(named)
    expect(ready(agents).agents[0].runs.map(({ status }) => status)).toEqual(['waiting', 'done'])
  })

  it('says a run whose last turn failed failed, as the run says and as that changes', async () => {
    const { overseer, events } = fake({
      runs: [chat(1, 5, { spawnerId: 40, lastTurnFailed: true }), chat(2, 4, { spawnerId: 40 }), chat(3, 3, { spawnerId: 41 })],
    })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents[0].failed).toBe(true))
    expect(ready(agents).agents[0].runs.map(({ status }) => status)).toEqual(['failed', 'done'])

    events.chat!.metadata(chat(1, 6, { spawnerId: 40, activeAgent: { type: 'agent', id: 'm', name: 'M' } }))
    expect(ready(agents).agents.find(({ key }) => key === '40')!.runs[0].status).toBe('running')
    events.chat!.metadata(chat(3, 7, { spawnerId: 41, lastTurnFailed: true }))
    expect(ready(agents).agents.find(({ key }) => key === '41')!.failed).toBe(true)
  })

  it('takes in runs as they start, and those that came before the list, and leaves out those deleted', async () => {
    const { overseer, events } = fake({ runs: [chat(1, 5, { spawnerId: 40 })] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    events.chat!.metadata(chat(4, 3, { spawnerId: 40 }))
    await vi.waitFor(() => expect(ready(agents).agents).toHaveLength(1))
    expect(ready(agents).agents[0].runs.map(({ chatId }) => chatId)).toEqual([1, 4])
    events.chat!.metadata(chat(2, 8, { spawnerId: 40, awaitingDecision: true }))
    expect(ready(agents).agents[0]).toMatchObject({ waiting: 1, runs: [{ chatId: 2 }, { chatId: 1 }, { chatId: 4 }] })
    events.chat!.metadata(chat(3, 9))
    events.chat!.deleted(1)
    expect(ready(agents).agents[0].runs.map(({ chatId }) => chatId)).toEqual([2, 4])
  })

  it('says why it could not read them', async () => {
    const { overseer } = fake({ runs: [] })
    overseer.listChats = async () => {
      throw new Error('Unreachable')
    }
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(agents.getSnapshot()).toEqual({ status: 'failed', message: 'Unreachable' }))
  })
})
