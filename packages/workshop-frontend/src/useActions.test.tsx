// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry,
  ActionsSubscriber,
  ActionState,
  Overseer,
  PendingActionsPage,
} from '@gadgets/workshop-shared/api'
import { useActionEntries, useActions, type ActionsState } from './useActions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The store coalesces entry commits through rAF; queue frames manually and flush inside act().
const rafQueue: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb))
function flushFrames() {
  act(() => {
    while (rafQueue.length) rafQueue.shift()!(0)
  })
}

function entry(id: number, state: ActionState = 'pending'): ActionLogEntry {
  return {
    id,
    resourceTitle: `Resource ${id}`,
    createdAt: new Date(1700000000000 + id * 60_000),
    state,
    type: 'action',
    description: { title: `Action ${id}`, description: '', implementsRevert: false },
  } as ActionLogEntry
}

type ScanOptions = Parameters<Overseer['scanPendingActions']>[0]

function makeOverseer() {
  const callOrder: Array<'subscribe' | 'scan'> = []
  const subscribeCalls: unknown[][] = []
  const scanCalls: ScanOptions[] = []
  const pendingSubscribes: Array<{
    resolve: (sub: RpcStub<{}>) => void
    reject: (err: unknown) => void
  }> = []
  const pendingScans: Array<{
    resolve: (page: PendingActionsPage) => void
    reject: (err: unknown) => void
  }> = []
  const subscriptionDispose = vi.fn<() => void>()
  let subscriber: ActionsSubscriber | undefined
  const overseer = {
    subscribeToActions: (...args: unknown[]) => {
      callOrder.push('subscribe')
      subscribeCalls.push(args)
      subscriber = args[0] as ActionsSubscriber
      return new Promise<RpcStub<{}>>((resolve, reject) =>
        pendingSubscribes.push({ resolve, reject }))
    },
    scanPendingActions: (options?: ScanOptions) => {
      callOrder.push('scan')
      scanCalls.push(options)
      return new Promise<PendingActionsPage>((resolve, reject) =>
        pendingScans.push({ resolve, reject }))
    },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    callOrder,
    subscribeCalls,
    scanCalls,
    subscriptionDispose,
    async resolveSubscription() {
      await act(async () => {
        pendingSubscribes.shift()!.resolve(
          { [Symbol.dispose]: subscriptionDispose } as unknown as RpcStub<{}>)
      })
    },
    async rejectSubscription(err: unknown) {
      await act(async () => { pendingSubscribes.shift()!.reject(err) })
    },
    async resolveScan(page: PendingActionsPage) {
      await act(async () => { pendingScans.shift()!.resolve(page) })
    },
    async rejectScan(err: unknown) {
      await act(async () => { pendingScans.shift()!.reject(err) })
    },
    async emit(record: ActionLogEntry) {
      await act(async () => { subscriber!.entry(record) })
    },
  }
}

describe('useActions', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let latest: ActionsState

  function Probe({ overseer }: { overseer: RpcStub<Overseer> | null }) {
    latest = useActions(overseer)
    return null
  }

  async function render(node: React.ReactNode) {
    if (!root) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    }
    await act(async () => root!.render(node))
  }

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container?.remove()
    rafQueue.length = 0
    vi.restoreAllMocks()
  })

  it('subscribes live-only and stays checking until the scan drains', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)

    expect(server.callOrder.slice(0, 2)).toEqual(['subscribe', 'scan'])
    // No startAfter: the legacy full replay must not be requested.
    expect(server.subscribeCalls).toEqual([[expect.anything()]])
    expect(latest.status).toBe('checking')
    expect(server.scanCalls).toEqual([undefined])

    await server.resolveScan({ entries: [entry(1)], throughId: 10, nextCursor: 5 })
    expect(server.scanCalls[1]).toEqual({ cursor: 5, throughId: 10 })
    expect(latest.status).toBe('checking')
    flushFrames()
    expect([...latest.pendingById.keys()]).toEqual([1])  // counts accumulate mid-scan

    await server.resolveScan({ entries: [entry(7)], throughId: 10 })
    expect(latest.status).toBe('ready')
    expect([...latest.pendingById.keys()]).toEqual([1, 7])
    expect(latest.liveById.size).toBe(0)  // scan-found records are not "live"
    flushFrames()
    expect(latest.status).toBe('ready')
  })

  it('lets a live update win over a stale scan page', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    await server.emit(entry(3, 'approved'))  // resolved live before its scan page arrives
    await server.resolveScan({ entries: [entry(3, 'pending'), entry(4)], throughId: 10 })

    expect(latest.status).toBe('ready')
    expect([...latest.pendingById.keys()]).toEqual([4])
    expect(latest.liveById.get(3)?.state).toBe('approved')
  })

  it('removes a pending record when it resolves live', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()
    await server.resolveScan({ entries: [], throughId: 0 })

    await server.emit(entry(9))
    flushFrames()
    expect([...latest.pendingById.keys()]).toEqual([9])

    await server.emit(entry(9, 'rejected'))
    flushFrames()
    expect(latest.pendingById.size).toBe(0)
    expect(latest.liveById.get(9)?.state).toBe('rejected')
  })

  it('fences a released store and disposes its late-arriving subscription', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)

    act(() => root!.unmount())
    root = undefined

    await server.resolveSubscription()
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
    // The abandoned scan settling must not throw or resurrect state.
    await server.resolveScan({ entries: [entry(1)], throughId: 2 })
  })

  it('starts a fresh scan when the stub changes', async () => {
    const first = makeOverseer()
    await render(<Probe overseer={first.overseer} />)
    await first.resolveScan({ entries: [entry(1)], throughId: 2 })
    expect(latest.status).toBe('ready')

    const second = makeOverseer()
    await render(<Probe overseer={second.overseer} />)
    expect(second.scanCalls).toEqual([undefined])
    expect(latest.status).toBe('checking')
    expect(latest.pendingById.size).toBe(0)
  })

  it('reports error but keeps gathered pendings and the live subscription when the scan fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    await server.resolveScan({ entries: [entry(1)], throughId: 10, nextCursor: 5 })
    await server.rejectScan(new Error('DO overloaded'))

    expect(latest.status).toBe('error')
    expect([...latest.pendingById.keys()]).toEqual([1])
    flushFrames()
    expect(latest.status).toBe('error')

    await server.emit(entry(2))
    flushFrames()
    expect(latest.status).toBe('error')
    expect([...latest.pendingById.keys()]).toEqual([1, 2])
    expect(latest.liveById.get(2)?.state).toBe('pending')
  })

  it('latches a subscription rejection and stops the in-flight scan', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)

    await server.rejectSubscription(new Error('subscription failed'))
    expect(latest.status).toBe('error')

    await server.resolveScan({ entries: [entry(1)], throughId: 10, nextCursor: 5 })
    flushFrames()
    expect(latest.status).toBe('error')
    expect(latest.pendingById.size).toBe(0)
    expect(server.scanCalls).toEqual([undefined])
  })

  it('continues after an empty nonterminal page and settles on the terminal page', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)

    await server.resolveScan({ entries: [], throughId: 10, nextCursor: 5 })
    expect(latest.status).toBe('checking')
    expect(server.scanCalls[1]).toEqual({ cursor: 5, throughId: 10 })

    await server.resolveScan({ entries: [], throughId: 10 })
    expect(latest.status).toBe('ready')
    expect(latest.pendingById.size).toBe(0)
    expect(latest.liveById.size).toBe(0)
    flushFrames()
    expect(latest.status).toBe('ready')
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

    await render(
      <Harness onEntry={firstCallback} showActions={true} showEntries={false} />)
    await server.resolveSubscription()
    await server.emit(entry(1))
    await server.emit(entry(2, 'approved'))
    await server.resolveScan({ entries: [entry(5)], throughId: 10 })  // scan-found, not live

    await render(
      <Harness onEntry={firstCallback} showActions={true} showEntries={true} />)
    expect(firstReceived).toEqual([1, 2])
    expect(server.subscribeCalls).toHaveLength(1)

    await render(
      <Harness onEntry={secondCallback} showActions={true} showEntries={true} />)
    expect(firstReceived).toEqual([1, 2])
    expect(secondReceived).toEqual([])

    await server.emit(entry(6))
    expect(firstReceived).toEqual([1, 2])
    expect(secondReceived).toEqual([6])
    expect(server.subscribeCalls).toHaveLength(1)

    await render(
      <Harness onEntry={secondCallback} showActions={false} showEntries={true} />)
    expect(server.subscriptionDispose).not.toHaveBeenCalled()

    await render(
      <Harness onEntry={secondCallback} showActions={false} showEntries={false} />)
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
  })
})
