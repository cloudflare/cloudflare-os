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
  FileAtCommit,
  Overseer,
  PushReview,
  TreeNode,
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
    // Every real action is queued against a connection; only an observation from a built-in
    // agent tool reaches the client without one. Surfaces that group by resource depend on it.
    gatekeeperId: 1,
    resourceTitle: `Resource ${id}`,
    createdAt: new Date(1700000000000 + id * 60_000),
    state: 'pending',
    type: 'action',
    description: {
      title: `Action ${id}`, description: '', implementsRevert: false, autoApprovable: false,
    },
    ...over,
  } as ActionLogEntry
}

const fixtureOid = (name: string, id: number) => `${name}${id}`.padEnd(40, '0')

/** A pending push: an action that names the commit it sends, as a git host's gatekeeper queues. */
export function pushEntry(id: number, over: Partial<Record<string, unknown>> = {}): ActionLogEntry {
  return entry(id, {
    description: {
      title: `Push ${id}`, description: `Push commit ${fixtureOid('c', id).slice(0, 7)} to branch main`,
      implementsRevert: false, autoApprovable: false, pushedCommits: [fixtureOid('c', id)],
    },
    ...over,
  })
}

/** The path and content of the one file the push of `pushEntry()` sends. */
export const PUSHED_FILE = { path: 'notes.txt', text: 'one line\n' }

/**
 * What the push of `pushEntry(id)` sends, as Overseer.getPushReview() lists it on one page: a
 * root commit, its root directory and one added text file.
 */
export function pushReviewOf(id: number): PushReview {
  const commit = fixtureOid('c', id)
  const text = `tree ${fixtureOid('d', id)}\nauthor Ada <ada@example.com> 1700000000 +0000\n` +
    `committer Ada <ada@example.com> 1700000000 +0000\n\nSubject of push ${id}\n`
  return {
    entries: [
      { kind: 'commit', oid: commit, parents: [], size: text.length, text },
      {
        kind: 'path', commit, path: '', entry: { kind: 'dir', oid: fixtureOid('d', id) },
        parents: [], sent: { kind: 'dir', size: 37 },
      },
      {
        kind: 'path', commit, path: PUSHED_FILE.path, entry: { kind: 'file', oid: fixtureOid('f', id) },
        parents: [], sent: { kind: 'text', size: PUSHED_FILE.text.length },
      },
    ],
    objectCount: 3,
    stackedOn: [],
  }
}

/** Lets an open push review's pages and the file store's batched reads settle. */
export async function settlePushReview() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** The open push review, or null: the one dialog titled "Review commits". */
export function pushReviewDialog(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find(dialog =>
      document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent === 'Review commits',
    ) ?? null
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
 * getPushReview answers at once with `pushReviewOf(actionId)`, readFilesAtCommit with
 * `PUSHED_FILE`'s text and listTree with that one file, so a push's review loads whole.
 */
export function makeOverseer() {
  const ops: Array<'subscribe' | 'list' | 'listPending'> = []
  const subscribeCalls: unknown[][] = []
  const pendingSubscribes: Array<Parked<RpcStub<{}>>> = []
  const historyQueue = parkedQueue()
  const pendingQueue = parkedQueue()
  // Decisions park until the test settles them, so a run can be observed mid-flight -- which is
  // when the surfaces that must not decide alongside it are worth asserting on.
  const decisions: Array<{ call: string, settle: Parked<void> }> = []
  const decide = (call: string) => new Promise<void>((resolve, reject) =>
    decisions.push({ call, settle: { resolve, reject } }))
  const subscriptionDispose = vi.fn<() => void>()
  let subscriber: ActionsSubscriber | undefined
  const pushReviewCalls: number[] = []
  const overseer = {
    subscribeToActions: (...args: unknown[]) => {
      ops.push('subscribe')
      subscribeCalls.push(args)
      subscriber = args[0] as ActionsSubscriber
      return new Promise<RpcStub<{}>>((resolve, reject) =>
        pendingSubscribes.push({ resolve, reject }))
    },
    listAutoApprovedActionKinds: async () => [],
    approveAction: (id: number) => decide(`approve:${id}`),
    rejectAction: (id: number) => decide(`reject:${id}`),
    getPushReview: async (actionId: number) => {
      pushReviewCalls.push(actionId)
      return pushReviewOf(actionId)
    },
    readFilesAtCommit: async (_commitId: string, paths: string[]) =>
      paths.map((path): [string, FileAtCommit] => [path, { kind: 'text', text: PUSHED_FILE.text }]),
    listTree: async (): Promise<TreeNode[]> => [{ name: PUSHED_FILE.path, kind: 'file' }],
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
    /** The action ids whose push review was asked for, oldest first. */
    pushReviewCalls,
    async resolveSubscription() {
      await act(async () => {
        pendingSubscribes.shift()!.resolve(
          { [Symbol.dispose]: subscriptionDispose } as unknown as RpcStub<{}>)
      })
    },
    async rejectSubscription(err: unknown) {
      await act(async () => { pendingSubscribes.shift()!.reject(err) })
    },
    /** The decisions sent so far, as `approve:<id>` / `reject:<id>`, oldest first. */
    get decisionCalls() { return decisions.map(decision => decision.call) },
    /** Settles the oldest decision still in flight. */
    async settleDecision() {
      await act(async () => { decisions.shift()!.settle.resolve() })
    },
    /** Fails the oldest parked decision, as a provider refusing it would. */
    async failDecision(error: unknown) {
      await act(async () => { decisions.shift()!.settle.reject(error) })
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

/** A promise for a test to settle when it chooses, inside act(). */
export function deferred<T = void>() {
  let settle!: { resolve: (value: T) => void, reject: (error: unknown) => void }
  const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject } })
  return {
    promise,
    async resolve(value: T) { await act(async () => settle.resolve(value)) },
    async reject(error: unknown) { await act(async () => settle.reject(error)) },
  }
}

/** The switch of the hook titled `title`, found by its accessible name. */
export function hookSwitch(title: string): HTMLButtonElement {
  const element = document.querySelector(`[role="switch"][aria-label="Hook: ${title}"]`)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`No switch for the hook "${title}"`)
  return element
}

/**
 * Flip the switch of the hook titled `title`, as a click would: through the checkbox the switch
 * forwards its clicks to, since jsdom has no PointerEvent to forward them with.
 */
export async function clickHookSwitch(title: string): Promise<void> {
  const checkbox = hookSwitch(title).nextElementSibling
  if (!(checkbox instanceof HTMLInputElement)) throw new Error(`No checkbox behind the hook "${title}"`)
  await act(async () => checkbox.click())
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
