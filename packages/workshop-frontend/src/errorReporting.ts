import {
  MAX_STRING_CHARS,
  extractFrontendFrameReport,
  normalizePageLocation,
  serializeException,
  type ErrorExceptionV1,
  type FrontendBrowserFacts,
  type FrontendCaptureMechanism,
  type FrontendErrorReportV1,
  type FrontendErrorSurface,
} from '@gadgets/error-reporting'

/** Allowlisted context available to a Workshop browser capture site. */
export type BrowserReportOptions = Readonly<{
  severity?: FrontendErrorReportV1['severity']
  handled?: boolean
  captureMechanism?: FrontendCaptureMechanism
  gadgetId?: string
  gatekeeperVendorId?: string
  surface?: FrontendErrorSurface
}>

type BrowserReporterOptions = Readonly<{
  surface: FrontendErrorSurface
  sessionId?: string
  browser?: FrontendBrowserFacts
  transport(report: FrontendErrorReportV1): void | Promise<void>
  now?: () => number
  /** Reads the diagnostic identity at report time; absent means reports carry none. */
  reportedUserId?: () => string | undefined
}>

type BrowserReporter = Readonly<{
  reportIssue(site: string, caught: unknown, options?: BrowserReportOptions): void
  reportSerialized(
    site: string,
    exception: ErrorExceptionV1 | undefined,
    options?: BrowserReportOptions,
  ): void
}>

/**
 * The diagnostic identity attached to subsequent reports.
 *
 * Named apart from the `reportedUserId` report field so a setter parameter or a local read of it
 * cannot shadow this and silently write nowhere.
 */
let currentReportedUserId: string | undefined

/**
 * Returns the current page's origin and pathname, or '' when there is nothing safe to report.
 *
 * Shares `normalizePageLocation` with the backend boundary rather than trimming the URL here: a
 * share link carries a bearer capability in its fragment and an `href` retains any credentials, so
 * both ends need the same grammar and only one of them should define it. A failure resolves to ''
 * rather than throwing, because the caller's catch would discard an entire report over one field.
 */
function getPageLocation(): string {
  try {
    return normalizePageLocation(window.location.href) ?? ''
  } catch {
    return ''
  }
}

/** Creates the Workshop-owned browser reporter with one per-tab throttle per trusted surface. */
export function createBrowserErrorReporter(options: BrowserReporterOptions): BrowserReporter {
  const now = options.now ?? Date.now
  const fingerprintsBySurface = new Map<FrontendErrorSurface, Set<string>>()
  let windowStart = 0

  const reportSerialized: BrowserReporter['reportSerialized'] = (site, exception, reportOptions) => {
    try {
      const timestamp = now()
      if (timestamp - windowStart >= 60_000) {
        windowStart = timestamp
        fingerprintsBySurface.clear()
      }
      const surface = reportOptions?.surface ?? options.surface
      const fingerprints = fingerprintsBySurface.get(surface) ?? new Set<string>()
      fingerprintsBySurface.set(surface, fingerprints)
      if (fingerprints.size >= 10) return
      const failureSite = site.slice(0, MAX_STRING_CHARS)
      // The route is deliberately absent from the fingerprint: the same fault on two routes is one
      // issue, and including it would let a single navigation loop exhaust the per-surface cap.
      const fingerprint = `${failureSite}\n${exception?.type ?? ''}\n${firstStackFrame(exception?.stack)}`
      if (fingerprints.has(fingerprint)) return

      // Read only once the report is known to be sent, so a suppressed one costs nothing.
      const pageLocation = getPageLocation()
      const reportedUserId = options.reportedUserId?.()
      const contextTruncated = [
        reportOptions?.gadgetId,
        reportOptions?.gatekeeperVendorId,
        pageLocation,
        reportedUserId,
      ].some(value => value !== undefined && value.length > MAX_STRING_CHARS)

      const report: FrontendErrorReportV1 = {
        schemaVersion: 1,
        failureSite,
        severity: reportOptions?.severity ?? 'error',
        handled: reportOptions?.handled ?? true,
        captureMechanism: reportOptions?.captureMechanism ?? 'explicit',
        surface,
        ...(options.sessionId && { sessionId: options.sessionId }),
        ...(pageLocation && { pageLocation: pageLocation.slice(0, MAX_STRING_CHARS) }),
        ...(reportedUserId && { reportedUserId: reportedUserId.slice(0, MAX_STRING_CHARS) }),
        ...(exception && { exception }),
        ...(reportOptions?.gadgetId && {
          gadgetId: reportOptions.gadgetId.slice(0, MAX_STRING_CHARS),
        }),
        ...(reportOptions?.gatekeeperVendorId && {
          gatekeeperVendorId: reportOptions.gatekeeperVendorId.slice(0, MAX_STRING_CHARS),
        }),
        ...(options.browser && { browser: options.browser }),
        ...((site.length > MAX_STRING_CHARS || contextTruncated || exception?.truncated)
          && { truncated: true }),
      }
      fingerprints.add(fingerprint)
      Promise.resolve(options.transport(report)).catch(() => {})
    } catch {
      // Observability must never change application behavior.
    }
  }

  return {
    reportSerialized,
    reportIssue(site, caught, reportOptions) {
      reportSerialized(site, serializeException(caught), reportOptions)
    },
  }
}

function firstStackFrame(stack: string | undefined): string {
  if (!stack) return ''
  return stack.split('\n').find(line => {
    const trimmed = line.trimStart()
    return /^at(?:\s|$)/.test(trimmed) || /@.+:\d+:\d+\)?$/.test(trimmed)
  })?.trim() ?? ''
}

function createSessionId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
  } catch {
    // This identifier is only diagnostic, so a non-cryptographic fallback is sufficient.
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function getSessionId(): string {
  const key = 'gadgets.frontend-error.session.v1'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing && existing.length <= MAX_STRING_CHARS) return existing
    const created = createSessionId()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return createSessionId()
  }
}

function getBrowserFacts(): FrontendBrowserFacts {
  const userAgent = navigator.userAgent
  const platform = navigator.platform
  let family: FrontendBrowserFacts['family'] = 'Other'
  if (/Firefox\//.test(userAgent)) family = 'Firefox'
  else if (/(?:Chrome|Chromium|CriOS|Edg)\//.test(userAgent)) family = 'Chromium'
  else if (/Safari\//.test(userAgent)) family = 'Safari'

  let detectedPlatform: FrontendBrowserFacts['platform'] = 'Other'
  if (/Android/i.test(userAgent)) detectedPlatform = 'Android'
  else if (/iPhone|iPad|iPod/i.test(userAgent)) detectedPlatform = 'iOS'
  else if (/Win/i.test(platform)) detectedPlatform = 'Windows'
  else if (/Mac/i.test(platform)) detectedPlatform = 'macOS'
  else if (/Linux/i.test(platform)) detectedPlatform = 'Linux'
  return { family, platform: detectedPlatform, mobile: /Mobile|Android/i.test(userAgent) }
}

const reportingEnabled = import.meta.env.VITE_FRONTEND_ERROR_REPORTING === 'true'
const ignoreReport = () => {}
const reporter: BrowserReporter = reportingEnabled
  ? createBrowserErrorReporter({
      surface: 'workshop',
      sessionId: getSessionId(),
      browser: getBrowserFacts(),
      reportedUserId: () => currentReportedUserId,
      transport: (report) => fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      }).then(() => undefined),
    })
  : { reportIssue: ignoreReport, reportSerialized: ignoreReport }

/** Reports an unexpected Workshop failure without affecting the user-facing operation. */
export function reportIssue(site: string, caught: unknown, options?: BrowserReportOptions): void {
  reporter.reportIssue(site, caught, options)
}

/**
 * Sets or clears the diagnostic identity attached to subsequent reports.
 *
 * The value is a label only: it reaches the backend unverified and is never treated as authority.
 */
export function setReportedUserId(reportedUserId: string | undefined): void {
  currentReportedUserId = reportedUserId || undefined
}

/** Installs automatic capture before the Workshop opens its RPC WebSocket. */
export function installWorkshopErrorReporting(): void {
  if (!reportingEnabled) return
  window.addEventListener('error', (event) => {
    if (event.error == null) return
    reporter.reportIssue('browser.window-error', event.error, {
      handled: false, captureMechanism: 'window.error',
    })
  })
  window.addEventListener('unhandledrejection', (event) => reporter.reportIssue(
    'browser.unhandled-rejection', event.reason,
    { handled: false, captureMechanism: 'unhandledrejection' },
  ))
}

/** Verifies and forwards a trusted opaque-origin iframe report with host-owned metadata. */
export function forwardTrustedFrameError(
  event: MessageEvent,
  frameWindow: Window,
  context: Readonly<{
    surface: Exclude<FrontendErrorSurface, 'workshop'>
    gatekeeperVendorId?: string
  }>,
  forward: BrowserReporter['reportSerialized'] = reporter.reportSerialized,
): boolean {
  if (event.source !== frameWindow || event.origin !== 'null') return false
  const frame = extractFrontendFrameReport(event.data)
  if (!frame) return false
  forward(`frame:${frame.failureSite}`.slice(0, MAX_STRING_CHARS), frame.exception, {
    severity: frame.severity,
    handled: frame.handled,
    captureMechanism: frame.captureMechanism,
    ...context,
  })
  return true
}
