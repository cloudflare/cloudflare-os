import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, WorkspaceSummary, WorkspaceSummarySubscriber } from '@gadgets/workshop-shared/api'

/**
 * Each workspace the user builds in, as the account summarizes it (`WorkspaceSummary`): what waits
 * on them there, and its hooks. `known` is false until the account has said. A workspace with no
 * summary is unknown, not empty.
 */
export type SummariesSnapshot = {
  known: boolean
  /** By workspace id. */
  workspaces: ReadonlyMap<string, WorkspaceSummary>
}

/**
 * What the server calls with the summaries. A class, because the server must receive a single stub
 * for the object. The server letting go of it (`Symbol.dispose`), which it does when the account
 * restarts and forgets its subscribers, is said through `onReleased`.
 */
class SummaryListener extends RpcTarget implements WorkspaceSummarySubscriber {
  constructor(
    private readonly onSnapshot: (summaries: WorkspaceSummary[]) => void,
    private readonly onUpdated: (workspaceId: string, summary: WorkspaceSummary | null) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async snapshot(summaries: WorkspaceSummary[]) {
    this.onSnapshot(summaries)
  }

  async updated(workspaceId: string, summary: WorkspaceSummary | null) {
    this.onUpdated(workspaceId, summary)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The part of the backend the summaries use. The subscribe call takes the listener itself, as a
 * call through a stub does, and its lease must be disposed.
 */
export type SummariesBackend = {
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToWorkspaceSummaries']>[0]): Promise<Disposable>
}

const UNKNOWN: SummariesSnapshot = { known: false, workspaces: new Map() }
// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * Every workspace's summary, live (`subscribeToWorkspaceSummaries()`), for the sidebar's and the
 * Library's counts of what waits on the user and the Automations page, without opening any
 * workspace. Observable through `subscribe`/`getSnapshot`.
 *
 * The subscription is the account's, so no workspace restarting breaks it. A failed one is tried
 * again with growing waits, and one the account forgot, as it does when it restarts, is made
 * again. Each new connection starts a subscription on this same store, keeping the summaries
 * shown until its snapshot comes in.
 */
export class WorkspaceSummaries {
  #snapshot = UNKNOWN
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

  start(backend: SummariesBackend) {
    this.#retryDelay = 0
    this.#subscribe(backend)
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    this.#releaseLease()
  }

  #subscribe(backend: SummariesBackend) {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#releaseLease()
    let live = false
    let released = false
    let hasSnapshot = false
    const listener = new SummaryListener(
      (summaries) => {
        if (run !== this.#run) return
        hasSnapshot = true
        this.#retryDelay = 0
        this.#publish({ known: true, workspaces: new Map(summaries.map((summary) => [summary.workspaceId, summary])) })
      },
      (workspaceId, summary) => {
        if (run !== this.#run || !hasSnapshot) return
        const workspaces = new Map(this.#snapshot.workspaces)
        if (summary) workspaces.set(workspaceId, summary)
        else workspaces.delete(workspaceId)
        this.#publish({ ...this.#snapshot, workspaces })
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
      () => {
        if (run !== this.#run) return
        // What was known stays shown meanwhile.
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

  #publish(snapshot: SummariesSnapshot) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }
}

/** How many asks wait on the user from one gadget (`WorkspaceWaiting.gadgets`). */
export const gadgetAsks = (snapshot: SummariesSnapshot, workspaceId: string, gadgetId: number) =>
  snapshot.workspaces.get(workspaceId)?.waiting.gadgets.find((each) => each.gadgetId === gadgetId)?.actions ?? 0

/** How many asks wait on the user from their gadgets, across every workspace. Each counts once. */
export const totalGadgetAsks = (snapshot: SummariesSnapshot) => {
  let total = 0
  for (const { waiting } of snapshot.workspaces.values()) for (const { actions } of waiting.gadgets) total += actions
  return total
}
