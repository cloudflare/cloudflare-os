import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, UnreadStateSubscriber, UnreadSummaryUpdate, UserUnreadState } from '@gadgets/workshop-shared/api'

/**
 * What the viewer has not read, by workspace: how many messages wait in each workspace's chats
 * whose notifications are on. A workspace with nothing waiting is not in `workspaces`. `known` is
 * false until the account has said, when nothing is marked.
 */
export type UnreadTotals = {
  known: boolean
  /** Unread messages across every workspace. */
  total: number
  /** Unread messages in each workspace that has any, by its id. */
  workspaces: ReadonlyMap<string, number>
}

/**
 * What the server calls with the viewer's unread totals. A class, because the server must receive
 * a single stub for the object. The server letting go of it (`Symbol.dispose`), which it does when
 * the account restarts and forgets its subscribers, is said through `onReleased`.
 */
class SummaryListener extends RpcTarget implements UnreadStateSubscriber {
  constructor(
    private readonly onState: (state: UserUnreadState) => void,
    private readonly onSummary: (summary: UnreadSummaryUpdate) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async updated(state: UserUnreadState) {
    this.onState(state)
  }

  async summaryUpdated(summary: UnreadSummaryUpdate) {
    this.onSummary(summary)
  }

  async chatUpdated(_workspaceId: string, _chatId: number, _chat: unknown, summary: UnreadSummaryUpdate) {
    this.onSummary(summary)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The part of the backend the totals use. The subscribe call takes the listener itself, as a call
 * through a stub does, and its lease must be disposed.
 */
export type UnreadBackend = {
  /** Subscribes to the viewer's unread totals, with no chat's own rows (the `summary` scope). */
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToUnreadState']>[1]): Promise<Disposable>
}

const UNKNOWN: UnreadTotals = { known: false, total: 0, workspaces: new Map() }
// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * The viewer's unread totals, live (`subscribeToUnreadState('summary')`), for the marks on the
 * workspaces that have something new. Observable through `subscribe`/`getSnapshot`.
 *
 * The subscription is the account's, not a workspace's, so no workspace restarting breaks it. A
 * failed one is tried again with growing waits, and one the account forgot, as it does when it
 * restarts, is made again; a new connection makes a new one, through a new instance.
 */
export class UnreadSummary {
  #snapshot = UNKNOWN
  #listeners = new Set<() => void>()
  #lease: Promise<Disposable> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = 0
  // Bumped by every subscription and stop(), so a call from an earlier one can tell it is stale.
  #run = 0

  constructor(private readonly backend: UnreadBackend) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  start() {
    this.#retryDelay = 0
    this.#subscribe()
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    this.#releaseLease()
  }

  #subscribe() {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#releaseLease()
    let live = false
    let released = false
    const listener = new SummaryListener(
      (state) => {
        if (run !== this.#run) return
        this.#retryDelay = 0
        this.#publish({ known: true, total: state.unreadMessageCount, workspaces: new Map(state.workspaces.map(({ workspaceId, unreadMessageCount }) => [workspaceId, unreadMessageCount])) })
      },
      ({ unreadMessageCount, workspace }) => {
        if (run !== this.#run || !this.#snapshot.known) return
        const workspaces = new Map(this.#snapshot.workspaces)
        if (workspace.unreadMessageCount > 0) workspaces.set(workspace.workspaceId, workspace.unreadMessageCount)
        else workspaces.delete(workspace.workspaceId)
        this.#publish({ known: true, total: unreadMessageCount, workspaces })
      },
      () => {
        released = true
        // Let go of after it took, while still the current one: the account forgot it.
        if (live && run === this.#run) this.#subscribe()
      },
    )
    const lease = this.backend.subscribe(listener)
    this.#lease = lease
    lease.then(
      () => {
        if (run !== this.#run) return
        live = true
        if (released) this.#subscribe()
      },
      () => {
        if (run !== this.#run) return
        // What was known stays shown meanwhile.
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

  #publish(snapshot: UnreadTotals) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }
}
