import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { useNavigate } from '@tanstack/react-router'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import { isHexColor } from '@gadgets/workshop-shared/api'
import { createRateLimitedCapability } from './rateLimitedCapability'
import { useTheme } from './ThemeContext'
import { useServerConfig } from './ServerConfigContext'
import { forwardTrustedFrameError } from './errorReporting'
import { useAuthenticatedApi } from './AuthContext'
import {
  normalizeGatekeeperAppCodingSessionTitle,
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppWorkspaceTarget,
  type GatekeeperAppWorkspaceTarget,
} from './gatekeeperAppNavigation'
import { normalizeWorkItemTarget, type WorkItemTarget } from './workItemNavigation'

// The content-pane rect, in viewport coordinates, that the app pins its page to while the iframe
// is full-viewport.
type OverlayRect = { left: number; top: number; width: number; height: number }

// The host's reply to a present/dismiss. On open, `rect` is where the app holds its page fixed while
// the iframe expands to full-viewport (null on restore); `willResize` is whether switching the iframe
// to/from full-viewport actually changes its pixel size (it won't if the pane already fills the window).
type PresentAck = { rect: OverlayRect | null; willResize: boolean }

// Grows the app's iframe to a full-viewport overlay for app-level modals (true) or restores it (false).
type PresentController = (active: boolean) => PresentAck
type OpenTarget = (target: GatekeeperAppWorkspaceTarget) => void
// Resolves workspace IDs the app already holds to their live titles; null for a workspace the user
// can no longer see. Deliberately a lookup, not an enumeration: the app learns nothing new.
type ResolveWorkspaceTitles = (ids: string[]) => Promise<(string | null)[]>
type OpenPrompt = (prompt: string) => void
type RequestCodingSession = (target: WorkItemTarget, title: string) => void
type RouteStateSetter = (value: string) => void

/** One independently authorized management capability exposed to a composite gatekeeper app. */
export type GatekeeperAppDependency = {
  app: GatekeeperAppInfo
  capability: any
  error?: string
}

const EMPTY_DEPENDENCIES: GatekeeperAppDependency[] = []

type OverlayState = 'full' | null

// Upper bound on one workspace-title lookup, matching the app's page size.
const MAX_RESOLVED_WORKSPACES = 100

// How long one gadget listing is reused across title lookups. The untrusted frame calls this once
// per page of rows (and could call it in a loop), so the listing is shared rather than repeated.
const WORKSPACE_TITLES_TTL_MS = 10_000
export const MAX_GATEKEEPER_APP_ROUTE_STATE_LENGTH = 2048

type GatekeeperAppDependencyIdentity = {
  id: string
  capability: any
  error?: string
}

export function normalizeGatekeeperAppRouteState(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length > MAX_GATEKEEPER_APP_ROUTE_STATE_LENGTH) return undefined
  for (let index = 0; index < value.length; index++) {
    const charCode = value.charCodeAt(index)
    if (charCode <= 0x1F || charCode === 0x7F) return undefined
  }
  return value
}

function requireGatekeeperAppRouteState(value: string): string {
  const normalized = normalizeGatekeeperAppRouteState(value)
  if (normalized === undefined) throw new TypeError('Invalid gatekeeper app route state.')
  return normalized
}

function dependencyIdentities(dependencies: GatekeeperAppDependency[]): GatekeeperAppDependencyIdentity[] {
  return dependencies
    .map((dependency) => ({ id: dependency.app.id, capability: dependency.capability, error: dependency.error }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

function sameDependencyIdentities(
  a: GatekeeperAppDependencyIdentity[],
  b: GatekeeperAppDependencyIdentity[],
): boolean {
  return a.length === b.length && a.every((entry, index) =>
    entry.id === b[index]!.id && entry.capability === b[index]!.capability && entry.error === b[index]!.error)
}

// Near the max int, so the full-viewport iframe sits above all Workshop chrome.
const overlayZIndex = 2147483000

const baseIframeStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
}

function iframeStyleForOverlay(overlay: OverlayState): CSSProperties {
  if (overlay === 'full') {
    return {
      ...baseIframeStyle,
      position: 'fixed',
      top: 'calc(var(--app-top) + env(safe-area-inset-top))',
      right: 'env(safe-area-inset-right)',
      bottom: 'calc(var(--app-bottom) + env(safe-area-inset-bottom))',
      left: 'env(safe-area-inset-left)',
      width: 'auto',
      height: 'auto',
      zIndex: overlayZIndex,
    }
  }
  return {
    ...baseIframeStyle,
    display: 'block',
    width: '100%',
    height: '100%',
  }
}

// The host capability exposed to the sandboxed app (the gatekeeper's iframe UI) over the MessagePort
// RPC session. The app uses `ui` to reach the gatekeeper's own capability, which Workshop relays and
// rate-limits. `setPresenting` stays in Workshop and only grows/restores the iframe's layout.
class GatekeeperAppHostImpl extends RpcTarget {
  readonly #ui: RpcStub<RpcTarget>
  readonly #capabilities = new Map<string, {
    app: GatekeeperAppInfo
    capability: any
    error?: string
  }>()
  readonly #disposeRateLimiters: (() => void)[] = []
  readonly #present: PresentController
  readonly #openTarget: OpenTarget
  readonly #openPrompt: OpenPrompt
  readonly #codingSessionAvailable: () => boolean
  readonly #codingSessionRequestAllowed: boolean
  readonly #requestCodingSession: RequestCodingSession
  readonly #resolveWorkspaceTitles: ResolveWorkspaceTitles
  readonly #getRouteState: () => string
  readonly #setRouteState: RouteStateSetter
  #presenting = false
  #theme: GatekeeperAppTheme
  #themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | null = null
  // Presentation changes are coalesced to a single apply per animation frame (see #applyPending).
  #pendingActive: boolean | null = null
  #pendingResolvers: ((ack: PresentAck) => void)[] = []
  #frameId: number | null = null
  readonly #retryProviders: () => void
  readonly #openConnectors: () => void

  constructor(
    capability: any,
    present: PresentController,
    theme: GatekeeperAppTheme,
    openTarget: OpenTarget,
    openPrompt: OpenPrompt,
    codingSessionAvailable: () => boolean,
    codingSessionRequestAllowed: boolean,
    requestCodingSession: RequestCodingSession,
    resolveWorkspaceTitles: ResolveWorkspaceTitles,
    getRouteState: () => string,
    setRouteState: RouteStateSetter,
    dependencies: GatekeeperAppDependency[],
    retryProviders: () => void,
    openConnectors: () => void,
  ) {
    super()
    this.#theme = theme
    this.#retryProviders = retryProviders
    this.#openConnectors = openConnectors
    const { capability: ui, dispose } = createRateLimitedCapability(capability, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
    })
    this.#ui = ui
    this.#disposeRateLimiters.push(dispose)
    for (const dependency of dependencies) {
      if (dependency.error) {
        this.#capabilities.set(dependency.app.id, dependency)
        continue
      }
      const limited = createRateLimitedCapability(dependency.capability, {
        maxConcurrency: 8,
        maxCallsPerMinute: 600,
        maxPendingCalls: 128,
        onRateLimit: 'throttle',
        label: `Gatekeeper app dependency ${dependency.app.id}`,
      })
      this.#capabilities.set(dependency.app.id, {
        app: dependency.app,
        capability: limited.capability,
      })
      this.#disposeRateLimiters.push(limited.dispose)
    }
    this.#present = present
    this.#openTarget = openTarget
    this.#openPrompt = openPrompt
    this.#codingSessionAvailable = codingSessionAvailable
    this.#codingSessionRequestAllowed = codingSessionRequestAllowed
    this.#requestCodingSession = requestCodingSession
    this.#resolveWorkspaceTitles = resolveWorkspaceTitles
    this.#getRouteState = getRouteState
    this.#setRouteState = setRouteState
  }

  get ui(): RpcStub<RpcTarget> {
    return this.#ui
  }

  // Metadata carries no authority. The app must request one of the listed opaque IDs separately.
  listCapabilities(): GatekeeperAppInfo[] {
    return [...this.#capabilities.values()].map(({ app }) => app)
  }

  getCapability(id: string): RpcStub<RpcTarget> | null {
    const dependency = this.#capabilities.get(id)
    if (dependency?.error) throw new Error(dependency.error)
    return this.#capabilities.get(id)?.capability ?? null
  }

  openWorkItemsConnectors(): void {
    if (!this.#codingSessionRequestAllowed) throw new Error('Not available to this app.')
    this.#openConnectors()
  }

  retryWorkItemsProviders(): void {
    if (!this.#codingSessionRequestAllowed) throw new Error('Not available to this app.')
    this.#retryProviders()
  }

  // Navigate to a workspace the app knows about. The IDs are validated here because the app is
  // untrusted; navigation stays in-app rather than handing the frame a URL to follow.
  openWorkspace(workspaceId: string, gadgetId?: number): void {
    this.#openTarget(parseGatekeeperAppWorkspaceTarget(workspaceId, gadgetId))
  }

  // Resolve live titles for workspaces the app already references, so it never renders a stale
  // snapshot. Bounded per call; unknown or no-longer-visible workspaces come back as null.
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]> {
    if (!Array.isArray(ids) || ids.length > MAX_RESOLVED_WORKSPACES) {
      throw new TypeError('Invalid workspace title lookup.')
    }
    return this.#resolveWorkspaceTitles(ids)
  }

  openPrompt(prompt: string): void {
    this.#openPrompt(normalizeGatekeeperAppPrompt(prompt))
  }

  codingSessionAvailable(): boolean {
    return this.#codingSessionRequestAllowed && this.#codingSessionAvailable()
  }

  requestCodingSession(source: unknown, id: unknown, key: unknown, url: unknown, title: string): void {
    if (!this.#codingSessionRequestAllowed || !this.#codingSessionAvailable()) {
      throw new Error('Coding-session requests are not available to this app.')
    }
    this.#requestCodingSession(
      normalizeWorkItemTarget(source, id, key, url),
      normalizeGatekeeperAppCodingSessionTitle(title),
    )
  }

  getRouteState(): string {
    return this.#getRouteState()
  }

  setRouteState(value: string): void {
    this.#setRouteState(requireGatekeeperAppRouteState(value))
  }

  // The app calls this once to learn the current theme and register a receiver for later changes.
  // Apps that don't theme themselves never call it.
  subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>): GatekeeperAppTheme {
    this.#themeReceiver?.[Symbol.dispose]?.()
    // The argument stub is disposed when this call returns, so keep our own dup (released in dispose).
    this.#themeReceiver = receiver.dup()
    return this.#theme
  }

  #dropThemeReceiver(receiver: RpcStub<GatekeeperAppThemeReceiver>) {
    if (this.#themeReceiver !== receiver) return
    receiver[Symbol.dispose]?.()
    this.#themeReceiver = null
  }

  // Push a new theme to a subscribed app; a no-op until (and unless) the app subscribes.
  updateTheme(theme: GatekeeperAppTheme) {
    this.#theme = theme
    const receiver = this.#themeReceiver
    if (!receiver) return

    try {
      Promise.resolve(receiver.setTheme(theme)).catch(() => this.#dropThemeReceiver(receiver))
    } catch {
      this.#dropThemeReceiver(receiver)
    }
  }

  // Queue a presentation change; the latest requested state is applied on the next frame.
  setPresenting(active: boolean): Promise<PresentAck> {
    return new Promise((resolve) => {
      this.#pendingActive = active
      this.#pendingResolvers.push(resolve)
      this.#frameId ??= requestAnimationFrame(() => this.#applyPending())
    })
  }

  // Apply the last-requested state once, resolving every caller queued this frame with the result.
  #applyPending() {
    this.#frameId = null
    const active = this.#pendingActive!
    const resolvers = this.#pendingResolvers
    this.#pendingActive = null
    this.#pendingResolvers = []
    // No-op toggles skip the layout apply.
    const ack: PresentAck =
      active === this.#presenting ? { rect: null, willResize: false } : this.#present(active)
    this.#presenting = active
    for (const resolve of resolvers) resolve(ack)
  }

  // Cancel the rate limiter's pending resume timer once this host is no longer in use.
  dispose() {
    for (const dispose of this.#disposeRateLimiters) dispose()
    this.#themeReceiver?.[Symbol.dispose]?.()
    this.#themeReceiver = null
    if (this.#frameId !== null) {
      cancelAnimationFrame(this.#frameId)
      this.#frameId = null
    }
    for (const resolve of this.#pendingResolvers) resolve({ rect: null, willResize: false })
    this.#pendingResolvers = []
    this.#pendingActive = null
    if (this.#presenting) {
      this.#presenting = false
      this.#present(false)
    }
  }
}

/**
 * Hosts a gatekeeper's full-page management SPA in a sandboxed, network-isolated iframe. The app
 * talks to the gatekeeper only through the `ui` capability carried over the MessagePort RPC session.
 * The iframe fills its parent container.
 */
export default function SandboxedGatekeeperApp({
  frame,
  gatekeeperVendorId,
  dependencies = EMPTY_DEPENDENCIES,
  routeState,
  setRouteState,
  codingSessionAvailable = false,
  workItemHandoffs = false,
  onRequestCodingSession,
  onRetryProviders,
}: {
  frame: GatekeeperUiFrame,
  gatekeeperVendorId: string,
  dependencies?: GatekeeperAppDependency[],
  routeState?: string,
  setRouteState?: RouteStateSetter,
  codingSessionAvailable?: boolean,
  workItemHandoffs?: boolean,
  onRequestCodingSession?: RequestCodingSession,
  onRetryProviders?: () => void,
}) {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const hostRef = useRef<GatekeeperAppHostImpl | null>(null)
  const connectedRef = useRef(false)
  const invalidatedRef = useRef(false)
  const routeStateRef = useRef('')
  const setRouteStateRef = useRef<RouteStateSetter>(() => {})
  const codingSessionAvailableRef = useRef(false)
  const requestCodingSessionRef = useRef<RequestCodingSession>(() => {})
  const retryProvidersRef = useRef(onRetryProviders)
  retryProvidersRef.current = onRetryProviders
  routeStateRef.current = normalizeGatekeeperAppRouteState(routeState) ?? ''
  setRouteStateRef.current = setRouteState ?? (() => {})
  codingSessionAvailableRef.current = codingSessionAvailable
  requestCodingSessionRef.current = onRequestCodingSession ?? (() => {})
  const dependencyIdentity = dependencyIdentities(dependencies)
  const iframeReload = useRef({
    html: frame.iframeHtml,
    ui: frame.ui,
    dependencies: [] as GatekeeperAppDependencyIdentity[],
    key: 0,
  })
  if (iframeReload.current.html !== frame.iframeHtml || iframeReload.current.ui !== frame.ui ||
      !sameDependencyIdentities(iframeReload.current.dependencies, dependencyIdentity)) {
    iframeReload.current = {
      html: frame.iframeHtml,
      ui: frame.ui,
      dependencies: dependencyIdentity,
      key: iframeReload.current.key + 1,
    }
  }
  const sessionIdentityKey = iframeReload.current.key
  const [overlay, setOverlay] = useState<OverlayState>(null)
  const overlayRef = useRef<OverlayState>(null)
  // Push the Workshop's resolved light/dark mode and deployment accent whenever either changes.
  const { resolvedThemeMode } = useTheme()
  const configuredAccentColor = useServerConfig()?.accentColor
  const accentColor = configuredAccentColor && isHexColor(configuredAccentColor)
    ? configuredAccentColor
    : null
  const themeRef = useRef<GatekeeperAppTheme>({ mode: resolvedThemeMode, accentColor })
  themeRef.current = { mode: resolvedThemeMode, accentColor }
  useEffect(() => {
    hostRef.current?.updateTheme({ mode: resolvedThemeMode, accentColor })
  }, [resolvedThemeMode, accentColor])

  const setOverlayPhase = useCallback((next: OverlayState) => {
    if (overlayRef.current === next) return
    overlayRef.current = next
    setOverlay(next)
  }, [])

  // Grow the iframe to full-viewport (or restore it), then report back the pane rect and whether the
  // size actually changed.
  const present = useCallback<PresentController>((active) => {
    const el = iframeRef.current
    const before = el?.getBoundingClientRect()
    // Duplicate restores are common during cleanup; avoid forcing layout when already restored.
    if (!active && overlayRef.current === null) return { rect: null, willResize: false }
    flushSync(() => setOverlayPhase(active ? 'full' : null))
    const after = el?.getBoundingClientRect()
    const willResize =
      !!before && !!after && (before.width !== after.width || before.height !== after.height)
    // On open, `before` is the pane rect the app pins to.
    const rect =
      active && before
        ? { left: before.left, top: before.top, width: before.width, height: before.height }
        : null
    return { rect, willResize }
  }, [setOverlayPhase])
  const openTarget = useCallback<OpenTarget>(({ workspaceId, gadgetId }) => {
    navigate({
      to: '/workspace/$id',
      params: { id: workspaceId },
      search: gadgetId === undefined ? {} : { w: gadgetId },
    })
  }, [navigate])
  const titlesRef = useRef<{ at: number, titles: Promise<Map<string, string>> } | null>(null)
  const resolveWorkspaceTitles = useCallback<ResolveWorkspaceTitles>(async (ids) => {
    let entry = titlesRef.current
    if (!entry || Date.now() - entry.at >= WORKSPACE_TITLES_TTL_MS) {
      entry = {
        at: Date.now(),
        titles: authenticatedApi.listGadgets()
          .then((gadgets) => new Map(gadgets.map((gadget) => [gadget.id, gadget.title]))),
      }
      titlesRef.current = entry
      // Don't cache a failure: drop it so the next lookup retries.
      const failed = entry
      entry.titles.catch(() => {
        if (titlesRef.current === failed) titlesRef.current = null
      })
    }
    const titles = await entry.titles
    return ids.map((id) => titles.get(id) ?? null)
  }, [authenticatedApi])
  const openPrompt = useCallback<OpenPrompt>((prompt) => {
    navigate({ to: '/', search: { prompt } })
  }, [navigate])
  // The gatekeeper capability is `any`: its method shape is gatekeeper-defined and opaque to us.
  const capabilityRef = useRef<any>(null)
  capabilityRef.current = frame.ui

  useLayoutEffect(() => {
    connectedRef.current = false
    invalidatedRef.current = false
    const frameWindow = iframeRef.current?.contentWindow ?? null

    const connect = (port: MessagePort) => {
      if (connectedRef.current) {
        // A second handshake (e.g. iframe reloaded) invalidates the session.
        invalidatedRef.current = true
        port.close()
        sessionRef.current?.[Symbol.dispose]?.()
        sessionRef.current = null
        hostRef.current?.dispose()
        hostRef.current = null
        setOverlayPhase(null)
        return
      }
      if (invalidatedRef.current || !capabilityRef.current) {
        port.close()
        return
      }
      const host = new GatekeeperAppHostImpl(
        capabilityRef.current,
        present,
        themeRef.current,
        openTarget,
        openPrompt,
        () => codingSessionAvailableRef.current,
        workItemHandoffs,
        (target, title) => requestCodingSessionRef.current(target, title),
        resolveWorkspaceTitles,
        () => routeStateRef.current,
        (value) => setRouteStateRef.current(value),
        dependencies,
        () => retryProvidersRef.current?.(),
        () => { void navigate({ to: '/gatekeepers' }) },
      )
      hostRef.current = host
      sessionRef.current = newMessagePortRpcSession(port, host)
      connectedRef.current = true
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the handshake from the exact sandboxed iframe that owned this listener (which
      // posts from a null origin). Capturing the window here keeps an old listener from adopting a
      // newly-remounted iframe before its passive cleanup would otherwise run.
      if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return
      if (invalidatedRef.current) return
      if (forwardTrustedFrameError(
        event, frameWindow, { surface: 'gatekeeper-app', gatekeeperVendorId },
      )) return
      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connect(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      sessionRef.current?.[Symbol.dispose]?.()
      sessionRef.current = null
      hostRef.current?.dispose()
      hostRef.current = null
      setOverlayPhase(null)
    }
    // Re-establish the session if either the HTML or the `ui` capability changes, so a new frame
    // carrying a fresh stub (even with identical HTML) never keeps talking through the stale one.
  }, [sessionIdentityKey, gatekeeperVendorId, openPrompt, openTarget,
      present, resolveWorkspaceTitles, setOverlayPhase, workItemHandoffs])

  return (
    <iframe
      key={iframeReload.current.key}
      ref={iframeRef}
      srcDoc={frame.iframeHtml}
      // allow-scripts: run the app's JS. allow-modals: its beforeunload unsaved-changes guard. Not
      // allow-same-origin (the frame stays an opaque origin), and the app's CSP keeps connect-src 'none'.
      sandbox="allow-scripts allow-modals"
      allow="clipboard-write"
      title="Gatekeeper app"
      style={iframeStyleForOverlay(overlay)}
    />
  )
}
