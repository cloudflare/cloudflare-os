import { describe, expect, it } from 'vitest'
import { formatActivity, formatActivityShort } from './formatActivity'

// Wednesday 28 October 2026, 09:00 local time.
const now = new Date(2026, 9, 28, 9, 0, 0)
const ago = (ms: number) => new Date(now.getTime() - ms)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('formatActivity', () => {
  it('says "Just now" under a minute, including for a timestamp slightly ahead of this clock', () => {
    expect(formatActivity(ago(30_000), now)).toBe('Just now')
    expect(formatActivity(ago(-30_000), now)).toBe('Just now')
  })

  it('counts minutes, then hours, within a day', () => {
    expect(formatActivity(ago(MINUTE), now)).toBe('1 min ago')
    expect(formatActivity(ago(59 * MINUTE), now)).toBe('59 min ago')
    expect(formatActivity(ago(HOUR), now)).toBe('1 hour ago')
    expect(formatActivity(ago(5 * HOUR), now)).toBe('5 hours ago')
    expect(formatActivity(ago(23 * HOUR), now)).toBe('23 hours ago')
  })

  it('switches to calendar days after 24 hours, so late last night is "Yesterday"', () => {
    expect(formatActivity(ago(25 * HOUR), now)).toBe('Yesterday')
  })

  it('names the weekday within the past week, and gives a date from a week on', () => {
    expect(formatActivity(new Date(2026, 9, 26, 12), now)).toBe('Monday')
    expect(formatActivity(new Date(2026, 9, 22, 12), now)).toBe('Thursday')
    expect(formatActivity(new Date(2026, 9, 21, 12), now)).toBe('Oct 21')
  })

  it('adds the year only when it is not the current one', () => {
    expect(formatActivity(new Date(2026, 7, 2, 12), now)).toBe('Aug 2')
    expect(formatActivity(new Date(2025, 8, 12, 12), now)).toBe('Sep 12, 2025')
  })
})

describe('formatActivity without ago', () => {
  it('leaves it off minutes and hours, and says the rest as before', () => {
    expect(formatActivity(ago(5 * MINUTE), now, { ago: false })).toBe('5 min')
    expect(formatActivity(ago(HOUR), now, { ago: false })).toBe('1 hour')
    expect(formatActivity(ago(30_000), now, { ago: false })).toBe('Just now')
    expect(formatActivity(ago(25 * HOUR), now, { ago: false })).toBe('Yesterday')
  })
})

describe('formatActivityShort', () => {
  it('says it in a letter: now, minutes, hours, then calendar days within a week, then a date', () => {
    expect(formatActivityShort(ago(30_000), now)).toBe('now')
    expect(formatActivityShort(ago(5 * MINUTE), now)).toBe('5m')
    expect(formatActivityShort(ago(3 * HOUR), now)).toBe('3h')
    expect(formatActivityShort(ago(25 * HOUR), now)).toBe('1d')
    expect(formatActivityShort(new Date(2026, 9, 22, 12), now)).toBe('6d')
    expect(formatActivityShort(new Date(2026, 9, 2, 12), now)).toBe('Oct 2')
  })
})
