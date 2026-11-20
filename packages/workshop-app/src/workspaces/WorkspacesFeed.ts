import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, WorkspaceMetadataWithTimestamps, WorkspacesSubscriber } from '@gadgets/workshop-shared/api'
import { sameLiveFields, type LiveWorkspaceFields } from './LiveWorkspace'

export type WorkspacesState =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceMetadataWithTimestamps[] }
  | { status: 'failed'; message: string }

/**
 * What the server calls with the list. A class, because the server must receive a single stub for
 * the object. The server letting go of it (`Symbol.dispose`), which it does when the account
 * restarts and forgets its subscribers, is said through `onReleased`.
 */
class ListListener extends RpcTarget implements WorkspacesSubscriber {
  constructor(
    private readonly onSnapshot: (workspaces: WorkspaceMetadataWithTimestamps[]) => void,
    private readonly onUpdated: (workspaceId: string, workspace: WorkspaceMetadataWithTimestamps | null) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async snapshot(workspaces: WorkspaceMetadataWithTimestamps[]) {
    this.onSnapshot(workspaces)
  }

  async updated(workspaceId: string, workspace: WorkspaceMetadataWithTimestamps | null) {
    this.onUpdated(workspaceId, workspace)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The part of the backend the list uses. The subscribe call takes the listener itself, as a call
 * through a stub does, and its lease must be disposed.
 */
export type ListBackend = {
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToWorkspaces']>[0]): Promise<Disposable>
}

// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * The user's workspaces, live (`subscribeToWorkspaces()`), most recently active first: what another
 * tab or device adds, removes, renames, stars, orders, mutes or draws differently shows here as it
 * happens. Observable through `subscribe`/`getSnapshot`.
 *
 * A change made here shows at once (`mark`), and what the account says next replaces it. What an
 * open workspace says of itself that the list does not keep (`LiveWorkspaceFields`) is laid over
 * its row (`live`).
 *
 * A failed subscription is tried again with growing waits, and one the account forgot, as it does
 * when it restarts, is made again. Each new connection is started anew (`start`), keeping the list
 * shown meanwhile.
 */
export class WorkspacesFeed {
  #state: WorkspacesState = { status: 'loading' }
  // What the account said, with the changes made here since, by id.
  #rows: ReadonlyMap<string, WorkspaceMetadataWithTimestamps> | undefined
  #liveFields = new Map<string, LiveWorkspaceFields>()
  #listeners = new Set<() => void>()
  #backend: ListBackend | undefined
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

  getSnapshot = () => this.#state

  start(backend: ListBackend) {
    this.#backend = backend
    this.#retryDelay = 0
    this.#subscribe()
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    this.#releaseLease()
  }

  /** Shows `change` on one workspace at once, until the account says otherwise. */
  mark(id: string, change: Partial<WorkspaceMetadataWithTimestamps>) {
    const row = this.#rows?.get(id)
    if (row) this.#publish(new Map(this.#rows).set(id, { ...row, ...change }))
  }

  /**
   * What the open workspace says of itself that the list does not keep. What it says again
   * unchanged changes nothing. Stable, for the subscription that calls it.
   */
  live = (id: string, fields: LiveWorkspaceFields) => {
    const known = this.#liveFields.get(id)
    if (known && sameLiveFields(known, fields)) return
    this.#liveFields.set(id, fields)
    if (this.#rows) this.#publish(this.#rows)
  }

  #subscribe() {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#releaseLease()
    let live = false
    let released = false
    const listener = new ListListener(
      (workspaces) => {
        if (run !== this.#run) return
        this.#retryDelay = 0
        this.#publish(new Map(workspaces.map((workspace) => [workspace.id, workspace])))
      },
      (workspaceId, workspace) => {
        if (run !== this.#run || !this.#rows) return
        const rows = new Map(this.#rows)
        if (workspace) rows.set(workspaceId, workspace)
        else rows.delete(workspaceId)
        this.#publish(rows)
      },
      () => {
        released = true
        // Let go of after it took, while still the current one: the account forgot it.
        if (live && run === this.#run) this.#subscribe()
      },
    )
    const lease = this.#backend!.subscribe(listener)
    this.#lease = lease
    lease.then(
      () => {
        if (run !== this.#run) return
        live = true
        if (released) this.#subscribe()
      },
      (error: unknown) => {
        if (run !== this.#run) return
        // What was listed stays shown meanwhile.
        if (!this.#rows) this.#setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
        const delay = this.#retryDelay || RETRY_DELAY.first
        this.#retryDelay = Math.min(delay * 2, RETRY_DELAY.most)
        this.#retry = setTimeout(() => {
          if (run === this.#run) this.#subscribe()
        }, delay)
      },
    )
  }

  #releaseLease() {
    void this.#lease?.then((held) => held[Symbol.dispose](), () => {})
    this.#lease = undefined
  }

  #publish(rows: ReadonlyMap<string, WorkspaceMetadataWithTimestamps>) {
    this.#rows = rows
    const workspaces = [...rows.values()]
      .map((workspace) => {
        const fields = this.#liveFields.get(workspace.id)
        return fields ? { ...workspace, ...fields } : workspace
      })
      .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
    this.#setState({ status: 'ready', workspaces })
  }

  #setState(state: WorkspacesState) {
    this.#state = state
    this.#listeners.forEach((listener) => listener())
  }
}
