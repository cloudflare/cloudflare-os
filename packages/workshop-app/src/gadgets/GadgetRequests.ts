import { RpcTarget } from 'capnweb'
import type {
  ActionHistoryPage,
  ActionLogEntry,
  ActionsSubscriber,
  AiChatMetadata,
  GadgetBindingInfo,
  GadgetClient,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { SummaryListener, type GadgetSummary } from './GadgetSettings'

/** One of the gadget's actions, or its agents', waiting for someone to decide it. */
export type GadgetRequest = Extract<ActionLogEntry, { type: 'action' }>

/** An agent the gadget's code started through its spawner (`AiChatMetadata.spawnedByGadgetId`), which acts for it. */
export type GadgetAgent = {
  chatId: number
  /** Its conversation's title. */
  title: string
  /** What its spawner calls such agents: "Joke writer". */
  name?: string
}

export type GadgetRequestsSnapshot = {
  /** The gadget, once the workspace has said; absent for a viewer who only uses it. */
  gadget?: GadgetSummary
  /**
   * Its actions waiting, and its agents', oldest first: not those it made while shown in a chat,
   * which that chat shows.
   */
  waiting: GadgetRequest[]
  /** The agents its code started, by their chat's id, for saying whose a request is. */
  agents: ReadonlyMap<number, GadgetAgent>
  /** The connection each binding of the gadget's reaches, by its id, for naming the service. */
  vendors: ReadonlyMap<number, string | undefined>
}

/** The part of a gadget this uses, and the lease that must be disposed. */
export type RequestsGadget = Pick<GadgetClient, 'allowActionKind' | 'listBindings'> & Disposable

/** The part of a workspace's Overseer this uses, and the lease that must be disposed. */
export type RequestsOverseer = {
  getGadget(id: number): RequestsGadget
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber & RpcTarget): Promise<Disposable>
  subscribeToActions(subscriber: ActionsSubscriber & RpcTarget): Promise<Disposable>
  listActions(options?: { beforeId?: number; filter?: 'pending' }): Promise<ActionHistoryPage>
  listChats(): Promise<Pick<AiChatMetadata, 'id' | 'title' | 'spawnerName' | 'spawnedByGadgetId'>[]>
  approveAction(id: number): Promise<void>
  rejectAction(id: number): Promise<void>
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type GadgetRequestsOptions = {
  /** The app's connection, which may be `down`: `restart()` follows once it is back. */
  connection?: { readonly down: boolean }
}

/**
 * How long one that arrives while the gadget is open is held back: what the gadget is allowed
 * to do is pending only until the server lets it through, which should not flash an ask.
 */
export const HOLD_MS = 1000

const EMPTY: GadgetRequestsSnapshot = { waiting: [], agents: new Map(), vendors: new Map() }
const RETRY_DELAY = 1000

/** Whether `entry` is one of `gadgetId`'s own actions, made outside any chat. */
export const isOwnRequest = (entry: ActionLogEntry, gadgetId: number): entry is GadgetRequest =>
  entry.type === 'action' && entry.gadgetId === gadgetId && entry.chatId === undefined

class ActionsListener extends RpcTarget implements ActionsSubscriber {
  constructor(private readonly changed: (entry: ActionLogEntry) => void) {
    super()
  }

  entry(record: ActionLogEntry) {
    this.changed(record)
  }

  ready() {}
}

/**
 * What one gadget is waiting on a person for, live: its actions made while someone used it or a
 * hook woke it, and those of the agents its code started, which act for it (`subscribeToActions()`
 * over `listActions()`, with `listChats()` read again for an action from a chat not yet known, as
 * one a click just started is), with what the gadget is and
 * what it may already do (`subscribeToWorkpieces()`). Observable through `subscribe`/`getSnapshot`.
 * Nothing happens until `start()`; `stop()` lets the workspace go, and `restart()` starts over on
 * a new connection, keeping what is shown meanwhile.
 *
 * The decisions reject with why they did not go; what they change comes back through the
 * subscriptions.
 */
export class GadgetRequests {
  #snapshot: GadgetRequestsSnapshot = EMPTY
  #listeners = new Set<() => void>()
  #overseer: RequestsOverseer | undefined
  #gadget: RequestsGadget | undefined
  #leases: Promise<Disposable>[] = []
  #run = 0
  #retry: ReturnType<typeof setTimeout> | undefined
  // By id, so a delta that arrives before the listing does is kept.
  #byId = new Map<number, GadgetRequest>()
  // Arrived while open, and not shown until HOLD_MS has passed (see HOLD_MS).
  #held = new Map<number, ReturnType<typeof setTimeout>>()
  // The chats its code started, and those known not to be; while they are read, what arrives
  // waits in order to be sorted by them.
  #agents = new Map<number, GadgetAgent>()
  #others = new Set<number>()
  #learning: Promise<void> | undefined
  #queued: ActionLogEntry[] = []

  constructor(
    private readonly open: () => RequestsOverseer,
    private readonly workpieceId: number,
    private readonly options: GadgetRequestsOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    let overseer: RequestsOverseer
    try {
      overseer = this.#overseer = this.open()
    } catch {
      return
    }
    const gadget = (this.#gadget = overseer.getGadget(this.workpieceId))
    this.#byId = new Map()
    this.#agents = new Map()
    this.#others = new Set()
    this.#queued = []
    this.#learning = undefined
    // Subscribed before the listing, so nothing slips between them.
    this.#leases = [
      overseer.subscribeToActions(new ActionsListener((entry) => {
        if (run === this.#run) this.#arrived(entry, overseer, run)
      })),
      overseer.subscribeToWorkpieces(new SummaryListener(this.workpieceId, (summary) => {
        if (run === this.#run && summary) this.#publish({ ...this.#snapshot, gadget: summary })
      })),
    ]
    for (const lease of this.#leases) lease.catch(() => {})
    void this.#list(overseer, run)
    // Only someone who builds in the workspace is told which connections it reaches; a viewer
    // who only uses it has nothing to decide.
    gadget.listBindings().then(
      (bindings: GadgetBindingInfo[]) => {
        if (run !== this.#run) return
        this.#publish({ ...this.#snapshot, vendors: new Map(bindings.map(({ target, vendorId }) => [target, vendorId])) })
      },
      () => {},
    )
    overseer.onRpcBroken(() => {
      if (run !== this.#run || this.options.connection?.down) return
      clearTimeout(this.#retry)
      this.#retry = setTimeout(() => {
        if (run === this.#run) this.restart()
      }, RETRY_DELAY)
    })
  }

  stop() {
    this.#run++
    clearTimeout(this.#retry)
    for (const lease of this.#leases) void lease.then((held) => held[Symbol.dispose](), () => {})
    this.#gadget?.[Symbol.dispose]()
    this.#overseer?.[Symbol.dispose]()
    this.#leases = []
    this.#gadget = this.#overseer = undefined
    for (const timer of this.#held.values()) clearTimeout(timer)
    this.#held.clear()
  }

  restart() {
    this.stop()
    this.start()
  }

  /** Approves these, oldest first, so a change never lands before the one it builds on. */
  approve = async (requests: readonly GadgetRequest[]) => {
    const overseer = this.#ready()
    for (const request of requests.toSorted((a, b) => a.id - b.id)) await overseer.approveAction(request.id)
  }

  /** Denies these, newest first. */
  deny = async (requests: readonly GadgetRequest[]) => {
    const overseer = this.#ready()
    for (const request of requests.toSorted((a, b) => b.id - a.id)) await overseer.rejectAction(request.id)
  }

  /**
   * Lets the gadget make changes of this kind through this connection from now on, without
   * asking, and approves these, which are of that kind. The server applies those it can at once;
   * the rest, held behind something else waiting on the connection, are approved here.
   */
  allow = async (gatekeeperId: number, actionKind: ActionKind, requests: readonly GadgetRequest[]) => {
    const gadget = this.#gadget
    if (!gadget) throw new Error('The gadget is still loading.')
    await gadget.allowActionKind(gatekeeperId, actionKind)
    const overseer = this.#ready()
    for (const request of requests.toSorted((a, b) => a.id - b.id)) {
      if (this.#byId.get(request.id)?.state !== 'pending') continue
      await overseer.approveAction(request.id).catch((error: unknown) => {
        // The server got there first.
        if (!/not pending/i.test(error instanceof Error ? error.message : String(error))) throw error
      })
    }
  }

  // Whether it is the gadget's, or an agent's it started.
  #mine(entry: ActionLogEntry): entry is GadgetRequest {
    if (entry.type !== 'action') return false
    const { chatId } = entry
    return (chatId !== undefined && this.#agents.has(chatId)) || isOwnRequest(entry, this.workpieceId)
  }

  #arrived(entry: ActionLogEntry, overseer: RequestsOverseer, run: number) {
    if (entry.type !== 'action') return
    const { chatId } = entry
    if (this.#learning) {
      this.#queued.push(entry)
    } else if (this.#mine(entry)) {
      this.#take([entry])
    } else if (chatId !== undefined && !this.#others.has(chatId)) {
      // From a chat not yet known, which may be an agent the gadget just started.
      this.#queued.push(entry)
      void this.#learn(overseer, run)
    }
  }

  // Reads which chats the gadget's code started, then sorts what arrived meanwhile, in order.
  #learn(overseer: RequestsOverseer, run: number): Promise<void> {
    this.#learning ??= overseer.listChats().then(
      (chats) => {
        if (run !== this.#run) return
        for (const { id, title, spawnerName, spawnedByGadgetId } of chats) {
          if (spawnedByGadgetId === this.workpieceId) this.#agents.set(id, { chatId: id, title, name: spawnerName })
          else this.#others.add(id)
        }
        this.#publish({ ...this.#snapshot, agents: new Map(this.#agents) })
      },
      // A viewer who only uses the gadget cannot list its chats, and decides nothing.
      () => {},
    ).finally(() => {
      if (run !== this.#run) return
      this.#learning = undefined
      const queued = this.#queued
      this.#queued = []
      this.#take(queued.filter((entry) => this.#mine(entry)))
    })
    return this.#learning
  }

  async #list(overseer: RequestsOverseer, run: number) {
    let beforeId: number | undefined
    try {
      await this.#learn(overseer, run)
      do {
        const page = await overseer.listActions({ beforeId, filter: 'pending' })
        if (run !== this.#run) return
        this.#take(page.entries.filter((entry) => this.#mine(entry)), true)
        beforeId = page.nextBeforeId
      } while (beforeId !== undefined)
    } catch {
      // A viewer who only uses the gadget is told nothing waits; anything else is read again on restart.
    }
  }

  // Listed entries never overwrite a newer delta for the same action.
  #take(entries: readonly GadgetRequest[], listed = false) {
    for (const entry of entries) {
      if (listed && this.#byId.has(entry.id)) continue
      if (!listed && !this.#byId.has(entry.id) && entry.state === 'pending') {
        this.#held.set(entry.id, setTimeout(() => {
          this.#held.delete(entry.id)
          this.#publishWaiting()
        }, HOLD_MS))
      }
      this.#byId.set(entry.id, entry)
    }
    this.#publishWaiting()
  }

  #publishWaiting() {
    const waiting = [...this.#byId.values()]
      .filter((entry) => entry.state === 'pending' && !this.#held.has(entry.id))
      .toSorted((a, b) => a.id - b.id)
    this.#publish({ ...this.#snapshot, waiting })
  }

  #ready() {
    if (!this.#overseer) throw new Error('The gadget is still loading.')
    return this.#overseer
  }

  #publish(snapshot: GadgetRequestsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
