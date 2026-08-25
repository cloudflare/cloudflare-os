// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { entry as pendingEntry, makeOverseer, makeTestRoot } from './action-test-harness'
import { useActionHistory } from './useActionHistory'
import type { HistoryViewFilter } from './useActionHistory'

// Most history fixtures are resolved records; use the harness `pendingEntry` for pending ones.
function entry(id: number, over: Partial<Record<string, unknown>> = {}): ActionLogEntry {
  return pendingEntry(id, {
    appliedAt: new Date(1700000000000 + id * 60_000),
    state: 'approved',
    ...over,
  })
}

type HookResult = ReturnType<typeof useActionHistory>

describe('useActionHistory', () => {
  const view = makeTestRoot()
  let latest: HookResult

  function Probe({ overseer, filter, active }: {
    overseer: RpcStub<Overseer> | null
    filter: HistoryViewFilter
    active: boolean
  }) {
    latest = useActionHistory(overseer, filter, active)
    return null
  }

  async function render(overseer: RpcStub<Overseer> | null, filter: HistoryViewFilter,
      active: boolean) {
    await view.render(<Probe overseer={overseer} filter={filter} active={active} />)
  }

  afterEach(() => view.cleanup())

  it('fetches nothing until activated, then loads the first page', async () => {
    const server = makeOverseer()
    await render(server.overseer, 'all', false)
    expect(server.listCalls).toEqual([])
    expect(latest.status).toBe('loading')
    expect(latest.hasMore).toBe(false)

    await render(server.overseer, 'all', true)
    expect(server.listCalls).toEqual([{ beforeId: undefined, filter: 'all' }])
    expect(latest.status).toBe('loading')

    await server.resolvePage({ entries: [entry(30), entry(20)], nextBeforeId: 10 })
    expect(latest.status).toBe('ready')
    expect(latest.entries.map(e => e.id)).toEqual([30, 20])
    expect(latest.hasMore).toBe(true)

    await render(server.overseer, 'all', false)
    await render(server.overseer, 'all', true)
    expect(server.listCalls).toHaveLength(1)
  })

  it('continues from the cursor, dedupes by id, and ignores blocked loads', async () => {
    const server = makeOverseer()
    await render(server.overseer, 'all', true)

    act(() => latest.loadMore())
    expect(server.listCalls).toHaveLength(1)

    await server.resolvePage({ entries: [entry(30), entry(20)], nextBeforeId: 10 })
    act(() => latest.loadMore())
    act(() => latest.loadMore())
    expect(latest.isLoadingMore).toBe(true)
    expect(server.listCalls).toHaveLength(2)
    expect(server.listCalls[1]).toEqual({ beforeId: 10, filter: 'all' })

    await server.resolvePage({ entries: [entry(20), entry(5)] })
    expect(latest.entries.map(e => e.id)).toEqual([30, 20, 5])
    expect(latest.hasMore).toBe(false)
    expect(latest.isLoadingMore).toBe(false)

    act(() => latest.loadMore())
    expect(server.listCalls).toHaveLength(2)
  })

  it('keeps hasMore after an empty page that carries a cursor', async () => {
    const server = makeOverseer()
    await render(server.overseer, 'all', true)
    await server.resolvePage({ entries: [], nextBeforeId: 400 })

    expect(latest.status).toBe('ready')
    expect(latest.entries).toEqual([])
    expect(latest.hasMore).toBe(true)

    act(() => latest.loadMore())
    expect(server.listCalls[1]).toEqual({ beforeId: 400, filter: 'all' })
  })

  it('resets on filter change and ignores the stale in-flight page', async () => {
    const server = makeOverseer()
    await render(server.overseer, 'all', true)

    await render(server.overseer, 'action', true)
    expect(latest.entries).toEqual([])
    expect(latest.status).toBe('loading')
    expect(server.listCalls[1]).toEqual({ beforeId: undefined, filter: 'action' })

    await server.resolvePage({ entries: [entry(30)] })
    expect(latest.entries).toEqual([])
    expect(latest.status).toBe('loading')

    await server.resolvePage({ entries: [entry(20)] })
    expect(latest.entries.map(e => e.id)).toEqual([20])
    expect(latest.status).toBe('ready')
  })

  it('resets and refetches when the stub changes', async () => {
    const first = makeOverseer()
    await render(first.overseer, 'all', true)
    await first.resolvePage({ entries: [entry(30)], nextBeforeId: 10 })
    act(() => latest.loadMore())  // leave a second fetch in flight on the old stub

    const second = makeOverseer()
    await render(second.overseer, 'all', true)
    expect(latest.entries).toEqual([])
    expect(second.listCalls).toEqual([{ beforeId: undefined, filter: 'all' }])

    // The abandoned stub's in-flight page must not leak into the new session.
    await first.resolvePage({ entries: [entry(9)] })
    expect(latest.entries).toEqual([])
    expect(latest.status).toBe('loading')

    await second.resolvePage({ entries: [entry(40)] })
    expect(latest.entries.map(e => e.id)).toEqual([40])
  })

  it('recovers from a failed first load on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await render(server.overseer, 'all', true)
    await server.rejectPage(new Error('nope'))
    expect(latest.status).toBe('error')
    expect(latest.loadMoreFailed).toBe(false)  // first-load failure is owned by status

    act(() => latest.loadMore())
    expect(latest.status).toBe('loading')
    expect(server.listCalls[1]).toEqual({ beforeId: undefined, filter: 'all' })
    await server.resolvePage({ entries: [entry(30)] })
    expect(latest.status).toBe('ready')
    expect(latest.entries.map(e => e.id)).toEqual([30])
    vi.restoreAllMocks()
  })

  it('preserves a later page cursor and entries when retrying after failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await render(server.overseer, 'all', true)
    await server.resolvePage({ entries: [entry(30)], nextBeforeId: 10 })

    act(() => latest.loadMore())
    await server.rejectPage(new Error('nope'))
    expect(latest.status).toBe('ready')
    expect(latest.loadMoreFailed).toBe(true)
    expect(latest.entries.map(e => e.id)).toEqual([30])
    expect(latest.hasMore).toBe(true)
    expect(latest.isLoadingMore).toBe(false)

    act(() => latest.loadMore())
    expect(latest.loadMoreFailed).toBe(false)  // cleared as soon as the retry starts
    expect(server.listCalls[2]).toEqual({ beforeId: 10, filter: 'all' })
    await server.resolvePage({ entries: [entry(5)] })
    expect(latest.loadMoreFailed).toBe(false)
    expect(latest.entries.map(e => e.id)).toEqual([30, 5])
    expect(latest.hasMore).toBe(false)
    vi.restoreAllMocks()
  })

  describe('live updates', () => {
    it('patches a loaded record in place', async () => {
      const server = makeOverseer()
      await render(server.overseer, 'all', true)
      await server.resolvePage({ entries: [entry(30)], nextBeforeId: 10 })

      await server.emit(entry(30, { state: 'rejected' }))
      expect(latest.entries.map(e => [e.id, e.state])).toEqual([[30, 'rejected']])
    })

    it('inserts new and in-window resolutions, ordered by id', async () => {
      const server = makeOverseer()
      await render(server.overseer, 'all', true)
      await server.resolvePage({ entries: [entry(30), entry(20)], nextBeforeId: 10 })

      await server.emit(entry(40))  // newly resolved, above the window
      await server.emit(entry(25))  // old pending resolved inside the window
      expect(latest.entries.map(e => e.id)).toEqual([40, 30, 25, 20])
    })

    it('inserts a new pending record and patches its resolution in place', async () => {
      const server = makeOverseer()
      await render(server.overseer, 'all', true)
      await server.resolvePage({ entries: [entry(30)], nextBeforeId: 10 })

      await server.emit(pendingEntry(40))
      expect(latest.entries.map(e => [e.id, e.state]))
        .toEqual([[40, 'pending'], [30, 'approved']])

      await server.emit(entry(40, { state: 'rejected' }))
      expect(latest.entries.map(e => [e.id, e.state]))
        .toEqual([[40, 'rejected'], [30, 'approved']])
    })

    it('drops records below the loaded window and filter mismatches', async () => {
      const server = makeOverseer()
      await render(server.overseer, 'action', true)
      await server.resolvePage({ entries: [entry(30)], nextBeforeId: 10 })

      await server.emit(entry(5))                                          // below the window
      await server.emit(pendingEntry(35, { type: 'observation' }))         // filter mismatch
      await server.emit(entry(36, { type: 'observation' }))                // filter mismatch
      expect(latest.entries.map(e => e.id)).toEqual([30])
    })

    it('drops updates until a page has loaded', async () => {
      const server = makeOverseer()
      await render(server.overseer, 'all', true)
      await server.emit(entry(50))  // arrives while the first page is in flight
      await server.resolvePage({ entries: [entry(30)] })

      expect(latest.entries.map(e => e.id)).toEqual([30])
    })
  })
})
