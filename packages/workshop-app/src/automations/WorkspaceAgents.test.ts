import { describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry, AiChatMessage, AiChatMetadata, GadgetBindingInfo, GatekeeperCreationSpec, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { WorkspaceAgents, type AgentsOverseer } from './WorkspaceAgents'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata
const error = (chatId: number, code?: string) =>
  ({ chatId, sequence: 9, timestamp: at(0), author: { type: 'agent', id: 'm', name: 'M' }, type: 'error', message: 'Boom', ...(code ? { code } : {}) }) as AiChatMessage
const spawner = (displayName: string, modelName?: string): GatekeeperCreationSpec =>
  ({ type: 'agentSpawner', config: { displayName, modelId: 'm' }, ...(modelName ? { modelName } : {}) }) as GatekeeperCreationSpec

type Fake = {
  chats: AiChatMetadata[]
  pending?: ActionLogEntry[]
  tails?: Record<number, AiChatMessage[]>
  gadgets?: WorkpieceSummary[]
  bindings?: Record<number, GadgetBindingInfo[]>
  specs?: Record<number, GatekeeperCreationSpec>
}

const fake = ({ chats, pending = [], tails = {}, gadgets = [], bindings = {}, specs = {} }: Fake) => {
  const events: {
    chat?: { metadata(chat: AiChatMetadata): void; message(message: AiChatMessage): void; deleted(id: number): void }
    actions?: { entry(record: ActionLogEntry): void }
  } = {}
  const lease = Promise.resolve({ [Symbol.dispose]: () => {} })
  const overseer = {
    subscribeToChat: (subscriber: never) => {
      events.chat = subscriber
      return lease
    },
    subscribeToActions: (subscriber: never) => {
      events.actions = subscriber
      return lease
    },
    subscribeToWorkpieces: (subscriber: { entry(summary: WorkpieceSummary): void; ready(): void }) => {
      for (const gadget of gadgets) subscriber.entry(gadget)
      subscriber.ready()
      return lease
    },
    listChats: async () => chats,
    listActions: async () => ({ entries: pending }),
    getChatHistory: async (chatId: number) => ({ messages: tails[chatId] ?? [] }),
    getGadget: (id: number) => ({ listBindings: async () => bindings[id] ?? [], [Symbol.dispose]: () => {} }),
    getGatekeeperById: (id: number) => ({
      getCreationSpec: async () => {
        if (!specs[id]) throw new Error('gone')
        return specs[id]
      },
      [Symbol.dispose]: () => {},
    }),
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  }
  return { overseer: overseer as unknown as AgentsOverseer, events }
}

const ready = (agents: WorkspaceAgents) => {
  const snapshot = agents.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`not ready: ${snapshot.status}`)
  return snapshot
}

describe('WorkspaceAgents', () => {
  it('lists the agents’ runs and not people’s chats, each agent set up as its gadget says', async () => {
    const { overseer } = fake({
      chats: [chat(1, 5, { spawnerId: 40, spawnerName: 'Old name' }), chat(2, 9)],
      gadgets: [{ id: 7, type: 'gadget', title: 'Inbox', commitId: 'c' }],
      bindings: { 7: [{ name: 'HELPER', target: 40, resourceTitle: 'Helper' }, { name: 'MAIL', target: 50, resourceTitle: 'Mail', vendorId: 'google' }, { name: 'IDLE', target: 41, resourceTitle: 'Idle' }] },
      specs: { 40: spawner('Inbox helper', 'Sonnet'), 41: spawner('Idle') },
    })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).setUpRead).toBe(true))
    expect(ready(agents).agents.map(({ key, name, model, gadget, runs }) => [key, name, model, gadget?.title, runs.map(({ chatId }) => chatId)])).toEqual([
      ['40', 'Inbox helper', 'Sonnet', 'Inbox', [1]],
      ['41', 'Idle', undefined, 'Inbox', []],
    ])
  })

  it('names an agent no gadget starts any more as it was made', async () => {
    const { overseer } = fake({ chats: [chat(1, 5, { spawnerId: 40, spawnerName: 'Old name' })], specs: { 40: spawner('Renamed') } })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents[0].name).toBe('Renamed'))
    expect(ready(agents).agents[0].gadget).toBeUndefined()
  })

  it('says a run waits on an action of its own, as listed and as it changes', async () => {
    const pending = { id: 3, chatId: 1, state: 'pending', type: 'action' } as ActionLogEntry
    const { overseer, events } = fake({ chats: [chat(1, 5, { spawnerId: 40 })], pending: [pending] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents[0].runs[0].status).toBe('waiting'))
    events.actions!.entry({ ...pending, state: 'approved' })
    expect(ready(agents).agents[0].runs[0].status).toBe('done')
  })

  it('finds the run an action that does not say its chat was made from, by the run’s messages', async () => {
    const pending = { id: 3, state: 'pending', type: 'action' } as ActionLogEntry
    const named = { chatId: 1, sequence: 4, timestamp: at(0), author: { type: 'agent', id: 'm', name: 'M' }, type: 'action', actionId: 3 } as AiChatMessage
    const { overseer } = fake({ chats: [chat(1, 5, { spawnerId: 40 }), chat(2, 4, { spawnerId: 40 })], pending: [pending], tails: { 1: [named] } })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents[0].runs.map(({ status }) => status)).toEqual(['waiting', 'done']))
  })

  it('says the latest runs that ended on an error failed, and that a run that goes on has not', async () => {
    const { overseer, events } = fake({
      chats: [chat(1, 5, { spawnerId: 40 }), chat(2, 4, { spawnerId: 40 }), chat(3, 3, { spawnerId: 41 })],
      tails: { 1: [error(1)], 2: [error(2, 'stopped')] },
    })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents[0].failed).toBe(true))
    expect(ready(agents).agents[0].runs.map(({ status }) => status)).toEqual(['failed', 'done'])

    events.chat!.metadata(chat(1, 6, { spawnerId: 40, activeAgent: { type: 'agent', id: 'm', name: 'M' } }))
    expect(ready(agents).agents.find(({ key }) => key === '40')!.runs[0].status).toBe('running')
    events.chat!.message(error(3))
    expect(ready(agents).agents.find(({ key }) => key === '41')!.failed).toBe(true)
  })

  it('takes in runs as they start and leaves out those deleted', async () => {
    const { overseer, events } = fake({ chats: [chat(1, 5, { spawnerId: 40 })] })
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(ready(agents).agents).toHaveLength(1))
    events.chat!.metadata(chat(2, 8, { spawnerId: 40, awaitingDecision: true }))
    expect(ready(agents).agents[0]).toMatchObject({ waiting: 1, runs: [{ chatId: 2 }, { chatId: 1 }] })
    events.chat!.metadata(chat(3, 9))
    events.chat!.deleted(1)
    expect(ready(agents).agents[0].runs.map(({ chatId }) => chatId)).toEqual([2])
  })

  it('says why it could not read them', async () => {
    const { overseer } = fake({ chats: [] })
    overseer.listChats = async () => {
      throw new Error('Unreachable')
    }
    const agents = new WorkspaceAgents(() => overseer)
    agents.start()
    await vi.waitFor(() => expect(agents.getSnapshot()).toEqual({ status: 'failed', message: 'Unreachable' }))
  })
})
