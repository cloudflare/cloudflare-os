import { describe, expect, it } from 'vitest'
import { formatLimitWindow, spendLimitDetail } from './SpendLimitCard'

describe('formatLimitWindow', () => {
  it('names the window in its largest whole unit', () => {
    expect(formatLimitWindow(86400)).toBe('24 hours')
    expect(formatLimitWindow(604800)).toBe('7 days')
    expect(formatLimitWindow(3600)).toBe('hour')
    expect(formatLimitWindow(7200)).toBe('2 hours')
    expect(formatLimitWindow(90)).toBe('90 seconds')
  })
})

describe('spendLimitDetail', () => {
  it('states the limit, and promises no reset time for a rolling window', () => {
    expect(spendLimitDetail({ cost: 0.1, windowSeconds: 86400, sliding: true }))
      .toBe('AI usage is limited to $0.10 over a rolling 24 hours. Try again a little later.')
    expect(spendLimitDetail({ cost: 250, windowSeconds: 3600, sliding: false }))
      .toBe('AI usage is limited to $250.00 every hour. Try again once the limit resets.')
  })

  it('keeps a limit under a cent from reading as nothing', () => {
    expect(spendLimitDetail({ cost: 0.005, windowSeconds: 60, sliding: true }))
      .toContain('$0.005 over a rolling minute')
  })
})
