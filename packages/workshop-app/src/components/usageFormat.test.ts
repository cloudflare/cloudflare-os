import { describe, expect, it } from 'vitest'
import { formatCost, formatDuration, formatExactCost, formatTokenCount, formatTotalCost } from './usageFormat'

describe('formatTokenCount', () => {
  it('is whole below a thousand', () => {
    expect(formatTokenCount(842)).toBe('842')
  })

  it('has a decimal up to a hundred thousand, and not a needless one', () => {
    expect(formatTokenCount(83_312)).toBe('83.3K')
    expect(formatTokenCount(12_000)).toBe('12K')
    expect(formatTokenCount(1_500)).toBe('1.5K')
  })

  it('is whole thousands beyond that', () => {
    expect(formatTokenCount(124_300)).toBe('124K')
    expect(formatTokenCount(262_144)).toBe('262K')
    expect(formatTokenCount(200_000)).toBe('200K')
  })

  it('is millions from a million, and never says 1000K', () => {
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(1_250_000)).toBe('1.3M')
    expect(formatTokenCount(999_600)).toBe('1M')
  })
})

describe('costs', () => {
  it('gives a chat’s to four places, and nothing for none', () => {
    expect(formatCost(0.04123)).toBe('$0.0412')
    expect(formatCost(0)).toBe('$0')
  })

  it('gives a workspace’s as a total', () => {
    expect(formatTotalCost(0)).toBe('$0')
    expect(formatTotalCost(0.004)).toBe('<$0.01')
    expect(formatTotalCost(1.234)).toBe('$1.23')
  })

  it('can give one to the last place', () => {
    expect(formatExactCost(0.041237)).toBe('$0.041237')
  })
})

describe('formatDuration', () => {
  it('says it the way a person would', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(12_400)).toBe('12 s')
    expect(formatDuration(125_000)).toBe('2 min 5 s')
    expect(formatDuration(120_000)).toBe('2 min')
  })
})
