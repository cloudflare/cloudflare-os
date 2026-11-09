import { describe, expect, it } from 'vitest'
import { agoLabel, libraryBucket, libraryTimeLabel } from './libraryTime'

const now = new Date(2026, 10, 8, 15, 0)
const at = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000)

describe('libraryTimeLabel', () => {
  it('counts hours within today', () => {
    expect(libraryTimeLabel(at(0, 1), now)).toBe('1 hour ago')
    expect(libraryTimeLabel(at(0, 4), now)).toBe('4 hours ago')
  })

  it('names yesterday, then weekdays, then last week', () => {
    expect(libraryTimeLabel(at(1), now)).toBe('Yesterday')
    expect(libraryTimeLabel(at(3), now)).toBe(at(3).toLocaleDateString(undefined, { weekday: 'long' }))
    expect(libraryTimeLabel(at(9), now)).toBe('Last week')
  })

  it('falls back to a short date', () => {
    expect(libraryTimeLabel(at(40), now)).toBe(at(40).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  })
})

describe('libraryBucket', () => {
  it('splits the week from what came before', () => {
    expect(libraryBucket(at(2), now)).toBe('recent')
    expect(libraryBucket(at(8), now)).toBe('earlier')
  })
})

describe('agoLabel', () => {
  it('counts minutes, hours, then days', () => {
    expect(agoLabel(new Date(now.getTime() - 20_000), now)).toBe('Just now')
    expect(agoLabel(new Date(now.getTime() - 8 * 60_000), now)).toBe('8 mins ago')
    expect(agoLabel(at(0, 1), now)).toBe('1 hour ago')
    expect(agoLabel(at(2), now)).toBe('2 days ago')
  })

  it('falls back to a short date after a month', () => {
    expect(agoLabel(at(40), now)).toBe(at(40).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  })
})
