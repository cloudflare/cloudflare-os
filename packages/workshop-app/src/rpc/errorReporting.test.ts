import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FrontendErrorReportV1 } from '@gadgets/error-reporting'
import { createReporter } from './errorReporting'

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
