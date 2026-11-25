import { describe, expect, it, vi } from 'vitest'
import type { OutputSummary, OutputsSubscriber } from '@gadgets/workshop-shared/api'
import { OutputsFeed, type OutputsBackend } from './OutputsFeed'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const output = (workspaceId: string, workpieceId: number, lastActive = 0, title = `Output ${workpieceId}`): OutputSummary => ({
  workspaceId,
  workpieceId,
  title,
  workspaceTitle: 'Workspace',
  created: new Date(0),
  lastActive: new Date(lastActive),
})

/** A connection and the listener it was given last. */
const connection = (subscribed: () => Promise<Disposable> = () => Promise.resolve({ [Symbol.dispose]: () => {} })) => {
  const listeners: (OutputsSubscriber & Disposable)[] = []
  const backend = {
    subscribe: vi.fn<OutputsBackend['subscribe']>((given) => {
      listeners.push(given as unknown as OutputsSubscriber & Disposable)
      return subscribed()
    }),
  }
  return { backend, server: () => listeners.at(-1)! }
}

const started = (subscribed?: () => Promise<Disposable>) => {
  const first = connection(subscribed)
  const feed = new OutputsFeed()
  feed.start(first.backend)
  return { feed, ...first }
}

describe('OutputsFeed', () => {
  it('loads from the snapshot, then replaces one workspace’s outputs at a time, latest active first', async () => {
    const { feed, server } = started()
    await server().updated('a', [output('a', 1)])
    expect(feed.getSnapshot().library).toEqual({ status: 'loading' })

    await server().snapshot([output('a', 1, 1), output('b', 2, 2)], true)
    await server().updated('a', [output('a', 1, 3, 'Renamed')])
    await server().updated('b', [])
    expect(feed.getSnapshot()).toMatchObject({ catchingUp: true, library: { status: 'ready', outputs: [{ workspaceId: 'a', title: 'Renamed' }] } })
  })

  it('shows a failure while nothing is known, whose retry subscribes again', async () => {
    vi.useFakeTimers()
    const { feed, backend } = started(() => Promise.reject(new Error('Offline')))
    await flush()
    const { library } = feed.getSnapshot()
    expect(library).toMatchObject({ status: 'failed', message: 'Offline' })
    if (library.status === 'failed') library.retry()
    expect(backend.subscribe).toHaveBeenCalledTimes(2)
    feed.stop()
    vi.useRealTimers()
  })

  it('subscribes again once the account forgets it, keeping what was known meanwhile', async () => {
    const { feed, server, backend } = started()
    await flush()
    await server().snapshot([output('a', 1)], false)
    server()[Symbol.dispose]()
    expect(backend.subscribe).toHaveBeenCalledTimes(2)
    expect(feed.getSnapshot().library.status).toBe('ready')
  })

  it('keeps the last account snapshot through a disconnect and replaces it on the new connection', async () => {
    const dispose = vi.fn<() => void>()
    const first = started(async () => ({ [Symbol.dispose]: dispose }))
    const next = connection()
    const { feed } = first
    const oldOutput = output('a', 1)
    const newOutput = output('b', 2)
    await first.server().snapshot([oldOutput], true)
    const committed = feed.getSnapshot()

    feed.stop()
    await flush()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(feed.getSnapshot()).toBe(committed)

    feed.start(next.backend)
    await first.server().snapshot([], false)
    await first.server().updated('a', [])
    first.server()[Symbol.dispose]()
    await next.server().updated('a', [])
    expect(first.backend.subscribe).toHaveBeenCalledTimes(1)
    expect(next.backend.subscribe).toHaveBeenCalledTimes(1)
    expect(feed.getSnapshot()).toBe(committed)

    await next.server().snapshot([newOutput], false)
    expect(feed.getSnapshot()).toEqual({ library: { status: 'ready', outputs: [newOutput] }, catchingUp: false })
    feed.stop()
  })
})
