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

  it('stays checking through the replay and settles when the subscribe call resolves', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)

    // No startAfter: the legacy full replay must not be requested.
    expect(server.subscribeCalls).toEqual([[expect.anything()]])
    expect(latest.status).toBe('checking')

    await server.emit(entry(1))
    expect(latest.status).toBe('checking')
    flushFrames()
    expect(latest.pending.map(e => e.id)).toEqual([1])  // counts accumulate mid-replay

    await server.emit(entry(7))
    await server.resolveSubscription()  // settles synchronously, no frame needed
    expect(latest.status).toBe('ready')
    expect(latest.pending.map(e => e.id)).toEqual([1, 7])
    flushFrames()
    expect(latest.status).toBe('ready')
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

  it('starts a fresh subscription when the stub changes', async () => {
    const first = makeOverseer()
    await view.render(<Probe overseer={first.overseer} />)
    await first.emit(entry(1))
    await first.resolveSubscription()
    expect(latest.status).toBe('ready')

    const second = makeOverseer()
    await view.render(<Probe overseer={second.overseer} />)
    expect(second.subscribeCalls).toHaveLength(1)
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
