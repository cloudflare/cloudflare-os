import type { ActionHistoryPage, ActionLogEntry, ActionsSubscriber, AiChatMetadata, ChatListOptions, GadgetClient } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { RpcTarget } from 'capnweb'
import { ActionUpdates } from '@/chat/ChatSubscriber'
import { agentsOf, targetsOf, type Ask } from './askGroups'

/** The part of a gadget this uses, and the lease that must be disposed. */
export type AsksGadget = Pick<GadgetClient, 'listBindings'> & Disposable

/** The part of a workspace's Overseer this uses, and the lease that must be disposed. */
export type AsksOverseer = {
  getGadget(id: number): AsksGadget
  subscribeToActions(subscriber: ActionsSubscriber & RpcTarget): Promise<Disposable>
  listActions(options?: { beforeId?: number; filter?: 'pending' }): Promise<ActionHistoryPage>
  listChats(options?: ChatListOptions): Promise<Pick<AiChatMetadata, 'id' | 'spawnerName' | 'spawnedByGadgetId'>[]>
  approveAction(id: number): Promise<void>
  rejectAction(id: number): Promise<void>
  setAutoApprovedActionKind(gatekeeperId: number, actionKind: ActionKind): Promise<void>
  removeAutoApprovedActionKind(gatekeeperId: number, tag: string): Promise<void>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type GadgetAsksSnapshot =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** Everything waiting in the workspace, oldest first, for `isAskOf` to sort. */
      pending: Ask[]
      /** What the gadget's bindings reach, for what it asks from the chat it is shown from. */
      targets: ReadonlySet<number>
      /** The service each of them is of, by what it reaches, for drawing an ask by its logo. */
      vendors: ReadonlyMap<number, string | undefined>
      /** The chats of the agents it started, with what their spawner calls them. */
      agents: ReadonlyMap<number, string | undefined>
    }

export type GadgetAsksOptions = {
  /** The chat it is shown from, whose connections not yet kept it reaches too (`listBindings(chatId)`). */
  chatId?: number
  /** The app's connection, which may be `down`: `restart()` follows once it is back. */
  connection?: { readonly down: boolean }
}

/**
 * How long an ask that arrives while the gadget is open is held back: one a standing rule lets
 * through is pending only until the workspace applies it, which should not flash an ask.
 */
export const HOLD_MS = 1000

const LOADING: GadgetAsksSnapshot = { status: 'loading' }
// After the workspace was lost, or could not be read, how long until it is opened again.
const RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 30_000

const notPending = (error: unknown) => /not pending/i.test(error instanceof Error ? error.message : String(error))

/**
 * What one gadget is waiting on someone for, live: every action waiting in its workspace
 * (`subscribeToActions()` over `listActions({ filter: 'pending' })`), with what tells the
 * gadget's from the rest (`isAskOf`): the agents it started, read again when something arrives
 * from a chat not yet known, and what its bindings reach, read again when something arrives
 * through a connection not among them, as one just kept would be. Observable through
 * `subscribe`/`getSnapshot`. Nothing happens until `start()`; `stop()` lets the workspace go, and
 * `restart()` starts over on a new connection, keeping what is shown meanwhile.
 *
 * Someone who only uses the gadget is told nothing waits, as the workspace tells them. The
 * decisions reject with why they did not go; what they change comes back through the subscription.
 */
export class GadgetAsks {
  #snapshot: GadgetAsksSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: AsksOverseer | undefined
  #gadget: AsksGadget | undefined
  #lease: Promise<Disposable> | undefined
  // Bumped by every start and stop, so what a run asked for can tell it is stale.
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined
  #failures = 0
  // By id, so that a delta that arrives before the listing does is kept, and only what is pending.
  #pending = new Map<number, Ask>()
  #held = new Map<number, ReturnType<typeof setTimeout>>()
  #targets: ReadonlySet<number> = new Set()
  #vendors: ReadonlyMap<number, string | undefined> = new Map()
  #chats: Pick<AiChatMetadata, 'id' | 'spawnerName' | 'spawnedByGadgetId'>[] = []
  #listed = false
  #reading: { chats?: Promise<void>; bindings?: Promise<void> } = {}

  constructor(
    private readonly open: () => AsksOverseer,
    private readonly workpieceId: number,
    private readonly options: GadgetAsksOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    let overseer: AsksOverseer
    try {
      overseer = this.#overseer = this.open()
    } catch {
      this.#retryLater(run)
      return
    }
    this.#gadget = overseer.getGadget(this.workpieceId)
    this.#pending = new Map()
    this.#listed = false
    this.#reading = {}
    // Subscribed before the listing, so that nothing slips between them.
    this.#lease = overseer.subscribeToActions(new ActionUpdates((entry) => {
      if (run === this.#run) this.#arrived(entry, run)
    }))
    this.#lease.catch(() => {})
    void this.#list(overseer, run)
    // Last, as it can be called at once, for a workspace that cannot be reached.
    overseer.onRpcBroken(() => {
      if (run === this.#run && !this.options.connection?.down) this.#retryLater(run)
    })
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    for (const timer of this.#held.values()) clearTimeout(timer)
    this.#held.clear()
    void this.#lease?.then((lease) => lease[Symbol.dispose](), () => {})
    this.#gadget?.[Symbol.dispose]()
    this.#overseer?.[Symbol.dispose]()
    this.#lease = this.#gadget = this.#overseer = undefined
  }

  restart() {
    this.stop()
    this.start()
  }

  /** Approves these, oldest first, so that a change never lands before one it builds on. */
  approve = async (asks: readonly Ask[]) => {
    const overseer = this.#ready()
    for (const { id } of asks.toSorted((a, b) => a.id - b.id)) {
      if (this.#pending.has(id)) await overseer.approveAction(id)
    }
  }

  /** Denies these, newest first, so that none is left building on one denied. */
  deny = async (asks: readonly Ask[]) => {
    const overseer = this.#ready()
    for (const { id } of asks.toSorted((a, b) => b.id - a.id)) {
      if (this.#pending.has(id)) await overseer.rejectAction(id)
    }
  }

  /**
   * Lets anything in the workspace do this kind of thing through this connection from now on
   * without asking, which the workspace applies to those of the kind waiting that it can at once.
   * The rest, held behind something else waiting on the connection, are approved here.
   */
  allow = async (gatekeeperId: number, actionKind: ActionKind, asks: readonly Ask[]) => {
    const overseer = this.#ready()
    await overseer.setAutoApprovedActionKind(gatekeeperId, actionKind)
    for (const { id } of asks.toSorted((a, b) => a.id - b.id)) {
      if (!this.#pending.has(id)) continue
      await overseer.approveAction(id).catch((error: unknown) => {
        // The workspace got there first.
        if (!notPending(error)) throw error
      })
    }
  }

  /** Takes back what `allow` gave: this kind is asked about again. */
  disallow = async (gatekeeperId: number, actionKind: ActionKind) => {
    await this.#ready().removeAutoApprovedActionKind(gatekeeperId, actionKind.tag)
  }

  #arrived(entry: ActionLogEntry, run: number) {
    if (entry.type !== 'action') return
    if (entry.state !== 'pending') {
      clearTimeout(this.#held.get(entry.id))
      this.#held.delete(entry.id)
      if (this.#pending.delete(entry.id)) this.#publishReady()
      return
    }
    const known = this.#pending.has(entry.id)
    this.#pending.set(entry.id, entry)
    if (!known && this.#listed) {
      this.#held.set(entry.id, setTimeout(() => {
        this.#held.delete(entry.id)
        this.#publishReady()
      }, HOLD_MS))
    }
    const overseer = this.#overseer
    if (!overseer) return
    // From a chat not yet known, which may be an agent the gadget just started; or through a
    // connection it was not known to have, which may have just been kept.
    const { chatId, gatekeeperId } = entry
    if (chatId !== undefined && !this.#chats.some(({ id }) => id === chatId)) this.#readChats(overseer, run).catch(() => {})
    if (chatId === undefined && gatekeeperId !== undefined && !this.#targets.has(gatekeeperId)) this.#readBindings(run).catch(() => {})
    this.#publishReady()
  }

  async #list(overseer: AsksOverseer, run: number) {
    try {
      const reads = Promise.all([this.#readChats(overseer, run), this.#readBindings(run)])
      let beforeId: number | undefined
      const listed: Ask[] = []
      do {
        const page = await overseer.listActions({ beforeId, filter: 'pending' })
        if (run !== this.#run) return
        for (const entry of page.entries) if (entry.type === 'action' && entry.state === 'pending') listed.push(entry)
        beforeId = page.nextBeforeId
      } while (beforeId !== undefined)
      await reads
      if (run !== this.#run) return
      // A delta that arrived meanwhile is newer than the listing.
      for (const entry of listed) if (!this.#pending.has(entry.id)) this.#pending.set(entry.id, entry)
      this.#listed = true
      this.#failures = 0
      this.#publishReady()
    } catch {
      if (run === this.#run) this.#retryLater(run)
    }
  }

  // The runs alone, as only a run is started by a gadget (`spawnedByGadgetId`).
  #readChats(overseer: AsksOverseer, run: number): Promise<void> {
    this.#reading.chats ??= overseer.listChats({ kind: 'runs' }).then((chats) => {
      if (run !== this.#run) return
      this.#chats = chats
      this.#publishReady()
    }).finally(() => {
      if (run === this.#run) this.#reading.chats = undefined
    })
    return this.#reading.chats
  }

  #readBindings(run: number): Promise<void> {
    const gadget = this.#gadget
    if (!gadget) return Promise.resolve()
    this.#reading.bindings ??= gadget.listBindings(this.options.chatId).then((bindings) => {
      if (run !== this.#run) return
      this.#targets = targetsOf(bindings)
      this.#vendors = new Map(bindings.map(({ target, vendorId }) => [target, vendorId]))
      this.#publishReady()
    }).finally(() => {
      if (run === this.#run) this.#reading.bindings = undefined
    })
    return this.#reading.bindings
  }

  #retryLater(run: number) {
    clearTimeout(this.#retry)
    const delay = Math.min(RETRY_DELAY * 2 ** this.#failures++, MAX_RETRY_DELAY)
    this.#retry = setTimeout(() => {
      if (run === this.#run) this.restart()
    }, delay)
  }

  #ready() {
    if (!this.#overseer || !this.#listed) throw new Error('The gadget is still loading.')
    return this.#overseer
  }

  #publishReady() {
    if (!this.#listed) return
    const pending = [...this.#pending.values()].filter(({ id }) => !this.#held.has(id)).toSorted((a, b) => a.id - b.id)
    this.#snapshot = { status: 'ready', pending, targets: this.#targets, vendors: this.#vendors, agents: agentsOf(this.#chats, this.workpieceId) }
    for (const listener of this.#listeners) listener()
  }
}
