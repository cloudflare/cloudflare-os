import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionsSubscriber } from '@gadgets/workshop-shared/api'
import { GadgetRequests, HOLD_MS, type GadgetRequest, type RequestsOverseer } from './GadgetRequests'

const request = (id: number, state: GadgetRequest['state'] = 'pending') =>
  ({ id, type: 'action', gadgetId: 7, gatekeeperId: 3, state, createdAt: new Date(), description: { title: 'Append' } }) as GadgetRequest

// One an agent made, in its own chat.
const fromChat = (id: number, chatId: number) => ({ ...request(id), gadgetId: undefined, chatId }) as GadgetRequest

const lease = async () => ({ [Symbol.dispose]: () => {} })

type Chat = Awaited<ReturnType<RequestsOverseer['listChats']>>[number]

const fakeWorkspace = (listed: GadgetRequest[] = [], chats: Chat[] = []) => {
  let actions: ActionsSubscriber | undefined
  const overseer: RequestsOverseer = {
    getGadget: () => ({ allowActionKind: async () => {}, listBindings: async () => [], [Symbol.dispose]: () => {} }),
    subscribeToWorkpieces: lease,
    subscribeToActions: async (given) => {
      actions = given
      return lease()
    },
    listActions: async () => ({ entries: listed }),
    listChats: async () => chats,
    approveAction: async () => {},
    rejectAction: async () => {},
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  }
  return { overseer, chats, subscribed: () => actions !== undefined, send: (entry: GadgetRequest) => actions!.entry(entry) }
}

describe('GadgetRequests', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows what was waiting when it opened at once', async () => {
    const { overseer } = fakeWorkspace([request(1)])
    const requests = new GadgetRequests(() => overseer, 7)
    requests.start()
    await vi.waitFor(() => expect(requests.getSnapshot().waiting.map(({ id }) => id)).toEqual([1]))
  })

  it('never shows one the server lets through at once, and shows one that waits a moment later', async () => {
    const { overseer, subscribed, send } = fakeWorkspace()
    const requests = new GadgetRequests(() => overseer, 7)
    requests.start()
    await vi.waitFor(() => expect(subscribed()).toBe(true))
    // Once it has read which chats are its agents'.
    await vi.advanceTimersByTimeAsync(0)

    send(request(2))
    send(request(3))
    expect(requests.getSnapshot().waiting).toEqual([])
    send(request(2, 'approved'))
    vi.advanceTimersByTime(HOLD_MS)
    expect(requests.getSnapshot().waiting.map(({ id }) => id)).toEqual([3])
  })

  it('asks for the agents its code started, even one started after it opened, and not for other chats', async () => {
    const { overseer, chats, subscribed, send } = fakeWorkspace(
      [fromChat(1, 10), fromChat(2, 11)],
      [{ id: 10, title: 'Joke 1', spawnerName: 'Joke writer', spawnedByGadgetId: 7 }, { id: 11, title: 'Asked' }],
    )
    const requests = new GadgetRequests(() => overseer, 7)
    requests.start()
    await vi.waitFor(() => expect(requests.getSnapshot().waiting.map(({ id }) => id)).toEqual([1]))
    expect(requests.getSnapshot().agents.get(10)?.name).toBe('Joke writer')
    await vi.waitFor(() => expect(subscribed()).toBe(true))

    // A click starts another: its chat is read once its first action arrives.
    chats.push({ id: 12, title: 'Joke 2', spawnerName: 'Joke writer', spawnedByGadgetId: 7 })
    send(fromChat(3, 12))
    send(fromChat(4, 11))
    await vi.waitFor(() => expect(requests.getSnapshot().agents.has(12)).toBe(true))
    vi.advanceTimersByTime(HOLD_MS)
    expect(requests.getSnapshot().waiting.map(({ id }) => id)).toEqual([1, 3])
  })
})
