/// <reference lib="es2024.promise" />

import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSummary, WorkspaceSummarySubscriber } from '@gadgets/workshop-shared/api'
import { gadgetAsks, totalGadgetAsks, WorkspaceSummaries, type SummariesBackend } from './WorkspaceSummaries'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const summary = (workspaceId: string, gadgets: Record<number, number> = {}, runs = 0): WorkspaceSummary => ({
  workspaceId,
  waiting: { runs, chats: 0, gadgets: Object.entries(gadgets).map(([gadgetId, actions]) => ({ gadgetId: Number(gadgetId), actions })) },
  waitingChats: [],
  workingChatIds: [],
  hooks: [],
})

/** A connection and the listener it was given last. */
const connection = (subscribed: () => Promise<Disposable> = () => Promise.resolve({ [Symbol.dispose]: () => {} })) => {
  const listeners: (WorkspaceSummarySubscriber & Disposable)[] = []
  const subscribe = vi.fn<SummariesBackend['subscribe']>((given) => {
    listeners.push(given as unknown as WorkspaceSummarySubscriber & Disposable)
    return subscribed()
  })
  return { subscribe, server: () => listeners.at(-1)! }
}

const started = () => {
  const first = connection()
  const store = new WorkspaceSummaries()
  store.start(first)
  return { store, ...first }
}

describe('WorkspaceSummaries', () => {
  it('knows nothing until the account has said, then replaces and drops one workspace at a time', async () => {
    const { store, server } = started()
    // Before the snapshot, a change has nothing to change.
    await server().updated('a', summary('a', { 1: 1 }))
    expect(store.getSnapshot()).toMatchObject({ known: false, workspaces: new Map() })

    await server().snapshot([summary('a', { 1: 2 }), summary('b')])
    await server().updated('b', summary('b', {}, 3))
    await server().updated('a', null)

    expect(store.getSnapshot()).toMatchObject({ known: true })
    expect([...store.getSnapshot().workspaces.keys()]).toEqual(['b'])
    expect(store.getSnapshot().workspaces.get('b')?.waiting.runs).toBe(3)
  })

  it('subscribes again once the account forgets it, keeping what was known meanwhile', async () => {
    const { store, server, subscribe } = started()
    await flush()
    await server().snapshot([summary('a')])
    server()[Symbol.dispose]()
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().workspaces.has('a')).toBe(true)
  })

  it('keeps summaries while reconnecting, ignores old callbacks, and disposes even a late lease', async () => {
    const pendingLease = Promise.withResolvers<Disposable>()
    const first = connection(() => pendingLease.promise)
    const nextDispose = vi.fn<() => void>()
    const next = connection(async () => ({ [Symbol.dispose]: nextDispose }))
    const store = new WorkspaceSummaries()
    store.start(first)
    const oldSummary = summary('a', { 1: 2 })
    const newSummary = summary('b', {}, 3)
    await first.server().snapshot([oldSummary])
    const previous = store.getSnapshot()

    store.stop()
    expect(store.getSnapshot()).toBe(previous)
    store.start(next)
    await first.server().snapshot([])
    await first.server().updated('a', null)
    first.server()[Symbol.dispose]()
    const dispose = vi.fn<() => void>()
    pendingLease.resolve({ [Symbol.dispose]: dispose })
    await next.server().updated('b', newSummary)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(first.subscribe).toHaveBeenCalledTimes(1)
    expect(next.subscribe).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe(previous)

    await next.server().snapshot([newSummary])
    const current = store.getSnapshot()
    expect(current).toMatchObject({ known: true })
    expect([...current.workspaces.values()]).toEqual([newSummary])
    store.stop()
    await flush()
    expect(nextDispose).toHaveBeenCalledTimes(1)
  })

  it('counts what each gadget asks, and every ask across workspaces once', async () => {
    const { store, server } = started()
    await server().snapshot([summary('a', { 1: 2, 2: 1 }), summary('b', { 1: 4 })])
    const snapshot = store.getSnapshot()
    expect(gadgetAsks(snapshot, 'a', 1)).toBe(2)
    expect(gadgetAsks(snapshot, 'b', 2)).toBe(0)
    expect(gadgetAsks(snapshot, 'c', 1)).toBe(0)
    expect(totalGadgetAsks(snapshot)).toBe(7)
  })
})
