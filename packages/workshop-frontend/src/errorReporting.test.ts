// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  FRONTEND_ERROR_MESSAGE_TYPE,
  type FrontendErrorReportV1,
} from '@gadgets/error-reporting'
import {
  createBrowserErrorReporter,
  forwardTrustedFrameError,
  type BrowserReportOptions,
} from './errorReporting'

const frameReport = {
  failureSite: 'frame.render',
  severity: 'error',
  handled: false,
  captureMechanism: 'react',
  exception: { type: 'Error', message: 'boom', stack: 'Error: boom' },
} as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Workshop reporter initialization', () => {
  it('does not require randomUUID when reporting is disabled', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_FRONTEND_ERROR_REPORTING', 'false')
    vi.stubGlobal('crypto', {})

    const module = await import('./errorReporting')
    const addEventListener = vi.spyOn(window, 'addEventListener')
    module.installWorkshopErrorReporting()
    expect(addEventListener).not.toHaveBeenCalled()
  })

  it('uses a fallback session ID when randomUUID and storage are unavailable', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_FRONTEND_ERROR_REPORTING', 'true')
    vi.stubGlobal('crypto', {})
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetch)

    const module = await import('./errorReporting')
    module.reportIssue('test.fallback-session', new Error('boom'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string)
    expect(body.sessionId).toMatch(/^session-/)
  })

  it('ignores window errors without a thrown value and reports real errors as non-fatal', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_FRONTEND_ERROR_REPORTING', 'true')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetch)

    const module = await import('./errorReporting')
    expect(module.installWorkshopErrorReporting()).toBeUndefined()
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
    expect(fetch).not.toHaveBeenCalled()

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom') }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const body = JSON.parse(fetch.mock.calls[0][1]?.body as string)
    expect(body).toMatchObject({
      severity: 'error',
      captureMechanism: 'window.error',
    })
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('keepalive')
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('credentials')
  })
})

describe('createBrowserErrorReporter', () => {
  it('enriches once, deduplicates for 60 seconds, and caps a tab at ten per minute', () => {
    const transport = vi.fn<(report: FrontendErrorReportV1) => void>()
    let now = 1_000
    const reporter = createBrowserErrorReporter({
      surface: 'workshop',
      sessionId: 'session-12345678',
      browser: { family: 'Chromium', platform: 'Linux', mobile: false },
      transport,
      now: () => now,
    })
    reporter.reportIssue('same', new Error('boom'))
    reporter.reportIssue('same', new Error('boom'))
    for (let i = 0; i < 20; i++) reporter.reportIssue(`site-${i}`, new Error(`${i}`))
    expect(transport).toHaveBeenCalledTimes(10)
    expect(transport.mock.calls[0][0]).toMatchObject({
      surface: 'workshop',
      sessionId: 'session-12345678',
      browser: { family: 'Chromium', platform: 'Linux', mobile: false },
    })

    now += 60_001
    reporter.reportIssue('same', new Error('boom'))
    expect(transport).toHaveBeenCalledTimes(11)
  })

  it('isolates the ten-report budget by host-owned surface', () => {
    const transport = vi.fn<(report: FrontendErrorReportV1) => void>()
    const reporter = createBrowserErrorReporter({ surface: 'workshop', transport })

    for (let i = 0; i < 10; i++) {
      reporter.reportIssue(`configurator-${i}`, new Error(`${i}`), { surface: 'configurator' })
    }
    reporter.reportIssue('workshop.react', new Error('render failed'), {
      captureMechanism: 'react',
    })

    expect(transport).toHaveBeenCalledTimes(11)
    expect(transport.mock.calls[10][0]).toMatchObject({
      failureSite: 'workshop.react',
      surface: 'workshop',
      captureMechanism: 'react',
    })
  })

  it('isolates failed transports', async () => {
    const transport = vi.fn<(report: FrontendErrorReportV1) => Promise<void>>()
      .mockRejectedValue(new Error('offline'))
    const enabled = createBrowserErrorReporter({
      surface: 'workshop', sessionId: 'session-12345678', transport,
    })
    expect(() => enabled.reportIssue('site', new Error('boom'))).not.toThrow()
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
  })

  it('marks reports truncated when optional context is clipped', () => {
    const transport = vi.fn<(report: FrontendErrorReportV1) => void>()
    const reporter = createBrowserErrorReporter({ surface: 'workshop', transport })

    reporter.reportIssue('gatekeeper.connect', new Error('boom'), {
      gatekeeperVendorId: 'v'.repeat(300),
    })

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      gatekeeperVendorId: 'v'.repeat(256),
      truncated: true,
    }))
  })

  it('deduplicates by the first stack frame rather than the full stack', () => {
    const transport = vi.fn<(report: FrontendErrorReportV1) => void>()
    const reporter = createBrowserErrorReporter({ surface: 'workshop', transport })
    const first = new Error('first')
    first.stack = 'Error: first\n    at capture (app.js:1:1)\n    at caller (app.js:2:2)'
    const sameFrame = new Error('different message')
    sameFrame.stack = 'Error: different message\n    at capture (app.js:1:1)\n    at other (app.js:3:3)'
    const differentFrame = new Error('first')
    differentFrame.stack = 'Error: first\n    at elsewhere (app.js:4:4)'

    reporter.reportIssue('browser.window-error', first)
    reporter.reportIssue('browser.window-error', sameFrame)
    reporter.reportIssue('browser.window-error', differentFrame)

    expect(transport).toHaveBeenCalledTimes(2)
  })
})

describe('forwardTrustedFrameError', () => {
  it('accepts only the expected opaque-origin frame and adds host-owned context', () => {
    const source = {} as Window
    const forward = vi.fn<(
      site: string,
      exception: typeof frameReport.exception | undefined,
      options?: BrowserReportOptions,
    ) => void>()
    const valid = {
      source,
      origin: 'null',
      data: {
        type: FRONTEND_ERROR_MESSAGE_TYPE,
        report: {
          ...frameReport,
          surface: 'gadget',
          sessionId: 'frame-claimed-session',
          gatekeeperVendorId: 'frame-claimed-vendor',
          browser: { family: 'Other' },
        },
      },
    } as unknown as MessageEvent
    const context = { surface: 'gatekeeper-app', gatekeeperVendorId: 'context' } as const
    expect(forwardTrustedFrameError(valid, source, context, forward)).toBe(true)
    expect(forward).toHaveBeenCalledWith('frame:frame.render', frameReport.exception,
      expect.objectContaining({
        captureMechanism: 'react',
        gatekeeperVendorId: 'context',
        handled: false,
        surface: 'gatekeeper-app',
      }))

    expect(forwardTrustedFrameError({ ...valid, origin: 'https://evil.example' } as MessageEvent,
      source, context, forward)).toBe(false)
    expect(forwardTrustedFrameError(valid, {} as Window, context, forward)).toBe(false)
  })

  it('keeps the host prefix without exceeding the failure-site bound', () => {
    const source = {} as Window
    const forward = vi.fn<(site: string) => void>()
    const event = {
      source,
      origin: 'null',
      data: {
        type: FRONTEND_ERROR_MESSAGE_TYPE,
        report: { ...frameReport, failureSite: 'x'.repeat(256) },
      },
    } as unknown as MessageEvent

    expect(forwardTrustedFrameError(event, source, {
      surface: 'configurator',
      gatekeeperVendorId: 'context',
    }, forward)).toBe(true)
    const site = forward.mock.calls[0][0] as string
    expect(site).toHaveLength(256)
    expect(site).toMatch(/^frame:/)
  })
})
