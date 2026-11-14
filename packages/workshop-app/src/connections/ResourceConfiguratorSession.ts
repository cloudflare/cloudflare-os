import { newMessagePortRpcSession, RpcTarget, type RpcStub } from 'capnweb'
import type { ResourceConfiguratorHost, ResourceConfiguratorIframe } from '@gadgets/workshop-shared/gatekeeper'
import { createRateLimitedCapability } from './rateLimitedCapability'

// The Workshop's half of a gatekeeper's resource configurator: a form of the gatekeeper's own, in
// a frame sandboxed with no origin, which says which resource (a repository, a mailbox) to connect.
// Ported from `workshop-frontend`'s `SandboxedResourceConfigurator`, with the frame laid out in
// place rather than over the page (`ResourceConfiguratorFrame`).

/** What a configurator is set up with, and what it may ask of the page it is in. */
export type ConfiguratorSetup = {
  /** The gatekeeper's capability for the form, called through limits (`createRateLimitedCapability`). */
  ui: unknown
  /** The resource it opens filled in with, such as the one an agent asked for. */
  initialResource?: { resourceUrl: string; resourceUrlPattern: string }
  /** The resource types it may offer. */
  acceptedResourceUrlPatterns: readonly string[]
  /** Asks for access to more resource types on the account; resolves to whether it was asked. */
  ensureResources?: (resourceUrlPatterns: string[]) => Promise<boolean>
  /** Its form wants this much room (`layoutHeight`), and this much drawn (`height`, with a menu open). */
  onResize: (height: number, layoutHeight: number) => void
  /** Whether what is chosen in it can be connected. */
  onReady: (ready: boolean) => void
  /** A scroll that the frame passes on, for whatever scrolls it. */
  onScroll: (deltaX: number, deltaY: number) => void
}

// A frame's claims are bounded: one that is broken cannot claim an absurd height, or scroll far.
const MIN_HEIGHT = 80
const MAX_HEIGHT = 4000
const MAX_SCROLL = 1000
const COLLECT_TIMEOUT = 5000

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const height = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? clamp(Math.ceil(value), MIN_HEIGHT, MAX_HEIGHT) : undefined)
const scroll = (value: unknown) => clamp(Number(value) || 0, -MAX_SCROLL, MAX_SCROLL)

class Host extends RpcTarget implements ResourceConfiguratorHost {
  readonly #gatekeeper: RpcStub<RpcTarget>
  #ensuring = false

  constructor(private readonly setup: () => ConfiguratorSetup) {
    super()
    // The form is short-lived, so a burst past the cap is a bug: refused rather than slowed.
    this.#gatekeeper = createRateLimitedCapability(setup().ui, {
      maxConcurrency: 4,
      maxCallsPerMinute: 120,
      maxPendingCalls: 32,
      onRateLimit: 'reject',
      label: 'Resource configurator',
    }).capability
  }

  get gatekeeper() {
    return this.#gatekeeper
  }

  async getInitialResource() {
    return this.setup().initialResource ?? null
  }

  async getAcceptedResourceUrlPatterns() {
    return [...this.setup().acceptedResourceUrlPatterns]
  }

  resize(full: number, layout: number) {
    const drawn = height(full)
    if (drawn !== undefined) this.setup().onResize(drawn, height(layout) ?? drawn)
  }

  setSelectionReady(ready: boolean) {
    this.setup().onReady(ready === true)
  }

  forwardScroll(deltaX: number, deltaY: number) {
    this.setup().onScroll(scroll(deltaX), scroll(deltaY))
  }

  // One at a time: each may open a window to the service, and a second would replace the first's.
  async ensureResources(resourceUrlPatterns: string[]) {
    const ensure = this.setup().ensureResources
    if (!ensure) throw new Error('This configurator can’t ask for access here.')
    if (this.#ensuring) throw new Error('Access is already being asked for.')
    this.#ensuring = true
    try {
      return await ensure(resourceUrlPatterns)
    } finally {
      this.#ensuring = false
    }
  }
}

/**
 * One configurator frame's connection. Only its own frame is listened to (`receive`, with a frame
 * that has no origin), and only its first handshake: a second, or the frame loading again, means
 * the page in it is not the one that was given, so it is cut off and cannot be collected from.
 */
export class ResourceConfiguratorSession {
  #iframe: RpcStub<ResourceConfiguratorIframe> | undefined
  #connected = false
  #invalid = false
  #loads = 0

  /** `setup` is read each time it is needed, so its callbacks can be the latest render's. */
  constructor(private readonly frame: () => Window | null | undefined, private readonly setup: () => ConfiguratorSetup) {}

  /** A message to the page, which is the frame's handshake if it is from the frame. */
  receive = (event: Pick<MessageEvent, 'source' | 'origin' | 'data' | 'ports'>) => {
    if (!event.source || event.source !== this.frame() || event.origin !== 'null' || this.#invalid) return
    const port = (event.data as { type?: unknown } | null)?.type === 'handshake' ? event.ports[0] : undefined
    if (!port) return
    if (this.#connected) {
      port.close()
      this.#cutOff()
      return
    }
    this.#iframe = newMessagePortRpcSession<ResourceConfiguratorIframe>(port, new Host(this.setup))
    this.#connected = true
  }

  /** The frame loaded; again, and it is no longer what was given. */
  loaded = () => {
    if (++this.#loads > 1) this.#cutOff()
  }

  /** Where the frame is in the window, for where its menus open. */
  viewport(top: number, windowHeight: number) {
    if (this.#connected) void this.#iframe?.updateViewport(top, windowHeight).catch(() => {})
  }

  /** The window was resized, which closes the frame's menus. */
  windowResized() {
    if (this.#connected) void this.#iframe?.windowResized().catch(() => {})
  }

  /** The resource URL chosen in the form, as long as it answers in time. */
  async collect(): Promise<string> {
    if (this.#invalid) throw new Error('The configurator is no longer available.')
    const iframe = this.#iframe
    if (!iframe || !this.#connected) throw new Error('The configurator isn’t ready.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const url = await Promise.race([
        iframe.collectResourceUrl(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('The configurator didn’t say what to connect. Try again.')), COLLECT_TIMEOUT)
        }),
      ])
      if (typeof url !== 'string' || !url) throw new Error('The configurator didn’t say what to connect. Try again.')
      return url
    } finally {
      clearTimeout(timer)
    }
  }

  dispose() {
    this.#iframe?.[Symbol.dispose]()
    this.#iframe = undefined
    this.#connected = false
  }

  #cutOff() {
    this.#invalid = true
    this.setup().onReady(false)
    this.dispose()
  }
}
