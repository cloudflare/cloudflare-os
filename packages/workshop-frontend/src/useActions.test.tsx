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

// Mocks the server side of subscribeToActions: replayed and live records alike are pushed through
// the captured subscriber's entry(); resolving the call is the "replay complete" signal.
function makeOverseer() {
  const subscribeCalls: unknown[][] = []
  const pendingSubscribes: Array<{
    resolve: (sub: RpcStub<{}>) => void
    reject: (err: unknown) => void
  }> = []
  const subscriptionDispose = vi.fn<() => void>()
  let subscriber: ActionsSubscriber | undefined
  const overseer = {
    subscribeToActions: (...args: unknown[]) => {
      subscribeCalls.push(args)
      subscriber = args[0] as ActionsSubscriber
      return new Promise<RpcStub<{}>>((resolve, reject) =>
        pendingSubscribes.push({ resolve, reject }))
    },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    subscribeCalls,
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

  it('stays checking through the replay and settles when the subscribe call resolves', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)

    // No startAfter: the legacy full replay must not be requested.
    expect(server.subscribeCalls).toEqual([[expect.anything()]])
    expect(latest.status).toBe('checking')

    await server.emit(entry(1))
    expect(latest.status).toBe('checking')
    flushFrames()
    expect([...latest.pendingById.keys()]).toEqual([1])  // counts accumulate mid-replay

    await server.emit(entry(7))
    await server.resolveSubscription()  // settles synchronously, no frame needed
    expect(latest.status).toBe('ready')
    expect([...latest.pendingById.keys()]).toEqual([1, 7])
    expect([...latest.entriesById.keys()]).toEqual([1, 7])
    flushFrames()
    expect(latest.status).toBe('ready')
  })

  it('removes a pending record when it resolves live', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()

    await server.emit(entry(9))
    flushFrames()
    expect([...latest.pendingById.keys()]).toEqual([9])

    await server.emit(entry(9, 'rejected'))
    flushFrames()
    expect(latest.pendingById.size).toBe(0)
    expect(latest.entriesById.get(9)?.state).toBe('rejected')
  })

  it('fences a released store and disposes its late-arriving subscription', async () => {
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)
    await server.emit(entry(1))

    act(() => root!.unmount())
    root = undefined

    await server.resolveSubscription()
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
    // A late entry on the fenced generation must not throw or resurrect state.
    await server.emit(entry(2))
  })

  it('starts a fresh subscription when the stub changes', async () => {
    const first = makeOverseer()
    await render(<Probe overseer={first.overseer} />)
    await first.emit(entry(1))
    await first.resolveSubscription()
    expect(latest.status).toBe('ready')

    const second = makeOverseer()
    await render(<Probe overseer={second.overseer} />)
    expect(second.subscribeCalls).toHaveLength(1)
    expect(latest.status).toBe('checking')
    expect(latest.pendingById.size).toBe(0)
  })

  it('reports error but keeps gathered pendings when the subscribe call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    await render(<Probe overseer={server.overseer} />)

    await server.emit(entry(1))
    await server.rejectSubscription(new Error('DO overloaded'))

    expect(latest.status).toBe('error')
    expect([...latest.pendingById.keys()]).toEqual([1])
    flushFrames()
    expect(latest.status).toBe('error')
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
