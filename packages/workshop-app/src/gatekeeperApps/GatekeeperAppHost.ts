import { RpcTarget, type RpcStub } from 'capnweb'
import type { GatekeeperUserSelectionReceiver } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from '@gadgets/workshop-shared/theme'
import { createRateLimitedCapability } from '@/connections/rateLimitedCapability'
import { normalizeAppPrompt, parseAppWorkspaceTarget, type AppWorkspaceTarget } from './appNavigation'

// The Workshop's half of a gatekeeper's management app: what the app, in a frame sandboxed with
// no origin, may ask of the page it is in, over the frame's port. Ported from `workshop-frontend`'s
// `SandboxedGatekeeperApp`. The app's own API (`ui`) is the gatekeeper's, which the Workshop only
// relays to it, through limits, and never calls itself.

/** Where the app's page is held, in the window, while the frame covers all of it. */
export type OverlayRect = { left: number; top: number; width: number; height: number }

/**
 * What the page says once the frame has grown over the window, or back: where the app holds its
 * page meanwhile (none when back), and whether the frame's size changed, which it does not where
 * the page filled the window already.
 */
export type PresentAck = { rect: OverlayRect | null; willResize: boolean }

/** What the page the app is in does for it. */
export type AppHostPage = {
  /** Grows the frame over the whole window, for a dialog of the app's (`true`), or back. */
  present: (active: boolean) => PresentAck
  openWorkspace: (target: AppWorkspaceTarget) => void
  /** Starts a chat with `prompt` in the composer. */
  openPrompt: (prompt: string) => void
  /** The titles of the workspaces named, now, or null for one the user cannot see. */
  resolveWorkspaceTitles: (ids: string[]) => Promise<(string | null)[]>
  /**
   * Opens the Workshop's person picker, which `receiver` is given each person chosen in, and
   * which then owns it. Resolves once it is closed; throws at once where it cannot be opened.
   */
  openUserPicker: (receiver: RpcStub<GatekeeperUserSelectionReceiver>) => Promise<void>
  /** Closes the person picker, if it is open, without waiting on what is being given the app. */
  cancelUserPicker: () => void
}

// The most workspaces one lookup names, as many as a page of the app's.
const MAX_RESOLVED_WORKSPACES = 100

/**
 * What a gatekeeper's app is given by the page it is in: its gatekeeper's API (`ui`), through
 * limits, as the app is not trusted to keep from flooding it; the theme, and each change to it;
 * growing over the window for a dialog of its own; going to a workspace, or starting a chat; the
 * titles of workspaces it already knows of; and the person picker. What it asks to go to is
 * checked here (`appNavigation`).
 */
export class GatekeeperAppHost extends RpcTarget {
  readonly #ui: RpcStub<RpcTarget>
  readonly #disposeLimits: () => void
  readonly #page: AppHostPage
  #theme: GatekeeperAppTheme
  #themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | undefined
  #presenting = false
  // A change of presentation is made once a frame, as the latest asked for.
  #pendingActive: boolean | undefined
  #pendingResolvers: ((ack: PresentAck) => void)[] = []
  #frameId: number | undefined

  constructor(ui: unknown, page: AppHostPage, theme: GatekeeperAppTheme) {
    super()
    const limited = createRateLimitedCapability(ui, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      // Long-lived, so a burst is slowed rather than refused.
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
    })
    this.#ui = limited.capability
    this.#disposeLimits = limited.dispose
    this.#page = page
    this.#theme = theme
  }

  /** The gatekeeper's own API for its app. */
  get ui(): RpcStub<RpcTarget> {
    return this.#ui
  }

  /** Goes to a workspace the app knows of, and a gadget in it: in the app, never a URL the frame gave. */
  openWorkspace(workspaceId: string, gadgetId?: number): void {
    this.#page.openWorkspace(parseAppWorkspaceTarget(workspaceId, gadgetId))
  }

  /** Each workspace's title now, or null for one the user cannot see: a lookup of those it knows of, not a list. */
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]> {
    if (!Array.isArray(ids) || ids.length > MAX_RESOLVED_WORKSPACES || ids.some((id) => typeof id !== 'string')) {
      return Promise.reject(new TypeError('Invalid workspace title lookup.'))
    }
    return this.#page.resolveWorkspaceTitles(ids)
  }

  /** Starts a chat with `prompt` in the composer, for the user to send. */
  openPrompt(prompt: string): void {
    this.#page.openPrompt(normalizeAppPrompt(prompt))
  }

  /**
   * Opens the Workshop's person picker over the app. The directory is searched in the Workshop,
   * which makes a ticket for each person chosen (`createGatekeeperUserSelection`) and gives it to
   * `receiver`, in the frame, not to the gatekeeper: the app decides what it is for. Resolves once
   * the picker is closed, after what was given has settled, or at once when it is given up on.
   * One at a time.
   */
  selectUsers(receiver: RpcStub<GatekeeperUserSelectionReceiver>): Promise<void> {
    if (typeof receiver?.dup !== 'function') return Promise.reject(new TypeError('selectUsers requires a receiver capability.'))
    // What is passed is let go of when the call returns, so the picker is given its own.
    const kept = receiver.dup()
    try {
      return this.#page.openUserPicker(kept)
    } catch (error) {
      kept[Symbol.dispose]()
      return Promise.reject(error)
    }
  }

  /** The theme, and each change to it from here on, given `receiver`. An app that does not theme itself never asks. */
  subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>): GatekeeperAppTheme {
    this.#themeReceiver?.[Symbol.dispose]()
    // What is passed is let go of when the call returns.
    this.#themeReceiver = receiver.dup()
    return this.#theme
  }

  /** The Workshop's theme changed: given the app, if it asked. */
  updateTheme(theme: GatekeeperAppTheme) {
    this.#theme = theme
    const receiver = this.#themeReceiver
    if (!receiver) return
    const drop = () => {
      if (this.#themeReceiver !== receiver) return
      receiver[Symbol.dispose]()
      this.#themeReceiver = undefined
    }
    try {
      Promise.resolve(receiver.setTheme(theme)).catch(drop)
    } catch {
      drop()
    }
  }

  /** Grows the frame over the window for a dialog of the app's, or back, on the next frame. */
  setPresenting(active: boolean): Promise<PresentAck> {
    return new Promise((resolve) => {
      this.#pendingActive = active === true
      this.#pendingResolvers.push(resolve)
      this.#frameId ??= requestAnimationFrame(() => this.#applyPending())
    })
  }

  // The latest asked for, once, which everyone who asked this frame is told of.
  #applyPending() {
    this.#frameId = undefined
    const active = this.#pendingActive ?? false
    const resolvers = this.#pendingResolvers
    this.#pendingActive = undefined
    this.#pendingResolvers = []
    const ack: PresentAck = active === this.#presenting ? { rect: null, willResize: false } : this.#page.present(active)
    this.#presenting = active
    for (const resolve of resolvers) resolve(ack)
  }

  /** The app is gone: what it held is let go of, and the frame is put back. */
  dispose() {
    this.#disposeLimits()
    this.#page.cancelUserPicker()
    this.#themeReceiver?.[Symbol.dispose]()
    this.#themeReceiver = undefined
    if (this.#frameId !== undefined) cancelAnimationFrame(this.#frameId)
    this.#frameId = undefined
    for (const resolve of this.#pendingResolvers) resolve({ rect: null, willResize: false })
    this.#pendingResolvers = []
    this.#pendingActive = undefined
    if (this.#presenting) {
      this.#presenting = false
      this.#page.present(false)
    }
  }
}
