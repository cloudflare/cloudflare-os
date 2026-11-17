import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, OutputSummary, PublicApi } from '@gadgets/workshop-shared/api'
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

const LOADING: TemplatesState = { status: 'loading' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The templates there are to start something from (`templatesOf`): the deployment's featured
 * blueprints, the user's saved ones and those they published, with their stars, which are the
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
      const [featured, library, published, vendors] = await Promise.all([
        api.listFeaturedBlueprints(),
        api.listLibraryBlueprints(),
        api.listOwnBlueprints(),
        // Without them, a template's services go by what its publisher called them.
        api.listGatekeeperVendors().catch(() => []),
      ])
      // What the user published is listed only as a summary; its record has the rest.
      const own = await Promise.all(published.map(async (summary) => ({
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
   * Publishes one of the user's apps as a template, under its title, from what it has committed
   * (`GadgetClient.createBlueprint()`), then reads the templates again. Gives its id.
   */
  publish = async (app: OutputSummary): Promise<string> => {
    if (!this.#api) throw new Error('Not connected.')
    // Disposed by hand: `using` is not lowered for every browser this runs in. Pipelined, so it is one round trip.
    const overseer = this.#api.openWorkspace(app.workspaceId)
    const gadget = overseer.getGadget(app.workpieceId)
    try {
      const { id } = await gadget.createBlueprint(app.title)
      await this.reload()
      return id
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  #publish(state: TemplatesState) {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
