import { RpcTarget } from 'capnweb'
import {
  getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
  type GadgetBindingInfo,
  type GadgetClient,
  type GadgetFormat,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

/** The gadget, as the workspace describes it. */
export type GadgetSummary = Extract<WorkpieceSummary, { type: 'gadget' }>

/** One of the lists a gadget's settings show, as far as it has got. */
export type Listed<T> = { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'failed'; message: string }

export type GadgetSettingsSnapshot =
  | { status: 'loading' }
  /** The viewer has no access to its workspace. */
  | { status: 'denied' }
  /** There is no such gadget, or it was deleted. */
  | { status: 'gone' }
  | { status: 'failed'; message: string }
  | {
    status: 'ready'
    gadget: GadgetSummary
    /** What it is bound to, by the name its code knows each by (`env.NAME`). */
    bindings: Listed<GadgetBindingInfo>
  }

/** The part of a gadget the settings use, and the lease that must be disposed. */
export type SettingsGadget = Pick<GadgetClient, 'setTitle' | 'setOutput' | 'remove' | 'listBindings' | 'bindWithSuggestedName' | 'unbind' | 'createBlueprint' | 'getThumbnail' | 'setAutoApprove' | 'disallowActionKind'> & Disposable

/** The part of a workspace's Overseer the settings use, and the lease that must be disposed. */
export type SettingsOverseer = {
  getGadget(id: number): SettingsGadget
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber & RpcTarget): Promise<Disposable>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type GadgetSettingsOptions = {
  /** The app's connection, which may be `down`: what fails meanwhile is not said, as `restart()` follows. */
  connection?: { readonly down: boolean }
}

const LOADING: GadgetSettingsSnapshot = { status: 'loading' }
// The most a blueprint's picture may be, as the server takes it.
const MAX_PICTURE_BYTES = 1024 * 1024
// After the workspace was lost, how long until it is opened again.
const RETRY_DELAY = 1000
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const failed = (error: unknown) => ({ status: 'failed', message: messageOf(error) }) as const

/** What the server calls as the workspace's workpieces change: here, the one gadget (`null` once it is gone, or with `ready` once all were listed). */
export class SummaryListener extends RpcTarget implements WorkpiecesSubscriber {
  constructor(private readonly id: number, private readonly changed: (summary: GadgetSummary | null, ready?: true) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (summary.id === this.id && summary.type === 'gadget') this.changed(summary)
  }

  removed(id: number) {
    if (id === this.id) this.changed(null)
  }

  ready() {
    this.changed(null, true)
  }
}

/**
 * One gadget's settings, live: what it is (`subscribeToWorkpieces()`, so a new title shows as it is
 * given, wherever) and what it is bound to, with what can be done to each. Its automations are an
 * `AutomationsList`'s.
 * Observable through `subscribe`/`getSnapshot`. Nothing happens until `start()`; `stop()` lets the
 * workspace go, and `restart()` starts over on a new connection, keeping what is shown meanwhile.
 *
 * Its actions reject with why they did not happen, for whoever asked to say so; what they change
 * comes back through the subscription, or through the list being read again.
 */
export class GadgetSettings {
  #snapshot: GadgetSettingsSnapshot = LOADING
  #listeners = new Set<() => void>()
  #overseer: SettingsOverseer | undefined
  #gadget: SettingsGadget | undefined
  #lease: Promise<Disposable> | undefined
  // Bumped by every start and stop, so what a run asked for can tell it is stale.
  #run = 0
  // Seen in this run: the gadget, and the end of the first listing.
  #seen = false
  #retry: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly open: () => SettingsOverseer,
    private readonly workpieceId: number,
    private readonly options: GadgetSettingsOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    const run = ++this.#run
    this.#seen = false
    let overseer: SettingsOverseer
    try {
      overseer = this.#overseer = this.open()
    } catch (error) {
      this.#failed(error)
      return
    }
    this.#gadget = overseer.getGadget(this.workpieceId)
    this.#lease = overseer.subscribeToWorkpieces(new SummaryListener(this.workpieceId, (summary, ready) => {
      if (run !== this.#run) return
      if (summary) {
        const first = !this.#seen
        this.#seen = true
        const current = this.#snapshot
        this.#publish(current.status === 'ready' ? { ...current, gadget: summary } : { status: 'ready', gadget: summary, bindings: { status: 'loading' } })
        if (first) this.#readLists(run)
      } else if (!ready || !this.#seen) {
        this.#publish({ status: 'gone' })
      }
    }))
    this.#lease.catch((error: unknown) => {
      if (run === this.#run) this.#failed(error)
    })
    // Last, as it can be called at once, for a workspace that cannot be reached.
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
    void this.#lease?.then((lease) => lease[Symbol.dispose](), () => {})
    this.#gadget?.[Symbol.dispose]()
    this.#overseer?.[Symbol.dispose]()
    this.#lease = this.#gadget = this.#overseer = undefined
  }

  /** Starts over, as on a new connection, with what is shown left up until it is read again. */
  restart() {
    this.stop()
    this.start()
  }

  rename = (title: string) => this.#with((gadget) => gadget.setTitle(title))

  /** Says what it is, such as a Dashboard, and its icon; with `null`, that it is a plain app. */
  setKind = (format: GadgetFormat | null) => this.#with((gadget) => gadget.setOutput(format))

  /**
   * Lets it make any change its services let go ahead unasked, whoever uses it (`true`), or has it
   * ask again except for what was allowed one kind at a time.
   */
  setAllowEverything = (on: boolean) => this.#with((gadget) => gadget.setAutoApprove(on))

  /** Has changes of this kind through this connection ask again. */
  askAgain = (gatekeeperId: number, tag: string) => this.#with((gadget) => gadget.disallowActionKind(gatekeeperId, tag))

  /** Deletes it, for everyone. */
  remove = () => this.#with((gadget) => gadget.remove())

  /**
   * A picture of it as its code draws it (`getThumbnail`, a JPEG), for the blueprint it is
   * published as; null when it has none, or it cannot be drawn.
   */
  picture = () => this.#with((gadget) => gadget.getThumbnail())

  /**
   * Publishes its code as a blueprint, which anyone can start their own from, with its `picture`
   * where it has one the server takes. Resolves to the blueprint.
   */
  publish = (title: string, description: string, picture?: Uint8Array | null) => this.#with((gadget) => gadget.createBlueprint(
    title,
    description,
    picture && picture.byteLength <= MAX_PICTURE_BYTES ? { mimeType: 'image/jpeg', content: picture } : undefined,
  ))

  /** Binds a connection of the workspace's into it, under the name its resource suggests; resolves to that name. */
  bind = async (gatekeeperId: number) => {
    const name = await this.#with((gadget) => gadget.bindWithSuggestedName(gatekeeperId))
    this.#readLists(this.#run)
    return name
  }

  /** Takes a binding away from it, leaving what it was bound to in the workspace. */
  unbind = async (name: string) => {
    await this.#with((gadget) => gadget.unbind(name))
    this.#readLists(this.#run)
  }

  #with<T>(call: (gadget: SettingsGadget) => Promise<T>) {
    if (!this.#gadget) return Promise.reject(new Error('The gadget is still loading.'))
    return call(this.#gadget)
  }

  #readLists(run: number) {
    const gadget = this.#gadget
    if (!gadget) return
    gadget.listBindings().then(
      (items) => this.#update(run, { bindings: { status: 'ready', items } }),
      (error: unknown) => this.#update(run, { bindings: failed(error) }),
    )
  }

  #update(run: number, lists: { bindings?: Listed<GadgetBindingInfo> }) {
    const current = this.#snapshot
    if (run !== this.#run || current.status !== 'ready') return
    // Over a lost connection, what was read stays up until it is read again.
    if (this.options.connection?.down && Object.values(lists).some(({ status }) => status === 'failed')) return
    this.#publish({ ...current, ...lists })
  }

  #failed(error: unknown) {
    if (this.options.connection?.down) return
    const code = getOpenWorkspaceErrorCode(error)
    this.#publish(
      code === OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied ? { status: 'denied' }
        : code === OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound ? { status: 'gone' }
          : { status: 'failed', message: messageOf(error) },
    )
  }

  #publish(snapshot: GadgetSettingsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
