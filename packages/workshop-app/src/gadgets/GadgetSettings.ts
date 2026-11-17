import { RpcTarget } from 'capnweb'
import {
  getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
  type GadgetBindingInfo,
  type GadgetClient,
  type GadgetSummary,
  type GatekeeperCreationSpec,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

export type { GadgetSummary }

/**
 * One of what a gadget is bound to, with what it is: a service's resource, an agent the gadget
 * can start, or a model its code can call, each by the name its code knows it by (`env.NAME`).
 */
export type GadgetBinding = GadgetBindingInfo & {
  kind: 'service' | 'agent' | 'model'
  /** The model an agent thinks with, or the model itself, by name; absent where it has none. */
  model?: string
}

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
      /** What it is bound to. */
      bindings: Listed<GadgetBinding>
    }

/** The part of a gadget the settings use, and the lease that must be disposed. */
export type SettingsGadget = Pick<GadgetClient, 'setTitle' | 'remove' | 'listBindings' | 'unbind'> & Disposable

/** The part of a connection the settings use, to say what it is, and the lease that must be disposed. */
export type SettingsGatekeeper = { getCreationSpec(): Promise<GatekeeperCreationSpec> } & Disposable

/** The part of a workspace's Overseer the settings use, and the lease that must be disposed. */
export type SettingsOverseer = {
  getGadget(id: number): SettingsGadget
  getGatekeeperById(id: number): SettingsGatekeeper
  subscribeToWorkpieces(subscriber: WorkpiecesSubscriber & RpcTarget): Promise<Disposable>
  /** Calls `callback` once the workspace can no longer be reached through this, such as when it restarted. */
  onRpcBroken(callback: (error: unknown) => void): void
} & Disposable

export type GadgetSettingsOptions = {
  /** The app's connection, which may be `down`: what fails meanwhile is not said, as `restart()` follows. */
  connection?: { readonly down: boolean }
}

const LOADING: GadgetSettingsSnapshot = { status: 'loading' }
// After the workspace was lost, how long until it is opened again.
const RETRY_DELAY = 1000
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const failed = (error: unknown) => ({ status: 'failed', message: messageOf(error) }) as const

/**
 * What a binding is, from how its connection was made (`getCreationSpec`). One with a service is
 * that service's, which is all a row needs, so only the rest are asked: `spec` is absent for those.
 */
export const describeBinding = (binding: GadgetBindingInfo, spec?: GatekeeperCreationSpec): GadgetBinding => {
  switch (spec?.type) {
    case 'agentSpawner':
      return { ...binding, kind: 'agent', ...(spec.modelName ? { model: spec.modelName } : {}) }
    case 'aiModel':
      return { ...binding, kind: 'model', model: spec.modelName }
    default:
      return { ...binding, kind: 'service' }
  }
}

/** A gadget's bindings as its settings list them: the services it reaches, then the agents it starts. */
export const groupBindings = (bindings: readonly GadgetBinding[]) => ({
  connections: bindings.filter(({ kind }) => kind !== 'agent'),
  agents: bindings.filter(({ kind }) => kind === 'agent'),
})

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
 * given, wherever) and what it is bound to, with what can be done to each.
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
  // Seen in this run: the gadget.
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
        if (first) this.#readBindings(run)
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

  /** Deletes it, for everyone. */
  remove = () => this.#with((gadget) => gadget.remove())

  /** Takes a binding away from it, leaving what it was bound to in the workspace. */
  unbind = async (name: string) => {
    await this.#with((gadget) => gadget.unbind(name))
    this.#readBindings(this.#run)
  }

  #with<T>(call: (gadget: SettingsGadget) => Promise<T>) {
    if (!this.#gadget) return Promise.reject(new Error('The gadget is still loading.'))
    return call(this.#gadget)
  }

  #readBindings(run: number) {
    const gadget = this.#gadget
    const overseer = this.#overseer
    if (!gadget || !overseer) return
    gadget.listBindings().then((items) => Promise.all(items.map((binding) => this.#describe(overseer, binding)))).then(
      (items) => this.#update(run, { status: 'ready', items }),
      (error: unknown) => this.#update(run, failed(error)),
    )
  }

  // A binding with no service is an agent or a model, which only its connection can say.
  async #describe(overseer: SettingsOverseer, binding: GadgetBindingInfo) {
    if (binding.vendorId !== undefined) return describeBinding(binding)
    // Pipelined: the connection is asked what it is as it is reached.
    const gatekeeper = overseer.getGatekeeperById(binding.target)
    try {
      return describeBinding(binding, await gatekeeper.getCreationSpec())
    } catch {
      // It is still listed, by its title, which is all a row needs.
      return describeBinding(binding)
    } finally {
      gatekeeper[Symbol.dispose]()
    }
  }

  #update(run: number, bindings: Listed<GadgetBinding>) {
    const current = this.#snapshot
    if (run !== this.#run || current.status !== 'ready') return
    // Over a lost connection, what was read stays up until it is read again.
    if (this.options.connection?.down && bindings.status === 'failed') return
    this.#publish({ ...current, bindings })
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
