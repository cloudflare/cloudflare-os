import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceMetadataWithTimestamps, WorkspacesSubscriber } from '@gadgets/workshop-shared/api'
import { WorkspacesFeed, type ListBackend } from './WorkspacesFeed'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const workspace = (id: string, lastActive: number, change: Partial<WorkspaceMetadataWithTimestamps> = {}): WorkspaceMetadataWithTimestamps => ({
  id,
  title: id.toUpperCase(),
  created: new Date(0),
  lastActive: new Date(lastActive),
  ...change,
})

const shown = (list: WorkspacesFeed) => {
  const state = list.getSnapshot()
  return state.status === 'ready' ? state.workspaces : []
}

/** The list, started, and what a test needs to act as the server: the listener it was given last. */
const started = (subscribe = vi.fn<ListBackend['subscribe']>(async () => ({ [Symbol.dispose]: () => {} }))) => {
  const list = new WorkspacesFeed()
  list.start({ subscribe })
  return { list, subscribe, server: () => subscribe.mock.lastCall![0] as unknown as WorkspacesSubscriber & Disposable }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkspacesFeed', () => {
  it('is loading until the account has said, then keeps up one workspace at a time, the latest active first', async () => {
    const { list, server } = started()
    // Before the snapshot, a change has nothing to change.
    await server().updated('a', workspace('a', 1))
    expect(list.getSnapshot()).toEqual({ status: 'loading' })

    await server().snapshot([workspace('a', 1), workspace('b', 2)])
    expect(shown(list).map(({ id }) => id)).toEqual(['b', 'a'])

    await server().updated('a', workspace('a', 3, { title: 'Renamed' }))
    await server().updated('c', workspace('c', 0))
    await server().updated('b', null)
    expect(shown(list).map(({ id, title }) => [id, title])).toEqual([['a', 'Renamed'], ['c', 'C']])
  })

  it('shows a change made here at once, until the account says otherwise', async () => {
    const { list, server } = started()
    await server().snapshot([workspace('a', 1)])

    list.mark('a', { pinned: true, title: 'Renamed' })
    list.mark('unknown', { pinned: true })
    expect(shown(list)).toMatchObject([{ id: 'a', pinned: true, title: 'Renamed' }])

    await server().updated('a', workspace('a', 1, { pinned: false }))
    expect(shown(list)).toMatchObject([{ id: 'a', pinned: false, title: 'A' }])
  })

  it('lays what the open workspace says of itself over its row, whatever the account says of it since', async () => {
    const { list, server } = started()
    await server().snapshot([workspace('a', 1)])
    const listener = vi.fn<() => void>()
    list.subscribe(listener)

    list.live('a', { containsRestrictedData: true, totalCost: 2 })
    await server().updated('a', workspace('a', 2, { title: 'Renamed' }))
    expect(shown(list)).toMatchObject([{ title: 'Renamed', containsRestrictedData: true, totalCost: 2 }])

    // Said again unchanged, it changes nothing.
    listener.mockClear()
    list.live('a', { containsRestrictedData: true, totalCost: 2 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('says why it could not be read until it is, trying again with growing waits', async () => {
    vi.useFakeTimers()
    const subscribe = vi.fn<ListBackend['subscribe']>(async () => {
      throw new Error('offline')
    })
    const { list } = started(subscribe)
    await flush()
    expect(list.getSnapshot()).toEqual({ status: 'failed', message: 'offline' })

    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(3)
  })

  it('subscribes again once the account forgets it, or on a new connection, keeping the list meanwhile', async () => {
    const { list, server, subscribe } = started()
    await flush()
    await server().snapshot([workspace('a', 1)])
    server()[Symbol.dispose]()
    expect(subscribe).toHaveBeenCalledTimes(2)

    list.stop()
    list.start({ subscribe })
    expect(subscribe).toHaveBeenCalledTimes(3)
    expect(shown(list).map(({ id }) => id)).toEqual(['a'])
  })
})
