import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatMetadata, ChatListOptions } from '@gadgets/workshop-shared/api'
import { WorkspaceChats, type ChatsOverseer } from './WorkspaceChats'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Chat ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata

const fake = (chats: AiChatMetadata[]) => {
  const events: { chat?: { metadata(chat: AiChatMetadata): void; deleted(id: number): void } } = {}
  const calls: string[] = []
  const listChats = vi.fn<(options?: ChatListOptions) => Promise<AiChatMetadata[]>>(async () => {
    calls.push('list')
    return chats
  })
  const disposed: string[] = []
  const broken: { callback?: (error: unknown) => void } = {}
  const overseer = {
    subscribeToChat: (subscriber: never) => {
      calls.push('subscribe')
      events.chat = subscriber
      return Promise.resolve({ [Symbol.dispose]: () => void disposed.push('lease') })
    },
    listChats,
    onRpcBroken: (callback: (error: unknown) => void) => {
      broken.callback = callback
    },
    [Symbol.dispose]: () => void disposed.push('overseer'),
  }
  return { overseer: overseer as unknown as ChatsOverseer, events, listChats, calls, disposed, broken }
}

const listed = (chats: WorkspaceChats) => {
  const snapshot = chats.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`not ready: ${snapshot.status}`)
  return snapshot.chats.map(({ id, title }) => [id, title])
}

describe('WorkspaceChats', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes, then reads people’s chats once, most recently active first', async () => {
    const { overseer, listChats, calls } = fake([chat(1, 5), chat(2, 9)])
    const chats = new WorkspaceChats(() => overseer)
    chats.start()
    await vi.waitFor(() => expect(listed(chats)).toEqual([[2, 'Chat 2'], [1, 'Chat 1']]))
    expect(calls).toEqual(['subscribe', 'list'])
    expect(listChats).toHaveBeenCalledWith({ kind: 'chats' })
  })

  it('takes in a new chat and a new title as they come, leaves one deleted out, and never takes in a run', async () => {
    const { overseer, events } = fake([chat(1, 5), chat(2, 9)])
    const chats = new WorkspaceChats(() => overseer)
    chats.start()
    // Before the read, applied over it.
    events.chat!.metadata(chat(3, 10))
    await vi.waitFor(() => expect(listed(chats)).toEqual([[3, 'Chat 3'], [2, 'Chat 2'], [1, 'Chat 1']]))

    events.chat!.metadata(chat(1, 12, { title: 'Plans', totalCost: 0.4 }))
    events.chat!.metadata(chat(4, 13, { spawnerId: 40 }))
    events.chat!.metadata(chat(5, 14, { spawnerName: 'Helper' }))
    events.chat!.deleted(2)
    expect(listed(chats)).toEqual([[1, 'Plans'], [3, 'Chat 3']])
  })

  it('says why it could not read them', async () => {
    const { overseer, listChats } = fake([])
    listChats.mockRejectedValueOnce(new Error('Not available in use-only sessions'))
    const chats = new WorkspaceChats(() => overseer)
    chats.start()
    await vi.waitFor(() => expect(chats.getSnapshot()).toEqual({ status: 'failed', message: 'Not available in use-only sessions' }))
  })

  it('after the workspace restarts, keeps what is shown, then opens it again and reads them anew, live', async () => {
    vi.useFakeTimers()
    const first = fake([chat(1, 5)])
    const second = fake([chat(1, 5), chat(2, 9)])
    const open = vi.fn<() => ChatsOverseer>().mockReturnValueOnce(first.overseer).mockReturnValueOnce(second.overseer)
    const chats = new WorkspaceChats(open)
    chats.start()
    await vi.waitFor(() => expect(listed(chats)).toEqual([[1, 'Chat 1']]))

    first.broken.callback!(new Error('restarted'))
    expect(listed(chats)).toEqual([[1, 'Chat 1']])
    expect(open).toHaveBeenCalledTimes(1)

    await vi.runAllTimersAsync()
    expect(open).toHaveBeenCalledTimes(2)
    expect(first.disposed.toSorted()).toEqual(['lease', 'overseer'])
    expect(listed(chats)).toEqual([[2, 'Chat 2'], [1, 'Chat 1']])
    expect(second.calls).toEqual(['subscribe', 'list'])

    second.events.chat!.metadata(chat(3, 10))
    expect(listed(chats)).toEqual([[3, 'Chat 3'], [2, 'Chat 2'], [1, 'Chat 1']])
    // The old subscription is stale.
    first.events.chat!.metadata(chat(4, 11))
    expect(listed(chats)).toHaveLength(3)

    chats.stop()
    await vi.runAllTimersAsync()
    expect(second.disposed.toSorted()).toEqual(['lease', 'overseer'])
    second.broken.callback!(new Error('restarted'))
    await vi.runAllTimersAsync()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('opens nothing again when stopped while it waits to', async () => {
    vi.useFakeTimers()
    const { overseer, broken, disposed } = fake([chat(1, 5)])
    const open = vi.fn<() => ChatsOverseer>(() => overseer)
    const chats = new WorkspaceChats(open)
    chats.start()
    await vi.waitFor(() => expect(listed(chats)).toEqual([[1, 'Chat 1']]))
    broken.callback!(new Error('restarted'))
    chats.stop()
    await vi.runAllTimersAsync()
    expect(open).toHaveBeenCalledTimes(1)
    expect(disposed.toSorted()).toEqual(['lease', 'overseer'])
    expect(listed(chats)).toEqual([[1, 'Chat 1']])
  })
})
