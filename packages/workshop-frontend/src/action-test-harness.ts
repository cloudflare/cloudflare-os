// Shared harness for the action-store hook tests (useActions / useActionHistory): act-enabled
// root management, manually-pumped rAF frames (the store coalesces entry commits through rAF),
// an ActionLogEntry factory, and a fake overseer covering the subscription and history-paging
// surfaces. Not a test file itself -- vitest only collects *.test.* -- so importing it is what
// installs the act environment and the rAF stub.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionHistoryPage,
  ActionLogEntry,
  ActionsSubscriber,
  Overseer,
} from '@gadgets/workshop-shared/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rafQueue: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb))

/** Run every queued rAF callback inside act(). */
export function flushFrames() {
  act(() => {
    while (rafQueue.length) rafQueue.shift()!(0)
  })
}

export function entry(id: number, over: Partial<Record<string, unknown>> = {}): ActionLogEntry {
  return {
    id,
    resourceTitle: `Resource ${id}`,
    createdAt: new Date(1700000000000 + id * 60_000),
    state: 'pending',
    type: 'action',
    description: { title: `Action ${id}`, description: '', implementsRevert: false },
    ...over,
  } as ActionLogEntry
}

type ListOptions = Parameters<Overseer['listActions']>[0]

type Parked<T> = { resolve: (value: T) => void, reject: (err: unknown) => void }

/**
 * A queue of parked listActions calls: park() records the call and returns a promise that stays
 * unsettled until resolveNext()/rejectNext() settles the oldest one inside act().
 */
function parkedQueue() {
  const calls: ListOptions[] = []
  const parked: Array<Parked<ActionHistoryPage>> = []
  return {
    calls,
    park(call: ListOptions) {
      calls.push(call)
      return new Promise<ActionHistoryPage>((resolve, reject) => parked.push({ resolve, reject }))
    },
    async resolveNext(page: ActionHistoryPage) {
      await act(async () => { parked.shift()!.resolve(page) })
    },
    async rejectNext(err: unknown) {
      await act(async () => { parked.shift()!.reject(err) })
    },
  }
}

/**
 * Mocks the server side of the action APIs. subscribeToActions: live records are pushed through
 * the captured subscriber's entry() via emit(); the call itself parks until
 * resolveSubscription()/rejectSubscription(). listActions: each call parks — the shared store's
 * pending queries ({filter: 'pending'}) on their own queue drained by
 * resolvePendingQuery()/rejectPendingQuery(), every other filter on the history queue drained by
 * resolvePage()/rejectPage(). `ops` records the initiation order across all three surfaces.
 */
export function makeOverseer() {
  const ops: Array<'subscribe' | 'list' | 'listPending'> = []
  const subscribeCalls: unknown[][] = []
  const pendingSubscribes: Array<Parked<RpcStub<{}>>> = []
  const historyQueue = parkedQueue()
  const pendingQueue = parkedQueue()
  const subscriptionDispose = vi.fn<() => void>()
  let subscriber: ActionsSubscriber | undefined
  const overseer = {
    subscribeToActions: (...args: unknown[]) => {
      ops.push('subscribe')
      subscribeCalls.push(args)
      subscriber = args[0] as ActionsSubscriber
      return new Promise<RpcStub<{}>>((resolve, reject) =>
        pendingSubscribes.push({ resolve, reject }))
    },
    listActions: (options?: ListOptions) => {
      if (options?.filter === 'pending') {
        ops.push('listPending')
        return pendingQueue.park(options)
      }
      ops.push('list')
      return historyQueue.park(options)
    },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    ops,
    subscribeCalls,
    listCalls: historyQueue.calls,
    pendingQueryCalls: pendingQueue.calls,
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
    resolvePage: historyQueue.resolveNext,
    rejectPage: historyQueue.rejectNext,
    resolvePendingQuery: pendingQueue.resolveNext,
    rejectPendingQuery: pendingQueue.rejectNext,
    async emit(record: ActionLogEntry) {
      await act(async () => { subscriber!.entry(record) })
    },
  }
}

/** A DOM root with act()-wrapped render/unmount. cleanup() resets it for the next test. */
export function makeTestRoot() {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  return {
    async render(node: React.ReactNode) {
      if (!root) {
        container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
      }
      await act(async () => root!.render(node))
    },
    unmount() {
      act(() => root?.unmount())
      root = undefined
    },
    cleanup() {
      this.unmount()
      container?.remove()
      container = undefined
      rafQueue.length = 0
    },
  }
}
