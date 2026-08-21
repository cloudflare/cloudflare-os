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

/**
 * Mocks the server side of the action APIs. subscribeToActions: replayed and live records alike
 * are pushed through the captured subscriber's entry() via emit(); resolving the call (explicitly,
 * via resolveSubscription) is the "replay complete" signal. listActions: each call parks until
 * resolvePage()/rejectPage().
 */
export function makeOverseer() {
  const subscribeCalls: unknown[][] = []
  const pendingSubscribes: Array<{
    resolve: (sub: RpcStub<{}>) => void
    reject: (err: unknown) => void
  }> = []
  const listCalls: ListOptions[] = []
  const pendingPages: Array<{
    resolve: (page: ActionHistoryPage) => void
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
    listActions: (options?: ListOptions) => {
      listCalls.push(options)
      return new Promise<ActionHistoryPage>((resolve, reject) =>
        pendingPages.push({ resolve, reject }))
    },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    subscribeCalls,
    listCalls,
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
