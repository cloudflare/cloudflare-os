// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import { useActionEntries, useActions, type ActionsState } from './useActions'

describe('useActions', () => {
  const view = makeTestRoot()
  let latest: ActionsState

  function Probe({ overseer }: { overseer: RpcStub<Overseer> | null }) {
    latest = useActions(overseer)
    return null
  }

  afterEach(() => {
    view.cleanup()
    vi.restoreAllMocks()
  })

  it('initiates the subscription before the first pending page, with no startAfter', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)

    // Subscribe-first is what lets the pages be a complete snapshot: capnweb e-order registers
    // the subscriber server-side before the first page reads.
    expect(server.ops).toEqual(['subscribe', 'listPending'])
    // Single argument: the legacy full replay (startAfter) must not be requested.
    expect(server.subscribeCalls).toEqual([[expect.anything()]])
    expect(server.pendingQueryCalls).toEqual([{ filter: 'pending', beforeId: undefined }])
  })

  it('stays checking until the last pending page loads', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)

    await server.resolveSubscription()
    expect(latest.status).toBe('checking')  // the subscription alone doesn't settle

    await server.resolvePendingQuery({ entries: [entry(1)], nextBeforeId: 1 })
    expect(latest.status).toBe('checking')
    flushFrames()
    expect(latest.pending.map(e => e.id)).toEqual([1])  // counts accumulate mid-paging
    expect(server.pendingQueryCalls[1]).toEqual({ filter: 'pending', beforeId: 1 })

    await server.resolvePendingQuery({ entries: [entry(0)] })
    expect(latest.status).toBe('ready')  // settles synchronously, no frame needed
    expect(latest.pending.map(e => e.id)).toEqual([0, 1])
  })

  it('sorts pendings oldest-first by createdAt, breaking ties by id', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    const at = new Date(1700000000000)
    await server.emit(entry(4, { createdAt: at }))
    await server.emit(entry(6, { createdAt: new Date(1600000000000) }))
    await server.emit(entry(5, { createdAt: at }))
    flushFrames()
    expect(latest.pending.map(e => e.id)).toEqual([6, 4, 5])
  })

  it('removes a pending record when it resolves live', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    await server.emit(entry(9))
    flushFrames()
    expect(latest.pending.map(e => e.id)).toEqual([9])

    await server.emit(entry(9, { state: 'rejected' }))
    flushFrames()
    expect(latest.pending).toEqual([])
  })

  it('never re-marks a record pending after a live resolution beat its stale page copy',
      async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    // The record resolves on the live stream while its page is still in flight; the page's
    // pending copy is a stale call-time snapshot and must lose.
    await server.emit(entry(5))
    await server.emit(entry(5, { state: 'approved' }))
    await server.resolvePendingQuery({ entries: [entry(5)] })

    expect(latest.status).toBe('ready')
    expect(latest.pending).toEqual([])
  })

  it('fences a released store and disposes its late-arriving subscription', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.emit(entry(1))

    view.unmount()

    await server.resolveSubscription()
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
    // A late entry on the fenced generation must not throw or resurrect state.
    await server.emit(entry(2))
  })

  it('fences the page loop: a late page neither folds nor requests a successor', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    view.unmount()

    await server.resolvePendingQuery({ entries: [entry(1)], nextBeforeId: 1 })
    expect(server.pendingQueryCalls).toHaveLength(1)
  })

  it('starts a fresh subscription when the stub changes', async () => {
    const first = makeOverseer()
    await view.render(<Probe overseer={first.overseer} />)
    await first.emit(entry(1))
    await first.resolveSubscription()
    await first.resolvePendingQuery({ entries: [] })
    expect(latest.status).toBe('ready')

    const second = makeOverseer()
    await view.render(<Probe overseer={second.overseer} />)
    expect(second.subscribeCalls).toHaveLength(1)
    expect(second.pendingQueryCalls).toHaveLength(1)
    expect(latest.status).toBe('checking')
    expect(latest.pending).toEqual([])
  })

  it('reports error but keeps gathered pendings when the subscribe call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)

    await server.emit(entry(1))
    await server.rejectSubscription(new Error('DO overloaded'))

    expect(latest.status).toBe('error')
    expect(latest.pending.map(e => e.id)).toEqual([1])
    flushFrames()
    expect(latest.status).toBe('error')
  })

  it('stays error when the pages drain after the subscribe call already failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)

    await server.rejectSubscription(new Error('DO overloaded'))
    await server.resolvePendingQuery({ entries: [entry(1)] })

    // The successful pages fold, but a dead live stream must not present as settled.
    expect(latest.status).toBe('error')
    expect(latest.pending.map(e => e.id)).toEqual([1])
  })

  it('reports error but keeps gathered pendings when a later page fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    await server.emit(entry(1))
    await server.resolvePendingQuery({ entries: [entry(3)], nextBeforeId: 3 })
    await server.rejectPendingQuery(new Error('DO overloaded'))

    expect(latest.status).toBe('error')
    expect(latest.pending.map(e => e.id)).toEqual([1, 3])
    flushFrames()
    expect(latest.status).toBe('error')
  })

  it('downgrades ready to error when the subscribe call fails after the pages drained',
      async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)

    // The pages can drain before the subscribe call's return trip fails; a store with a dead
    // live stream must not present as settled.
    await server.resolvePendingQuery({ entries: [entry(2)] })
    expect(latest.status).toBe('ready')

    await server.rejectSubscription(new Error('broken tube'))
    expect(latest.status).toBe('error')
    expect(latest.pending.map(e => e.id)).toEqual([2])
  })

  it('fans out live entries only — paged pendings are not entries', async () => {
    const server = makeOverseer()
    const received: number[] = []
    const late: number[] = []

    function EntriesProbe({ sink }: { sink: number[] }) {
      useActionEntries(server.overseer, record => sink.push(record.id))
      return null
    }

    await view.render(
      <>
        <Probe overseer={server.overseer} />
        <EntriesProbe key="first" sink={received} />
      </>,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1)] })
    await server.emit(entry(2))
    expect(received).toEqual([2])

    // A late consumer's mount-time replay is live-only too.
    await view.render(
      <>
        <Probe overseer={server.overseer} />
        <EntriesProbe key="first" sink={received} />
        <EntriesProbe key="late" sink={late} />
      </>,
    )
    expect(late).toEqual([2])
  })

  it('isolates a throwing entry listener from other consumers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    const received: number[] = []

    function EntriesProbe({ onEntry }: { onEntry: (record: ActionLogEntry) => void }) {
      useActionEntries(server.overseer, onEntry)
      return null
    }

    await view.render(
      <>
        <Probe overseer={server.overseer} />
        <EntriesProbe key="throws" onEntry={() => { throw new Error('listener broke') }} />
        <EntriesProbe key="works" onEntry={record => received.push(record.id)} />
      </>,
    )
    await server.resolveSubscription()

    await server.emit(entry(3))
    flushFrames()
    expect(received).toEqual([3])
    expect(latest.pending.map(e => e.id)).toEqual([3])
    expect(consoleError).toHaveBeenCalledWith('Action entry listener failed:', expect.any(Error))
  })

  it('updates a late listener without replaying and disposes after the last consumer', async () => {
    const server = makeOverseer()
    const firstReceived: number[] = []
    const secondReceived: number[] = []
    const firstCallback = (record: ActionLogEntry) => firstReceived.push(record.id)
    const secondCallback = (record: ActionLogEntry) => secondReceived.push(record.id)

    function EntriesProbe({ onEntry }: { onEntry: (record: ActionLogEntry) => void }) {
      useActionEntries(server.overseer, onEntry)
      return null
    }

    function Harness({
      onEntry,
      showActions,
      showEntries,
    }: {
      onEntry: (record: ActionLogEntry) => void
      showActions: boolean
      showEntries: boolean
    }) {
      return (
        <>
          {showActions && <Probe key="actions" overseer={server.overseer} />}
          {showEntries && <EntriesProbe key="entries" onEntry={onEntry} />}
        </>
      )
    }

    await view.render(
      <Harness onEntry={firstCallback} showActions={true} showEntries={false} />)
    await server.resolveSubscription()
    await server.emit(entry(1))
    await server.emit(entry(2, { state: 'approved' }))

    await view.render(
      <Harness onEntry={firstCallback} showActions={true} showEntries={true} />)
    expect(firstReceived).toEqual([1, 2])
    expect(server.subscribeCalls).toHaveLength(1)

    await view.render(
      <Harness onEntry={secondCallback} showActions={true} showEntries={true} />)
    expect(firstReceived).toEqual([1, 2])
    expect(secondReceived).toEqual([])

    await server.emit(entry(6))
    expect(firstReceived).toEqual([1, 2])
    expect(secondReceived).toEqual([6])
    expect(server.subscribeCalls).toHaveLength(1)

    await view.render(
      <Harness onEntry={secondCallback} showActions={false} showEntries={true} />)
    expect(server.subscriptionDispose).not.toHaveBeenCalled()

    await view.render(
      <Harness onEntry={secondCallback} showActions={false} showEntries={false} />)
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
  })
})
