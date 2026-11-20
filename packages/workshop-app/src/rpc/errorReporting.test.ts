import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRONTEND_ERROR_MESSAGE_TYPE, type FrontendErrorReportV1 } from '@gadgets/error-reporting'
import { createReporter, forwardFrameError, type Reporter } from './errorReporting'

const reporterSending = (now = () => 0, reportedUserId?: () => string | undefined) => {
  const sent: FrontendErrorReportV1[] = []
  const reporter = createReporter({ send: (report) => void sent.push(report), now, reportedUserId })
  return { sent, reporter }
}

describe('createReporter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a failure once, however often it happens', () => {
    const { sent, reporter } = reporterSending()
    // Thrown from the one place, as a failure that happens again is.
    for (let n = 0; n < 2; n++) reporter.report('chat.load', new Error('boom'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ failureSite: 'chat.load', surface: 'workshop', severity: 'error', handled: true, captureMechanism: 'explicit' })
  })

  it('reports no more than ten different failures a minute, and again after it', () => {
    let at = 0
    const { sent, reporter } = reporterSending(() => at)
    for (let n = 0; n < 12; n++) reporter.report(`site.${n}`, new Error('boom'))
    expect(sent).toHaveLength(10)
    at = 60_000
    reporter.report('site.0', new Error('boom'))
    expect(sent).toHaveLength(11)
  })

  it('says only where the page is, never its query, fragment or credentials', () => {
    vi.stubGlobal('window', { location: { href: 'https://ada:secret@os.example/workspace/1?q=2#key' } })
    const { sent, reporter } = reporterSending()
    reporter.report('page', new Error('boom'))
    expect(sent[0].pageLocation).toBe('https://os.example/workspace/1')
  })

  it('says who is signed in as each report is made', () => {
    let user: string | undefined = 'u1'
    const { sent, reporter } = reporterSending(() => 0, () => user)
    reporter.report('first', new Error('boom'))
    user = undefined
    reporter.report('second', new Error('boom'))
    expect(sent.map(({ reportedUserId }) => reportedUserId)).toEqual(['u1', undefined])
  })

  it('cuts a long place short, and says so', () => {
    const { sent, reporter } = reporterSending()
    reporter.report('x'.repeat(5000), new Error('boom'))
    expect(sent[0].failureSite.length).toBeLessThan(5000)
    expect(sent[0].truncated).toBe(true)
  })

  it('never throws, even when sending does', () => {
    const reporter = createReporter({ send: () => { throw new Error('offline') } })
    expect(() => reporter.report('site', new Error('boom'))).not.toThrow()
  })
})

describe('forwardFrameError', () => {
  const frameReport = {
    failureSite: 'frame.render',
    severity: 'error',
    handled: false,
    captureMechanism: 'react',
    exception: { type: 'Error', message: 'boom', stack: 'Error: boom' },
  } as const
  const context = { surface: 'gatekeeper-app', gatekeeperVendorId: 'example' } as const

  it('takes only its own frame’s, at its opaque origin, and says the rest itself', () => {
    const source = {} as Window
    const forward = vi.fn<Reporter['reportSerialized']>()
    const event = {
      source,
      origin: 'null',
      data: {
        type: FRONTEND_ERROR_MESSAGE_TYPE,
        // What the frame claims of itself, none of which is kept.
        report: { ...frameReport, surface: 'workshop', gatekeeperVendorId: 'claimed', pageLocation: 'https://evil.example/', reportedUserId: 'someone' },
      },
    }
    expect(forwardFrameError(event, source, context, forward)).toBe(true)
    expect(forward).toHaveBeenCalledWith('frame:frame.render', frameReport.exception, { severity: 'error', handled: false, captureMechanism: 'react', ...context })

    expect(forwardFrameError({ ...event, origin: 'https://evil.example' }, source, context, forward)).toBe(false)
    expect(forwardFrameError(event, {} as Window, context, forward)).toBe(false)
    expect(forwardFrameError({ ...event, data: { type: 'handshake' } }, source, context, forward)).toBe(false)
    expect(forward).toHaveBeenCalledTimes(1)
  })

  it('keeps its prefix within the bound on a place', () => {
    const source = {} as Window
    const forward = vi.fn<Reporter['reportSerialized']>()
    const event = { source, origin: 'null', data: { type: FRONTEND_ERROR_MESSAGE_TYPE, report: { ...frameReport, failureSite: 'x'.repeat(256) } } }
    expect(forwardFrameError(event, source, context, forward)).toBe(true)
    expect(forward.mock.calls[0]![0]).toHaveLength(256)
    expect(forward.mock.calls[0]![0]).toMatch(/^frame:/)
  })

  it('reports a frame’s failures apart from the app’s own, each up to its own limit', () => {
    const { sent, reporter } = reporterSending()
    for (let n = 0; n < 12; n++) reporter.reportSerialized(`frame:${n}`, undefined, { surface: 'gatekeeper-app' })
    reporter.report('chat.load', new Error('boom'))
    expect(sent.filter(({ surface }) => surface === 'gatekeeper-app')).toHaveLength(10)
    expect(sent.filter(({ surface }) => surface === 'workshop')).toHaveLength(1)
  })
})
