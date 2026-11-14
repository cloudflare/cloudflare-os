import { describe, expect, it } from 'vitest'
import { formatUsage } from './usage'

describe('formatUsage', () => {
  it('rounds the tokens as people say them', () => {
    expect(formatUsage({ tokens: 1 })).toBe('1 token')
    expect(formatUsage({ tokens: 950 })).toBe('950 tokens')
    expect(formatUsage({ tokens: 12_430 })).toBe('12.4K tokens')
  })

  it('adds the cost once it comes to a cent', () => {
    expect(formatUsage({ tokens: 2_000_000, cost: 1.234 })).toBe('2M tokens · $1.23')
    expect(formatUsage({ tokens: 300, cost: 0.001 })).toBe('300 tokens')
  })
})
