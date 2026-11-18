import { describe, expect, it } from 'vitest'
import { formatCountdown } from './useCountdown'

describe('formatCountdown', () => {
  it('says the hours, minutes and seconds left, from the largest there is', () => {
    expect(formatCountdown((4 * 3600 + 12 * 60 + 9) * 1000)).toBe('4h 12m 9s')
    expect(formatCountdown((12 * 60 + 9) * 1000)).toBe('12m 9s')
    expect(formatCountdown(9_500)).toBe('9s')
  })

  it('keeps the minutes under hours, even when there are none', () => {
    expect(formatCountdown((3600 + 5) * 1000)).toBe('1h 0m 5s')
  })

  it('is at nothing once the time has come', () => {
    expect(formatCountdown(0)).toBe('0s')
    expect(formatCountdown(-1000)).toBe('0s')
  })
})
