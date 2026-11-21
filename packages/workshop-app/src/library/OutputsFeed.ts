import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, OutputsSubscriber, OutputSummary } from '@gadgets/workshop-shared/api'

export type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; outputs: OutputSummary[] }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * The library as the account keeps it: everything the user's workspaces, and those shared with
 * them, have made, most recently active first. `catchingUp` is true while workspaces older than
 * the index are still being swept into it.
 */
export type OutputsSnapshot = {
  library: LibraryState
  catchingUp: boolean
}

/**
 * What the server calls with the library. A class, because the server must receive a single stub
 * for the object. The server letting go of it (`Symbol.dispose`), which it does when the account
 * restarts and forgets its subscribers, is said through `onReleased`.
 */
class OutputsListener extends RpcTarget implements OutputsSubscriber {
  constructor(
    private readonly onSnapshot: (outputs: OutputSummary[], catchingUp: boolean) => void,
    private readonly onUpdated: (workspaceId: string, outputs: OutputSummary[]) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async snapshot(outputs: OutputSummary[], catchingUp: boolean) {
    this.onSnapshot(outputs, catchingUp)
  }

  async updated(workspaceId: string, outputs: OutputSummary[]) {
    this.onUpdated(workspaceId, outputs)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The part of the backend the library uses. The subscribe call takes the listener itself, as a
 * call through a stub does, and its lease must be disposed.
 */
export type OutputsBackend = {
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToOutputs']>[0]): Promise<Disposable>
}

export const LOADING_OUTPUTS: OutputsSnapshot = { library: { status: 'loading' }, catchingUp: false }
// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

const byActivity = (outputs: OutputSummary[]) => outputs.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())

/**
 * The library, live (`subscribeToOutputs()`), for the Library, a workspace's and a chat's lists,
 * search and the template store alike. Observable through `subscribe`/`getSnapshot`.
 *
 * The subscription is the account's, so no workspace restarting breaks it. A failed one is tried
 * again with growing waits, and one the account forgot, as it does when it restarts, is made
 * again. Each new connection starts a subscription on this same feed, keeping the last data the
 * account sent. Until anything is known, a failure shows as one, whose retry subscribes again at
 * once.
 */
export class OutputsFeed {
  #snapshot = LOADING_OUTPUTS
  #listeners = new Set<() => void>()
  #lease: Promise<Disposable> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = 0
  // Bumped by every subscription and stop(), so a call from an earlier one can tell it is stale.
  #run = 0

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start(backend: OutputsBackend) {
    this.#retryDelay = 0
    this.#subscribe(backend)
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    this.#releaseLease()
  }

  #subscribe(backend: OutputsBackend) {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#releaseLease()
    let live = false
    let released = false
    let hasSnapshot = false
    const listener = new OutputsListener(
      (outputs, catchingUp) => {
        if (run !== this.#run) return
        hasSnapshot = true
        this.#retryDelay = 0
        this.#publish({ library: { status: 'ready', outputs: byActivity(outputs) }, catchingUp })
      },
      (workspaceId, outputs) => {
        const { library } = this.#snapshot
        if (run !== this.#run || !hasSnapshot || library.status !== 'ready') return
        const others = library.outputs.filter((output) => output.workspaceId !== workspaceId)
        this.#publish({ ...this.#snapshot, library: { status: 'ready', outputs: byActivity([...others, ...outputs]) } })
      },
      () => {
        released = true
        // Let go of after it took, while still the current one: the account forgot it.
        if (live && run === this.#run) this.#subscribe(backend)
      },
    )
    const lease = backend.subscribe(listener)
    this.#lease = lease
    lease.then(
      () => {
        if (run !== this.#run) return
        live = true
        if (released) this.#subscribe(backend)
      },
      (error: unknown) => {
        if (run !== this.#run) return
        // What was known stays shown meanwhile; with nothing known, the failure is.
        if (this.#snapshot.library.status !== 'ready') {
          const message = error instanceof Error ? error.message : String(error)
          const retry = () => {
            if (run !== this.#run) return
            this.#retryDelay = 0
            this.#subscribe(backend)
          }
          this.#publish({ ...this.#snapshot, library: { status: 'failed', message, retry } })
          if (run !== this.#run) return
        }
        const delay = this.#retryDelay || RETRY_DELAY.first
        this.#retryDelay = Math.min(delay * 2, RETRY_DELAY.most)
        this.#retry = setTimeout(() => {
          if (run === this.#run) this.#subscribe(backend)
        }, delay)
      },
    )
  }

  #releaseLease() {
    void this.#lease?.then((held) => held[Symbol.dispose](), () => {})
    this.#lease = undefined
  }

  #publish(snapshot: OutputsSnapshot) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }
}
