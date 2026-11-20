import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, BlueprintGadgetSummary, BlueprintLibrarySummary, BlueprintPublicInfo, BlueprintUnpublishedChanges, BlueprintUserSummary, GatekeeperVendorInfo, OutputSummary, OwnBlueprintsSubscriber } from '@gadgets/workshop-shared/api'
import { keepSubscribed } from '@/rpc/keepSubscribed'
import { templatesOf, type Template } from './templates'

/** The templates, as far as they have been read. */
export type TemplatesState =
  | { status: 'loading' }
  | {
      status: 'ready'
      templates: Template[]
      /** The ids of the starred ones, in their order. */
      stars: string[]
    }
  | { status: 'failed'; message: string }

/** The part of the user's API the templates are read and kept through. */
export type TemplatesApi = Pick<
  RpcStub<AuthenticatedApi>,
  'listFeaturedBlueprints' | 'listLibraryBlueprints' | 'subscribeToOwnBlueprints' | 'listGatekeeperVendors' | 'setBlueprintPinned' | 'openWorkspace'
>

/** A gadget to make a template from, by where it is and what it is called. */
export type TemplateSource = Pick<OutputSummary, 'workspaceId' | 'workpieceId' | 'title'>

const LOADING: TemplatesState = { status: 'loading' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What the server calls with the user's own blueprints. A class, because the server must receive a
 * single stub for the object. The server letting go of it (`Symbol.dispose`) is said through
 * `onReleased`.
 */
class OwnBlueprintsListener extends RpcTarget implements OwnBlueprintsSubscriber {
  constructor(
    private readonly onSnapshot: (blueprints: BlueprintUserSummary[]) => void,
    private readonly onUpdated: (blueprintId: string, blueprint: BlueprintUserSummary | null) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async snapshot(blueprints: BlueprintUserSummary[]) {
    this.onSnapshot(blueprints)
  }

  async updated(blueprintId: string, blueprint: BlueprintUserSummary | null) {
    this.onUpdated(blueprintId, blueprint)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The templates there are to start something from (`templatesOf`): the deployment's featured
 * blueprints, the user's saved ones and those they created, with their stars, which are the
 * backend's `pinned`. Those they created are kept live by their account
 * (`subscribeToOwnBlueprints()`), which says as each is created, edited, released or deleted, and
 * as its gadget has changes to release; the rest are read. Observable through
 * `subscribe`/`getSnapshot`, so that the store and a template's page show the same. A star is
 * shown at once and put back if the server refuses it.
 */
export class TemplateStore {
  #state: TemplatesState = LOADING
  readonly #listeners = new Set<() => void>()
  #api: TemplatesApi | undefined
  #run = 0
  #read: { featured: BlueprintPublicInfo[]; library: BlueprintLibrarySummary[]; vendors: GatekeeperVendorInfo[] } | undefined
  #own: BlueprintUserSummary[] | undefined
  #stopOwn: (() => void) | undefined

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#state

  /** The owner's rows, available even if the featured or saved lists fail to load. */
  getOwnSnapshot = () => this.#own

  /** Reads them through `api`; another, as a new connection brings, reads them again, with what was read shown meanwhile. */
  connect(api: TemplatesApi) {
    if (api === this.#api) return
    this.#api = api
    this.#stopOwn?.()
    this.#stopOwn = keepSubscribed((released, current) =>
      api.subscribeToOwnBlueprints(new OwnBlueprintsListener(
        (blueprints) => {
          if (!current()) return
          this.#own = blueprints
          this.#derive(true)
        },
        (id, blueprint) => {
          if (!current() || !this.#own) return
          const at = this.#own.findIndex((each) => each.id === id)
          const own = [...this.#own]
          if (at === -1) {
            // A new one is the latest.
            if (blueprint) own.unshift(blueprint)
          } else if (blueprint) own[at] = blueprint
          else own.splice(at, 1)
          this.#own = own
          this.#derive(false)
        },
        released,
      )))
    void this.reload()
  }

  /** Reads the featured, the saved and the services again; the user's own are live. */
  reload = async () => {
    const api = this.#api
    if (!api) return
    const run = ++this.#run
    try {
      const [featured, library, vendors] = await Promise.all([
        api.listFeaturedBlueprints(),
        api.listLibraryBlueprints(),
        // Without them, a template's services go by what its creator called them.
        api.listGatekeeperVendors().catch(() => []),
      ])
      if (run !== this.#run) return
      this.#read = { featured, library, vendors }
      this.#derive(true)
    } catch (error) {
      // What was read stays up when reading it again fails.
      if (run === this.#run && this.#state.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
    }
  }

  // Once both are known. One of the user's own changing keeps the stars as they are shown, which
  // may be ahead of what was read.
  #derive(readStars: boolean) {
    if (!this.#own) return
    if (!this.#read) {
      for (const listener of this.#listeners) listener()
      return
    }
    const { templates, stars } = templatesOf({ ...this.#read, own: this.#own })
    const current = this.#state
    this.#publish({ status: 'ready', templates, stars: readStars || current.status !== 'ready' ? stars : current.stars })
  }

  /** Stars and unstars them as `stars` says, in its order. */
  setStars = (stars: string[]) => {
    const current = this.#state
    if (current.status !== 'ready' || !this.#api) return
    const before = new Set(current.stars)
    const after = new Set(stars)
    const changed = [...new Set([...before, ...after])].filter((id) => before.has(id) !== after.has(id))
    this.#publish({ ...current, stars })
    const api = this.#api
    Promise.all(changed.map((id) => api.setBlueprintPinned(id, after.has(id)))).catch(() => {
      // Put back, rather than shown as kept.
      const now = this.#state
      if (now.status === 'ready') this.#publish({ ...now, stars: current.stars })
    })
  }

  /**
   * Creates a new template from one of the user's apps, under `title` (its own unless another is
   * given) and with what it is for, where that is said, from what it has committed
   * (`GadgetClient.createBlueprint()`). Gives its id.
   */
  create = async (app: TemplateSource, { title, description }: { title?: string; description?: string } = {}): Promise<string> => {
    // Disposed by hand: `using` is not lowered for every browser this runs in. Pipelined, so it is one round trip.
    const overseer = this.#connected().openWorkspace(app.workspaceId)
    const gadget = overseer.getGadget(app.workpieceId)
    try {
      const { id } = await gadget.createBlueprint(title?.trim() || app.title, description?.trim() || undefined)
      return id
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  /**
   * The templates made from a workspace's gadgets (`Overseer.listBlueprints()`), each naming the
   * gadget it is of (`gadgetId`).
   */
  createdFrom = async (workspaceId: string): Promise<BlueprintGadgetSummary[]> => {
    const overseer = this.#connected().openWorkspace(workspaceId)
    try {
      return await overseer.listBlueprints()
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  /**
   * Releases what the gadget a template is of has changed since (`Overseer.updateBlueprint()`):
   * with code, as the template's next version (`updateCode`, which takes its bindings too), and
   * otherwise its bindings alone (`updateBindings`). Then reads the featured and the saved again,
   * which it may be among. The user's own hear of it from their account.
   */
  release = async (workspaceId: string, templateId: string, changes: BlueprintUnpublishedChanges): Promise<void> => {
    const overseer = this.#connected().openWorkspace(workspaceId)
    try {
      await overseer.updateBlueprint(templateId, changes.code ? { updateCode: true } : { updateBindings: true })
    } finally {
      overseer[Symbol.dispose]()
    }
    await this.reload()
  }

  /**
   * Changes a template's title and what it is for (`Overseer.updateBlueprint()`), then reads the
   * featured and the saved again, as a release does. Its code and version stay as they are.
   */
  update = async (workspaceId: string, templateId: string, { title, description }: { title: string; description: string }): Promise<void> => {
    const overseer = this.#connected().openWorkspace(workspaceId)
    try {
      await overseer.updateBlueprint(templateId, { title, description })
    } finally {
      overseer[Symbol.dispose]()
    }
    await this.reload()
  }

  /**
   * Deletes a template made from a workspace's gadget (`Overseer.deleteBlueprint()`), for everyone
   * who could have found it, then reads the featured and the saved again, as a release does. What
   * was made from it stays.
   */
  remove = async (workspaceId: string, templateId: string): Promise<void> => {
    const overseer = this.#connected().openWorkspace(workspaceId)
    try {
      await overseer.deleteBlueprint(templateId)
    } finally {
      overseer[Symbol.dispose]()
    }
    await this.reload()
  }

  #connected() {
    if (!this.#api) throw new Error('Not connected.')
    return this.#api
  }

  #publish(state: TemplatesState) {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
