import {
  MAX_STRING_CHARS,
  normalizePageLocation,
  serializeException,
  type ErrorExceptionV1,
  type FrontendBrowserFacts,
  type FrontendCaptureMechanism,
  type FrontendErrorReportV1,
} from '@gadgets/error-reporting'

/** What a place that catches something may say of it, besides what was caught. */
export type ReportOptions = Readonly<{
  severity?: FrontendErrorReportV1['severity']
  handled?: boolean
  captureMechanism?: FrontendCaptureMechanism
  gadgetId?: string
  gatekeeperVendorId?: string
}>

type ReporterOptions = Readonly<{
  sessionId?: string
  browser?: FrontendBrowserFacts
  send: (report: FrontendErrorReportV1) => void | Promise<void>
  now?: () => number
  /** Who is signed in, read as each report is made; nothing means the reports say no one. */
  reportedUserId?: () => string | undefined
}>

export type Reporter = Readonly<{
  report: (site: string, caught: unknown, options?: ReportOptions) => void
  reportSerialized: (site: string, exception: ErrorExceptionV1 | undefined, options?: ReportOptions) => void
}>

/** How many different failures a tab reports a minute, and for how long one is not reported again. */
const PER_WINDOW = 10
const WINDOW_MS = 60_000

/**
 * The page's origin and path, or nothing where there is nothing safe to say. Read by the same
 * rules the backend checks it by (`normalizePageLocation`): a share link's fragment is a bearer
 * capability and an `href` keeps any credentials in it. Never throws, which would lose the report.
 */
const pageLocation = (): string => {
  try {
    return normalizePageLocation(window.location.href) ?? ''
  } catch {
    return ''
  }
}

// The first line of a stack that names where it was, in either engine's way of writing one.
const firstFrame = (stack: string | undefined): string =>
  stack?.split('\n').find((line) => {
    const trimmed = line.trimStart()
    return /^at(?:\s|$)/.test(trimmed) || /@.+:\d+:\d+\)?$/.test(trimmed)
  })?.trim() ?? ''

/**
 * Makes reports of what went wrong in the app, ported from `workshop-frontend`'s: each failure once
 * a minute at most (the same place, the same kind, the same first frame), and no more than ten
 * different ones, so that a loop cannot flood the endpoint. The route is not part of what makes a
 * failure the same: one fault on two pages is one issue. Nothing it does can throw.
 */
export const createReporter = (options: ReporterOptions): Reporter => {
  const now = options.now ?? Date.now
  let windowStart = 0
  const seen = new Set<string>()

  const reportSerialized: Reporter['reportSerialized'] = (site, exception, reportOptions) => {
    try {
      const at = now()
      if (at - windowStart >= WINDOW_MS) {
        windowStart = at
        seen.clear()
      }
      if (seen.size >= PER_WINDOW) return
      const failureSite = site.slice(0, MAX_STRING_CHARS)
      const fingerprint = `${failureSite}\n${exception?.type ?? ''}\n${firstFrame(exception?.stack)}`
      if (seen.has(fingerprint)) return

      // Read only for a report that is sent.
      const location = pageLocation()
      const reportedUserId = options.reportedUserId?.()
      const contextTruncated = [reportOptions?.gadgetId, reportOptions?.gatekeeperVendorId, location, reportedUserId]
        .some((value) => value !== undefined && value.length > MAX_STRING_CHARS)

      const report: FrontendErrorReportV1 = {
        schemaVersion: 1,
        failureSite,
        severity: reportOptions?.severity ?? 'error',
        handled: reportOptions?.handled ?? true,
        captureMechanism: reportOptions?.captureMechanism ?? 'explicit',
        surface: 'workshop',
        ...(options.sessionId && { sessionId: options.sessionId }),
        ...(location && { pageLocation: location.slice(0, MAX_STRING_CHARS) }),
        ...(reportedUserId && { reportedUserId: reportedUserId.slice(0, MAX_STRING_CHARS) }),
        ...(exception && { exception }),
        ...(reportOptions?.gadgetId && { gadgetId: reportOptions.gadgetId.slice(0, MAX_STRING_CHARS) }),
        ...(reportOptions?.gatekeeperVendorId && { gatekeeperVendorId: reportOptions.gatekeeperVendorId.slice(0, MAX_STRING_CHARS) }),
        ...(options.browser && { browser: options.browser }),
        ...((site.length > MAX_STRING_CHARS || contextTruncated || exception?.truncated) && { truncated: true }),
      }
      seen.add(fingerprint)
      Promise.resolve(options.send(report)).catch(() => {})
    } catch {
      // Reporting must never change what the app does.
    }
  }

  return {
    reportSerialized,
    report: (site, caught, reportOptions) => reportSerialized(site, serializeException(caught), reportOptions),
  }
}

// Only a label for whoever reads the reports: it reaches the backend unchecked, and nothing may
// decide anything by it.
let reportedUserId: string | undefined

// Not `crypto.randomUUID()` alone, which a page that is not served securely has none of.
const newSessionId = () => {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return uuid
  } catch {
    // Only told apart from other tabs' by it, so it need not be unguessable.
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// The tab's, kept under the old app's key, so that the two tell one tab apart the same way.
const sessionId = () => {
  const key = 'gadgets.frontend-error.session.v1'
  try {
    const kept = sessionStorage.getItem(key)
    if (kept && kept.length <= MAX_STRING_CHARS) return kept
    const made = newSessionId()
    sessionStorage.setItem(key, made)
    return made
  } catch {
    return newSessionId()
  }
}

const browserFacts = (): FrontendBrowserFacts => {
  const { userAgent, platform } = navigator
  const family: FrontendBrowserFacts['family'] = /Firefox\//.test(userAgent) ? 'Firefox'
    : /(?:Chrome|Chromium|CriOS|Edg)\//.test(userAgent) ? 'Chromium'
      : /Safari\//.test(userAgent) ? 'Safari'
        : 'Other'
  const detected: FrontendBrowserFacts['platform'] = /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
      : /Win/i.test(platform) ? 'Windows'
        : /Mac/i.test(platform) ? 'macOS'
          : /Linux/i.test(platform) ? 'Linux'
            : 'Other'
  return { family, platform: detected, mobile: /Mobile|Android/i.test(userAgent) }
}

/** Whether this build reports what goes wrong (`VITE_FRONTEND_ERROR_REPORTING`); see `packages/error-reporting/AGENTS.md`. */
const REPORTING = import.meta.env.VITE_FRONTEND_ERROR_REPORTING === 'true'

const ignore = () => {}
// Sent to the app's own origin, as everything else is, where the backend decides whether anything
// is done with it.
const reporter: Reporter = REPORTING
  ? createReporter({
      sessionId: sessionId(),
      browser: browserFacts(),
      reportedUserId: () => reportedUserId,
      send: (report) => fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      }).then(() => undefined),
    })
  : { report: ignore, reportSerialized: ignore }

/**
 * Reports something that went wrong unexpectedly, without changing what the user was doing. What
 * is thrown reaches whoever reads the reports, so never put a secret, a prompt, a token or what was
 * sent or received in an error.
 */
export const reportIssue = (site: string, caught: unknown, options?: ReportOptions) => reporter.report(site, caught, options)

/** Who the reports from here on say is signed in, or nobody. */
export const setReportedUserId = (id: string | undefined) => {
  reportedUserId = id || undefined
}

/**
 * Reports whatever goes uncaught on the page, where the build reports at all. Installed before the
 * connection to the backend is opened, so that nothing is missed.
 */
export const installErrorReporting = () => {
  if (!REPORTING) return
  window.addEventListener('error', (event) => {
    // A resource that failed to load has no error, and says nothing worth reporting.
    if (event.error == null) return
    reporter.report('browser.window-error', event.error, { handled: false, captureMechanism: 'window.error' })
  })
  window.addEventListener('unhandledrejection', (event) =>
    reporter.report('browser.unhandled-rejection', event.reason, { handled: false, captureMechanism: 'unhandledrejection' }))
}
