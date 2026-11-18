import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, BlueprintGadgetSummary, OutputSummary, PublicApi } from '@gadgets/workshop-shared/api'
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
  'listFeaturedBlueprints' | 'listLibraryBlueprints' | 'listOwnBlueprints' | 'listGatekeeperVendors' | 'setBlueprintPinned' | 'openWorkspace'
>

/** The part of the public API a blueprint's own record is read through. */
export type TemplatesPublicApi = Pick<RpcStub<PublicApi>, 'getBlueprint'>

/** A gadget to make a template from, by where it is and what it is called. */
export type TemplateSource = Pick<OutputSummary, 'workspaceId' | 'workpieceId' | 'title'>

const LOADING: TemplatesState = { status: 'loading' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The templates there are to start something from (`templatesOf`): the deployment's featured
 * blueprints, the user's saved ones and those they created, with their stars, which are the
 * backend's `pinned`. Observable through `subscribe`/`getSnapshot`, so that the store and a
 * template's page show the same. A star is shown at once and put back if the server refuses it.
 */
export class TemplateStore {
  #state: TemplatesState = LOADING
  readonly #listeners = new Set<() => void>()
  #api: TemplatesApi | undefined
  #publicApi: TemplatesPublicApi | null = null
  #run = 0

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#state

  /** Reads them through `api`; another, as a new connection brings, reads them again, with what was read shown meanwhile. */
  connect(api: TemplatesApi, publicApi: TemplatesPublicApi | null) {
    if (api === this.#api && publicApi === this.#publicApi) return
    this.#api = api
    this.#publicApi = publicApi
    void this.reload()
  }

  reload = async () => {
    const api = this.#api
    if (!api) return
    const run = ++this.#run
    const publicApi = this.#publicApi
    try {
      const [featured, library, created, vendors] = await Promise.all([
        api.listFeaturedBlueprints(),
        api.listLibraryBlueprints(),
        api.listOwnBlueprints(),
        // Without them, a template's services go by what its creator called them.
        api.listGatekeeperVendors().catch(() => []),
      ])
      // What the user created is listed only as a summary; its record has the rest.
      const own = await Promise.all(created.map(async (summary) => ({
        summary,
        info: publicApi ? await publicApi.getBlueprint(summary.id).catch(() => null) : null,
      })))
      if (run === this.#run) this.#publish({ status: 'ready', ...templatesOf({ featured, library, own, vendors }) })
    } catch (error) {
      // What was read stays up when reading it again fails.
      if (run === this.#run && this.#state.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
    }
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
   * (`GadgetClient.createBlueprint()`), then reads the templates again. Gives its id.
   */
  create = async (app: TemplateSource, { title, description }: { title?: string; description?: string } = {}): Promise<string> => {
    // Disposed by hand: `using` is not lowered for every browser this runs in. Pipelined, so it is one round trip.
    const overseer = this.#connected().openWorkspace(app.workspaceId)
    const gadget = overseer.getGadget(app.workpieceId)
    try {
      const { id } = await gadget.createBlueprint(title?.trim() || app.title, description?.trim() || undefined)
      await this.reload()
      return id
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  /**
   * The templates made from a workspace's gadgets (`Overseer.listBlueprints()`), which do not
   * say which gadget each is of.
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
   * Releases what the gadget a template is of has committed since, as the template's next version
   * (`Overseer.updateBlueprint()` with `updateCode`), then reads the templates again.
   */
  release = async (workspaceId: string, templateId: string): Promise<void> => {
    const overseer = this.#connected().openWorkspace(workspaceId)
    try {
      await overseer.updateBlueprint(templateId, { updateCode: true })
    } finally {
      overseer[Symbol.dispose]()
    }
    await this.reload()
  }

  /**
   * Changes a template's title and what it is for (`Overseer.updateBlueprint()`), then reads the
   * templates again. Its code and version stay as they are.
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
   * who could have found it, then reads the templates again. What was made from it stays.
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
