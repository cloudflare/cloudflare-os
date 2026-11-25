import { describe, expect, it, vi } from 'vitest'
import type { AiChatMetadata, ChatListOptions } from '@gadgets/workshop-shared/api'
import { AgentRunList, FIRST_RUNS, MORE_RUNS, type AgentRunsOverseer } from './AgentRunList'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const run = (id: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(id), spawnerId: 40, ...more }) as AiChatMetadata

// The agent's runs, newest first by id, paged as the workspace pages them.
const fake = (runs: AiChatMetadata[]) => {
  const events: { chat?: { metadata(chat: AiChatMetadata): void; deleted(id: number): void } } = {}
  const calls: string[] = []
  const listChats = vi.fn<(options?: ChatListOptions) => Promise<AiChatMetadata[]>>(async ({ spawnerId, beforeId, limit } = {}) => {
    calls.push('list')
    const listed = runs.filter((chat) => chat.spawnerId === spawnerId && (beforeId === undefined || chat.id < beforeId)).toSorted((a, b) => b.id - a.id)
    return limit === undefined ? listed : listed.slice(0, limit)
  })
  const overseer = {
    subscribeToChat: (subscriber: never) => {
      calls.push('subscribe')
      events.chat = subscriber
      return Promise.resolve({ [Symbol.dispose]: () => {} })
    },
    listChats,
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  }
  return { overseer: overseer as unknown as AgentRunsOverseer, events, listChats, calls }
}

const ready = (list: AgentRunList) => {
  const snapshot = list.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`not ready: ${snapshot.status}`)
  return snapshot
}

const many = (count: number) => Array.from({ length: count }, (_, index) => run(index + 1))

describe('AgentRunList', () => {
  it('subscribes, then reads the first page of the agent’s runs alone', async () => {
    const { overseer, listChats, calls } = fake([...many(3), run(10, { spawnerId: 41 })])
    const list = new AgentRunList(() => overseer, 40)
    list.start()
    await vi.waitFor(() => expect(ready(list).runs.map(({ id }) => id)).toEqual([3, 2, 1]))
    expect(calls).toEqual(['subscribe', 'list'])
    expect(listChats).toHaveBeenCalledWith({ spawnerId: 40, limit: FIRST_RUNS })
    expect(ready(list).all).toBe(true)
  })

  it('reads older pages on demand, from the last id read, until a page comes short', async () => {
    const { overseer, listChats } = fake(many(FIRST_RUNS + MORE_RUNS + 10))
    const list = new AgentRunList(() => overseer, 40)
    list.start()
    await vi.waitFor(() => expect(ready(list).runs).toHaveLength(FIRST_RUNS))
    expect(ready(list).all).toBe(false)

    list.more()
    expect(ready(list).reading).toBe(true)
    // Asked again while reading, it reads nothing more.
    list.more()
    await vi.waitFor(() => expect(ready(list).runs).toHaveLength(FIRST_RUNS + MORE_RUNS))
    const lastOfFirst = MORE_RUNS + 10 + 1
    expect(listChats).toHaveBeenNthCalledWith(2, { spawnerId: 40, beforeId: lastOfFirst, limit: MORE_RUNS })
    expect(ready(list)).toMatchObject({ all: false, reading: false })

    list.more()
    await vi.waitFor(() => expect(ready(list).all).toBe(true))
    expect(ready(list).runs.map(({ id }) => id).at(-1)).toBe(1)
    expect(listChats).toHaveBeenCalledTimes(3)
    list.more()
    expect(listChats).toHaveBeenCalledTimes(3)
  })

  it('keeps up from the stream: its runs that start or change, and those deleted, whether before the read or after', async () => {
    const { overseer, events } = fake(many(2))
    const list = new AgentRunList(() => overseer, 40)
    list.start()
    events.chat!.metadata(run(7))
    events.chat!.deleted(1)
    await vi.waitFor(() => expect(ready(list).runs.map(({ id }) => id)).toEqual([7, 2]))

    events.chat!.metadata(run(8))
    events.chat!.metadata(run(9, { spawnerId: 41 }))
    events.chat!.metadata(run(10, { spawnerId: undefined, spawnerName: 'Helper' }))
    events.chat!.metadata({ ...run(2), title: 'Renamed' })
    events.chat!.deleted(7)
    expect(ready(list).runs.map(({ id, title }) => [id, title])).toEqual([[8, 'Run 8'], [2, 'Renamed']])
  })

  it('says why more could not be read, keeping what was', async () => {
    const { overseer, listChats } = fake(many(FIRST_RUNS + 5))
    const list = new AgentRunList(() => overseer, 40)
    list.start()
    await vi.waitFor(() => expect(ready(list).runs).toHaveLength(FIRST_RUNS))
    listChats.mockRejectedValueOnce(new Error('Unreachable'))
    list.more()
    await vi.waitFor(() => expect(ready(list)).toMatchObject({ reading: false, problem: 'Unreachable' }))
    expect(ready(list).runs).toHaveLength(FIRST_RUNS)
  })

  it('reads as many again on a new connection as were read', async () => {
    const first = fake(many(FIRST_RUNS + MORE_RUNS + 10))
    const second = fake(many(FIRST_RUNS + MORE_RUNS + 10))
    const open = vi.fn<() => AgentRunsOverseer>().mockReturnValueOnce(first.overseer).mockReturnValueOnce(second.overseer)
    const list = new AgentRunList(open, 40)
    list.start()
    await vi.waitFor(() => expect(ready(list).runs).toHaveLength(FIRST_RUNS))
    list.more()
    await vi.waitFor(() => expect(ready(list).runs).toHaveLength(FIRST_RUNS + MORE_RUNS))
    list.restart()
    expect(ready(list).runs).toHaveLength(FIRST_RUNS + MORE_RUNS)
    await vi.waitFor(() => expect(second.listChats).toHaveBeenCalledWith({ spawnerId: 40, limit: FIRST_RUNS + MORE_RUNS }))
  })

  it('says why it could not read them', async () => {
    const { overseer, listChats } = fake([])
    listChats.mockRejectedValueOnce(new Error('Unreachable'))
    const list = new AgentRunList(() => overseer, 40)
    list.start()
    await vi.waitFor(() => expect(list.getSnapshot()).toEqual({ status: 'failed', message: 'Unreachable' }))
  })
})
