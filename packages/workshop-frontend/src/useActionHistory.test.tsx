// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionHistoryFilter,
  ActionHistoryPage,
  ActionLogEntry,
  ActionsSubscriber,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { useActionHistory } from './useActionHistory'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.stubGlobal('requestAnimationFrame', () => 0)

function entry(id: number, over: Partial<Record<string, unknown>> = {}): ActionLogEntry {
  return {
    id,
    resourceTitle: `Resource ${id}`,
    createdAt: new Date(1700000000000 + id * 60_000),
    appliedAt: new Date(1700000000000 + id * 60_000),
    state: 'approved',
    type: 'action',
    description: { title: `Action ${id}`, description: '', implementsRevert: false },
    ...over,
  } as ActionLogEntry
}

type ListOptions = Parameters<Overseer['listActions']>[0]

function makeOverseer() {
  const listCalls: ListOptions[] = []
  const pendingPages: Array<{
    resolve: (page: ActionHistoryPage) => void
    reject: (err: unknown) => void
  }> = []
  let subscriber: ActionsSubscriber | undefined
  const overseer = {
    listActions: (options?: ListOptions) => {
      listCalls.push(options)
      return new Promise<ActionHistoryPage>((resolve, reject) =>
        pendingPages.push({ resolve, reject }))
    },
    subscribeToActions: async (sub: unknown) => {
      subscriber = sub as ActionsSubscriber
      return { [Symbol.dispose]: () => {} } as RpcStub<{}>
    },
    scanPendingActions: async () => ({ entries: [], throughId: 0 }),
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    listCalls,
    async resolvePage(page: ActionHistoryPage) {
      await act(async () => { pendingPages.shift()!.resolve(page) })
    },
    async rejectPage(err: unknown) {
      await act(async () => { pendingPages.shift()!.reject(err) })
    },
    async emit(record: ActionLogEntry) {
      await act(async () => { subscriber!.entry(record) })
    },
  }
}

type HookResult = ReturnType<typeof useActionHistory>

describe('useActionHistory', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let latest: HookResult

  function Probe({ overseer, filter, active }: {
    overseer: RpcStub<Overseer> | null
    filter: ActionHistoryFilter
    active: boolean
  }) {
    latest = useActionHistory(overseer, filter, active)
    return null
  }

  async function render(overseer: RpcStub<Overseer> | null, filter: ActionHistoryFilter,
      active: boolean) {
    if (!root) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    }
    await act(async () =>
      root!.render(<Probe overseer={overseer} filter={filter} active={active} />))
  }

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container?.remove()
  })

  it('fetches nothing until activated, then loads the first page', async () => {
    const server = makeOverseer()
    await render(server.overseer, 'all', false)
    expect(server.listCalls).toEqual([])
    expect(latest.status).toBe('idle')

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

    act(() => latest.loadMore())
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
    expect(latest.entries.map(e => e.id)).toEqual([30])
    expect(latest.hasMore).toBe(true)
    expect(latest.isLoadingMore).toBe(false)

    act(() => latest.loadMore())
    expect(server.listCalls[2]).toEqual({ beforeId: 10, filter: 'all' })
    await server.resolvePage({ entries: [entry(5)] })
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

    it('drops records below the loaded window, pending records, and filter mismatches',
        async () => {
      const server = makeOverseer()
      await render(server.overseer, 'action', true)
      await server.resolvePage({ entries: [entry(30)], nextBeforeId: 10 })

      await server.emit(entry(5))                                          // below the window
      await server.emit(entry(35, { state: 'pending' }))                   // not resolved
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
