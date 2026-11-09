import { describe, expect, it } from 'vitest'
import { ownerFirstName, viewAgeLabel, viewMoment, viewStill } from './viewTime'

const at = (day: number, hour = 10, minute = 42) => new Date(2026, 10, day, hour, minute)

describe('viewMoment', () => {
  it('ages in place: today, yesterday, then the date', () => {
    const now = at(6, 15)
    expect(viewMoment(at(6), now)).toBe('today, 10:42 AM')
    expect(viewMoment(at(5), now)).toBe('yesterday, 10:42 AM')
    expect(viewMoment(new Date(2026, 9, 16, 10, 42), now)).toBe('Oct 16')
  })

  it('counts calendar days, not 24-hour spans', () => {
    expect(viewMoment(at(5, 23, 50), at(6, 0, 5))).toBe('yesterday, 11:50 PM')
  })
})

describe('viewStill', () => {
  it('is absolute, for assistive tech', () => {
    expect(viewStill(at(6))).toBe('Nov 6, 10:42 AM')
  })
})

describe('viewAgeLabel', () => {
  it('appears at two weeks and counts weeks', () => {
    const taken = at(1)
    expect(viewAgeLabel(taken, at(14))).toBeNull()
    expect(viewAgeLabel(taken, at(15))).toBe('2 weeks old')
    expect(viewAgeLabel(taken, at(22))).toBe('3 weeks old')
  })
})

describe('ownerFirstName', () => {
  it('uses the first name, falling back to the email', () => {
    expect(ownerFirstName({ type: 'user', id: 'phillip@cloudflare.com', name: 'Phillip Jones' })).toBe('Phillip')
    expect(ownerFirstName({ type: 'user', id: 'phillip@cloudflare.com', name: ' ' })).toBe('phillip@cloudflare.com')
  })
})
