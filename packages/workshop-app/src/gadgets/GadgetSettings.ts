import { RpcTarget } from 'capnweb'
import {
  getOpenWorkspaceErrorCode,
  OPEN_WORKSPACE_ERROR_CODES,
  type GadgetBindingInfo,
  type GadgetClient,
  type GadgetSummary,
  type GatekeeperCreationSpec,
  type ModelKind,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
  validateBindingName,
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
  /** Which of the user's models a model is (`listModels()`), to name it as they know it and to change it. */
  modelId?: string
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
export type SettingsGadget = Pick<GadgetClient, 'setTitle' | 'remove' | 'listBindings' | 'bind' | 'unbind' | 'renameBinding' | 'getBlueprintAnnotation' | 'setBlueprintAnnotation'> & Disposable

/** The part of a connection the settings use, to say what it is, and the lease that must be disposed. */
export type SettingsGatekeeper = { getCreationSpec(): Promise<GatekeeperCreationSpec> } & Disposable

/** The part of a workspace's Overseer the settings use, and the lease that must be disposed. */
export type SettingsOverseer = {
  getGadget(id: number): SettingsGadget
  getGatekeeperById(id: number): SettingsGatekeeper
  /** A connection to one of the user's models, made in the workspace and bound to nothing yet. */
  newAiModelGatekeeper(modelId: string): { getId(): Promise<number> } & Disposable
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
      return { ...binding, kind: 'model', model: spec.modelName, modelId: spec.modelId }
    default:
      return { ...binding, kind: 'service' }
  }
}

/** Why a name was refused before it was asked for: what is said is the whole of it, for the user as it is. */
export class InvalidBindingName extends Error {}

/**
 * Why a binding cannot be renamed to `name`, or nothing where it can: it is blank, it is not a
 * name code can reach it by (`validateBindingName()`, which the server holds it to as well, said
 * here without naming the name again), or the gadget has another by it (`taken`).
 */
export const bindingNameProblem = (name: string, taken: readonly string[]): string | undefined => {
  if (name === '') return 'It needs a name.'
  try {
    validateBindingName(name)
  } catch (error) {
    const why = messageOf(error).replace(/^Invalid binding name "[^"]*": /, '')
    return why.charAt(0).toUpperCase() + why.slice(1)
  }
  if (taken.includes(name)) return `It already has env.${name}. Choose another name.`
  return undefined
}

/**
 * The name a model is given in a gadget's code unless another is typed: the one the backend
 * suggests for its kind (`describe().suggestedBindingName`), so that code written for one reads
 * the same in every gadget.
 */
export const MODEL_BINDING_NAMES: Record<ModelKind, string> = { language: 'LLM', decision: 'DECISION_MODEL' }

/** `name`, or the first of `NAME_2`, `NAME_3`… the gadget has nothing by (`taken`). */
export const freeBindingName = (name: string, taken: readonly string[]) => {
  if (!taken.includes(name)) return name
  let count = 2
  while (taken.includes(`${name}_${count}`)) count++
  return `${name}_${count}`
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

  /**
   * Gives a binding another name, which its code then knows it by. Refused with an
   * `InvalidBindingName`, asking nothing, where the name cannot be one (`bindingNameProblem`).
   */
  renameBinding = async (name: string, next: string) => {
    const problem = bindingNameProblem(next, this.#listed().map((binding) => binding.name).filter((each) => each !== name))
    if (problem) throw new InvalidBindingName(problem)
    await this.#with((gadget) => gadget.renameBinding(name, next))
    this.#readBindings(this.#run)
  }

  /**
   * Has a model binding reach another of the user's models under the same name, so its code goes
   * on as it was. There is no call to point a binding elsewhere, so a connection to the new model
   * replaces it, with the blueprint annotation it had; if that cannot be bound, the old one is put
   * back. The old connection stays in the workspace, as one taken away does.
   */
  changeModel = async (name: string, modelId: string) => {
    const binding = this.#listed().find((each) => each.name === name)
    if (!binding) throw new Error(`It no longer has env.${name}.`)
    if (binding.modelId === modelId) return
    const target = await this.#newModel(modelId)
    await this.#with(async (gadget) => {
      const annotation = await gadget.getBlueprintAnnotation(name).catch(() => null)
      await gadget.unbind(name)
      try {
        await gadget.bind(name, target)
      } catch (error) {
        await gadget.bind(name, binding.target).catch(() => {})
        throw error
      }
      // Only what it says when published as a template, which the binding works without.
      if (annotation) await gadget.setBlueprintAnnotation(name, annotation).catch(() => {})
    })
    this.#readBindings(this.#run)
  }

  #listed() {
    const current = this.#snapshot
    return current.status === 'ready' && current.bindings.status === 'ready' ? current.bindings.items : []
  }

  // A new connection to the model, as its id, which is pipelined on the asking.
  async #newModel(modelId: string) {
    if (!this.#overseer) throw new Error('The gadget is still loading.')
    const gatekeeper = this.#overseer.newAiModelGatekeeper(modelId)
    try {
      return await gatekeeper.getId()
    } finally {
      gatekeeper[Symbol.dispose]()
    }
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
