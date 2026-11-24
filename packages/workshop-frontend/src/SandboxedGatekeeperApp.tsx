import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { type RpcPromise, RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { useNavigate } from '@tanstack/react-router'
import type {
  GatekeeperUiFrame,
  GatekeeperUserSelectionReceiver,
} from '@gadgets/workshop-shared/gatekeeper'
import { isHexColor } from '@gadgets/workshop-shared/api'
import type {
  GatekeeperAppNavigateOptions,
  GatekeeperAppNavigation,
  GatekeeperAppPathReceiver,
} from '@gadgets/workshop-shared/gatekeeper-app'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeHost,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import { createRateLimitedCapability } from './rateLimitedCapability'
import { useTheme } from './ThemeContext'
import { useServerConfig } from './ServerConfigContext'
import { forwardTrustedFrameError } from './errorReporting'
import { useAuthenticatedApi } from './AuthContext'
import { makeExportFilename, saveBlobToFile } from './fileTransfers'
import {
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppPath,
  parseGatekeeperAppWorkspaceTarget,
  type GatekeeperAppWorkspaceTarget,
} from './gatekeeperAppNavigation'
import GatekeeperDownloadDialog from './GatekeeperDownloadDialog'
import { getBackendHost } from './connectHandoff'
import GatekeeperUserPickerDialog from './features/gatekeeper-sharing/GatekeeperUserPickerDialog'

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
// Commits navigation to an app-local path under this app's own /gatekeepers/<appId> prefix.
type NavigatePath = (path: string, replace: boolean) => Promise<void>
// Opening throws synchronously if refused; returning transfers receiver ownership to the picker.
type OpenUserPicker = (receiver: RpcStub<GatekeeperUserSelectionReceiver>) => Promise<void>
type CancelUserPicker = () => void
// The Workshop's own handle on a host (see GatekeeperAppHostImpl.controls()), never sent to the app.
type GatekeeperAppHostControls = {
  updateTheme(theme: GatekeeperAppTheme): void
  updatePath(path: string): void
  dispose(): void
}

type UserPicker = {
  id: number
  receiver: RpcStub<GatekeeperUserSelectionReceiver>
  deliveries: Set<RpcPromise<void>>
  resolve: () => void
}

const USER_PICKER_CANCELLED = 'Person selection cancelled. A delivery may already have been accepted.'

type OverlayState = 'full' | null

// Upper bound on one workspace-title lookup, matching the app's page size.
const MAX_RESOLVED_WORKSPACES = 100

// How long one gadget listing is reused across title lookups. The untrusted frame calls this once
// per page of rows (and could call it in a loop), so the listing is shared rather than repeated.
const WORKSPACE_TITLES_TTL_MS = 10_000

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
      width: 'calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right))',
      height: 'calc(100vh - var(--app-top) - var(--app-bottom) - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
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

// Parse one parameter at a time so quoted semicolons cannot introduce another filename.
function downloadFilename(disposition: string): string | undefined {
  const kind = /^\s*attachment\s*(?=;|$)/i.exec(disposition)
  if (!kind) throw new Error('Gatekeeper response is not a download.')
  const parameter = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]*)\s*/y
  let offset = kind[0].length
  let filename: string | undefined
  let extended: string | undefined
  while (offset < disposition.length) {
    parameter.lastIndex = offset
    const match = parameter.exec(disposition)
    if (!match) break
    offset = parameter.lastIndex
    const name = match[1].toLowerCase()
    const raw = match[2]
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
    if (name === 'filename') filename = value
    if (name === 'filename*') {
      const encoded = /^UTF-8'[^']*'(.*)$/i.exec(value)?.[1]
      if (encoded !== undefined) {
        try { extended = decodeURIComponent(encoded) } catch { /* Keep an ordinary filename. */ }
      }
    }
  }
  return extended ?? filename
}

// The host capability exposed to the sandboxed app (the gatekeeper's iframe UI) over the MessagePort
// RPC session. The app uses `ui` to reach the gatekeeper's own capability, which Workshop relays and
// rate-limits. `setPresenting` stays in Workshop and only grows/restores the iframe's layout.
//
// The app can call every public method of an RpcTarget, so anything only the Workshop may call is a
// `#` method, reached through controls().
class GatekeeperAppHostImpl extends RpcTarget implements GatekeeperAppNavigation, GatekeeperAppThemeHost {
  readonly #ui: RpcStub<RpcTarget>
  readonly #downloadPrefix: string
  readonly #confirmDownload: () => Promise<boolean>
  readonly #cancelDownload: () => void
  #downloadAbort: AbortController | null = null
  #disposed = false
  #downloading = false
  readonly #disposeRateLimiter: () => void
  readonly #present: PresentController
  readonly #openTarget: OpenTarget
  readonly #openPrompt: OpenPrompt
  readonly #resolveWorkspaceTitles: ResolveWorkspaceTitles
  readonly #openUserPicker: OpenUserPicker
  readonly #cancelUserPicker: CancelUserPicker
  readonly #navigatePath: NavigatePath
  #presenting = false
  #theme: GatekeeperAppTheme
  #themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | null = null
  // The app-local path from the address bar, and the app's receiver for it (see subscribePath).
  #path: string
  #pathReceiver: RpcStub<GatekeeperAppPathReceiver> | null = null
  // Presentation changes are coalesced to a single apply per animation frame (see #applyPending).
  #pendingActive: boolean | null = null
  #pendingResolvers: ((ack: PresentAck) => void)[] = []
  #frameId: number | null = null

  constructor(
    capability: unknown,
    present: PresentController,
    theme: GatekeeperAppTheme,
    openTarget: OpenTarget,
    openPrompt: OpenPrompt,
    resolveWorkspaceTitles: ResolveWorkspaceTitles,
    openUserPicker: OpenUserPicker,
    cancelUserPicker: CancelUserPicker,
    path: string,
    navigatePath: NavigatePath,
    gatekeeperVendorId: string,
    confirmDownload: () => Promise<boolean>,
    cancelDownload: () => void,
  ) {
    super()
    this.#theme = theme
    this.#path = path
    const { capability: ui, dispose } = createRateLimitedCapability(capability, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
    })
    this.#ui = ui
    this.#downloadPrefix = `/gatekeeper/${encodeURIComponent(gatekeeperVendorId)}/`
    this.#disposeRateLimiter = dispose
    this.#present = present
    this.#openTarget = openTarget
    this.#openPrompt = openPrompt
    this.#resolveWorkspaceTitles = resolveWorkspaceTitles
    this.#openUserPicker = openUserPicker
    this.#cancelUserPicker = cancelUserPicker
    this.#navigatePath = navigatePath
    this.#confirmDownload = confirmDownload
    this.#cancelDownload = cancelDownload
  }

  // Static members are unreachable over RPC, so these stay with the Workshop.
  static controls(host: GatekeeperAppHostImpl): GatekeeperAppHostControls {
    return {
      updateTheme: (theme) => host.#updateTheme(theme),
      updatePath: (path) => host.#updatePath(path),
      dispose: () => host.#dispose(),
    }
  }

  get ui(): RpcStub<RpcTarget> {
    return this.#ui
  }

  // The opaque-origin frame cannot perform authenticated attachment navigation. Keep the download
  // in the trusted host, scoped to this vendor's route; never pass attachment contents to the frame.
  async downloadFile(url: string): Promise<void> {
    let target: URL
    try {
      if (typeof url !== 'string') throw new TypeError()
      target = new URL(url)
    } catch {
      throw new TypeError('Invalid gatekeeper download URL.')
    }
    // Vite's frontend and backend use separate ports. Normalize only that configured backend
    // through the local proxy; production remains strictly same-origin.
    if (import.meta.env.DEV && !target.username && !target.password &&
        target.origin === new URL(`http://${getBackendHost()}`).origin) {
      target = new URL(target.pathname + target.search + target.hash, window.location.origin)
    }
    if (target.origin !== window.location.origin
      || !target.pathname.startsWith(this.#downloadPrefix)
      || target.username || target.password || target.search || target.hash) {
      throw new TypeError('Invalid gatekeeper download URL.')
    }
    // Single-flight includes the prompt and body read. A frame cannot fan out credentialed
    // requests or trigger automatic downloads without a click in trusted Workshop UI.
    if (this.#downloading || this.#disposed) {
      throw new Error('A download is already pending or this app has closed.')
    }
    this.#downloading = true
    const controller = new AbortController()
    this.#downloadAbort = controller
    try {
      if (!await this.#confirmDownload()) throw new Error('Download cancelled.')
      controller.signal.throwIfAborted()
      const response = await fetch(target.href, {
        credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('Gatekeeper download failed.')
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const filename = downloadFilename(disposition)
      const blob = await response.blob()
      controller.signal.throwIfAborted()
      const safeName = makeExportFilename('download', '', filename)
      // An entirely non-Latin stem can sanitize to only the extension. Keep that extension
      // meaningful to the OS, rather than saving a hidden file which Chromium renames.
      saveBlobToFile(blob, safeName.startsWith('.') ? `download${safeName}` : safeName)
    } finally {
      // Abort even rejected headers: an unread streaming body must not outlive its slot.
      controller.abort()
      this.#downloadAbort = null
      this.#downloading = false
    }
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

  // Open the trusted Workshop-owned person picker over the app. The directory search happens in the
  // parent, and the Workshop mints a single-use ticket for each person the user selects
  // (AuthenticatedApi.createGatekeeperUserSelection) and delivers it to `receiver.receive()` — to
  // the iframe, not to the gatekeeper's server. The app decides what a selection is for: it can send
  // the ticket to its backend at once, or hold it in form state and submit it later, while it is
  // valid. The promise resolves when the picker closes: after every delivery has settled, or
  // immediately on cancellation, when deliveries may still be running. Frame teardown also
  // cancels, but the app then sees its connection close instead. Cancellation cannot undo a
  // delivery the app may already have accepted. Otherwise it stays pending while open (no timeout).
  // Only one picker can be open at a time.
  selectUsers(receiver: RpcStub<GatekeeperUserSelectionReceiver>): Promise<void> {
    if (typeof receiver?.dup !== 'function') {
      return Promise.reject(new TypeError('selectUsers requires a receiver capability.'))
    }
    // The argument stub is disposed when this call returns. Opening transfers this dup to the
    // picker, which releases it on close or cancellation; only an opening failure releases it here.
    const retained = receiver.dup()
    try {
      return this.#openUserPicker(retained)
    } catch (error) {
      retained[Symbol.dispose]()
      return Promise.reject(error)
    }
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
  #updateTheme(theme: GatekeeperAppTheme) {
    this.#theme = theme
    const receiver = this.#themeReceiver
    if (!receiver) return

    try {
      Promise.resolve(receiver.setTheme(theme)).catch(() => this.#dropThemeReceiver(receiver))
    } catch {
      this.#dropThemeReceiver(receiver)
    }
  }

  // The app calls this once to receive its path from the address bar and every later change,
  // including Back/Forward, which moves the URL without remounting the iframe. The current path goes
  // through the receiver like every later one, rather than as this call's result: capnweb sends a
  // result only when the app pulls it, so a change pushed in between would arrive first.
  subscribePath(receiver: RpcStub<GatekeeperAppPathReceiver>): void {
    this.#pathReceiver?.[Symbol.dispose]?.()
    // The argument stub is disposed when this call returns, so keep our own dup (released in dispose).
    this.#pathReceiver = receiver.dup()
    this.#updatePath(this.#path)
  }

  // The app is untrusted: the path is validated here, and the caller pins it under the app's prefix,
  // so the frame can't navigate the Workshop anywhere else.
  navigatePath(path: string, options?: GatekeeperAppNavigateOptions): Promise<void> {
    const target = parseGatekeeperAppPath(path)
    if (target === this.#path) return Promise.resolve()
    return this.#navigatePath(target, options?.replace === true)
  }

  // Push the committed path to a subscribed app; a no-op until (and unless) the app subscribes.
  #updatePath(path: string) {
    this.#path = path
    const receiver = this.#pathReceiver
    if (!receiver) return

    try {
      Promise.resolve(receiver.setPath(path)).catch(() => this.#dropPathReceiver(receiver))
    } catch {
      this.#dropPathReceiver(receiver)
    }
  }

  #dropPathReceiver(receiver: RpcStub<GatekeeperAppPathReceiver>) {
    if (this.#pathReceiver !== receiver) return
    receiver[Symbol.dispose]?.()
    this.#pathReceiver = null
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
  #dispose() {
    this.#disposeRateLimiter()
    this.#disposed = true
    this.#downloadAbort?.abort()
    this.#cancelDownload()
    this.#cancelUserPicker()
    this.#themeReceiver?.[Symbol.dispose]?.()
    this.#themeReceiver = null
    this.#pathReceiver?.[Symbol.dispose]?.()
    this.#pathReceiver = null
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
 * `path` is the app-local path from the address bar, delivered to the app as it changes; the app
 * navigates by asking the host to change it. The iframe fills its parent container.
 */
export default function SandboxedGatekeeperApp({ frame, gatekeeperVendorId, path }: {
  frame: GatekeeperUiFrame,
  gatekeeperVendorId: string,
  path: string,
}) {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const hostRef = useRef<GatekeeperAppHostControls | null>(null)
  const connectedRef = useRef(false)
  const invalidatedRef = useRef(false)
  const [overlay, setOverlay] = useState<OverlayState>(null)
  // Trusted prompts share one slot so their modal focus traps cannot overlap.
  const activePromptRef = useRef<'download' | 'picker' | null>(null)
  const [downloadDecision, setDownloadDecision] = useState<((accepted: boolean) => void) | null>(null)
  const downloadDecisionRef = useRef<((accepted: boolean) => void) | null>(null)
  const confirmDownload = useCallback(() => new Promise<boolean>((resolve) => {
    if (activePromptRef.current) throw new Error('Another gatekeeper prompt is already open.')
    activePromptRef.current = 'download'
    downloadDecisionRef.current = resolve
    setDownloadDecision(() => resolve)
  }), [])
  const finishDownload = useCallback((accepted: boolean) => {
    downloadDecisionRef.current?.(accepted)
    downloadDecisionRef.current = null
    if (activePromptRef.current === 'download') activePromptRef.current = null
    setDownloadDecision(null)
  }, [])
  const cancelDownload = useCallback(() => finishDownload(false), [finishDownload])
  // The open picker owns the receiver dup and settles `selectUsers()` on close or cancellation.
  // State drives rendering; the ref lets callbacks check identity before settling, so late
  // callbacks from a cancelled picker cannot close a newly opened picker.
  const [userPicker, setUserPicker] = useState<UserPicker | null>(null)
  const openPickerRef = useRef<UserPicker | null>(null)
  const nextPickerId = useRef(0)
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
  // Read at handshake time and pushed on change, so a path change never re-establishes the session.
  const pathRef = useRef(path)
  pathRef.current = path
  useEffect(() => {
    hostRef.current?.updatePath(path)
  }, [path])

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
        titles: authenticatedApi.listWorkspaces()
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
  const navigatePath = useCallback<NavigatePath>((target, replace) => navigate({
    to: '/gatekeepers/$appId/$',
    params: { appId: gatekeeperVendorId, _splat: target.slice(1) },
    replace,
  }), [navigate, gatekeeperVendorId])
  const openUserPicker = useCallback<OpenUserPicker>((receiver) => {
    if (openPickerRef.current) {
      throw new Error('A person picker is already open.')
    }
    if (activePromptRef.current) throw new Error('Another gatekeeper prompt is already open.')
    activePromptRef.current = 'picker'
    // Promise.withResolvers is not in this package's ES2023 TypeScript lib.
    let resolve!: () => void
    const promise = new Promise<void>((resolver) => {
      resolve = resolver
    })
    const open: UserPicker = { id: ++nextPickerId.current, receiver, deliveries: new Set(), resolve }
    openPickerRef.current = open
    setUserPicker(open)
    return promise
  }, [])
  // Normal closing waits for deliveries; cancellation releases ownership immediately even if
  // a receiver never settles. Neither path may dispose or settle the same picker twice.
  const finishUserPicker = useCallback((open: UserPicker) => {
    if (openPickerRef.current !== open) return
    openPickerRef.current = null
    if (activePromptRef.current === 'picker') activePromptRef.current = null
    setUserPicker(null)
    open.receiver[Symbol.dispose]()
    for (const delivery of open.deliveries) delivery[Symbol.dispose]()
    open.deliveries.clear()
    open.resolve()
  }, [])
  const cancelUserPicker = useCallback<CancelUserPicker>(() => {
    const open = openPickerRef.current
    if (open) finishUserPicker(open)
  }, [finishUserPicker])
  // The gatekeeper-defined capability remains opaque; this host only relays it through `ui`.
  const capabilityRef = useRef<unknown>(null)
  capabilityRef.current = frame.ui

  useEffect(() => {
    connectedRef.current = false
    invalidatedRef.current = false

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
        resolveWorkspaceTitles,
        openUserPicker,
        cancelUserPicker,
        pathRef.current,
        navigatePath,
        gatekeeperVendorId,
        confirmDownload,
        cancelDownload,
      )
      hostRef.current = GatekeeperAppHostImpl.controls(host)
      sessionRef.current = newMessagePortRpcSession(port, host)
      connectedRef.current = true
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the handshake from our own sandboxed iframe (which posts from a null origin).
      // Capture contentWindow first: if the frame isn't mounted there's no legitimate sender, so
      // reject — comparing against a concrete window avoids a `source === undefined` edge.
      const frameWindow = iframeRef.current?.contentWindow
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
  }, [frame.iframeHtml, frame.ui, gatekeeperVendorId, confirmDownload, cancelDownload, cancelUserPicker, navigatePath, openPrompt,
      openTarget, openUserPicker, present, resolveWorkspaceTitles, setOverlayPhase])

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={frame.iframeHtml}
        // allow-scripts: run the app's JS. allow-modals: its beforeunload unsaved-changes guard. Not
        // allow-same-origin (the frame stays an opaque origin), and the app's CSP keeps connect-src 'none'.
        sandbox="allow-scripts allow-modals"
        allow="clipboard-write"
        title="Gatekeeper app"
        style={iframeStyleForOverlay(overlay)}
      />
      {downloadDecision && <GatekeeperDownloadDialog onDecision={finishDownload} />}
      {userPicker && (
        <GatekeeperUserPickerDialog
          key={userPicker.id}
          authenticatedApi={authenticatedApi}
          gatekeeperId={gatekeeperVendorId}
          onSelected={async (selection) => {
            if (openPickerRef.current !== userPicker) {
              return Promise.reject(new Error(USER_PICKER_CANCELLED))
            }
            const delivery = userPicker.receiver.receive(selection)
            userPicker.deliveries.add(delivery)
            try {
              await delivery
            } finally {
              if (userPicker.deliveries.delete(delivery)) delivery[Symbol.dispose]()
            }
          }}
          onClose={() => finishUserPicker(userPicker)}
          onCancel={() => finishUserPicker(userPicker)}
        />
      )}
    </>
  )
}
