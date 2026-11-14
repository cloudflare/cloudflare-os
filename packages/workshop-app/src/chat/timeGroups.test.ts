import { describe, expect, it } from 'vitest'
import { groupByTime } from './timeGroups'

// A Thursday afternoon.
const NOW = new Date(2026, 10, 12, 15, 0)
const at = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month, day, hour)
const labels = (dates: Date[]) =>
  groupByTime(dates.map((date, index) => ({ value: index, at: date })), NOW).map(({ label, entries }) => [label, entries.map(({ value }) => value)])

describe('groupByTime', () => {
  it('gives a day with enough in it a group of its own', () => {
    expect(labels([at(10, 12, 14), at(10, 12, 9), at(10, 11, 20), at(10, 11, 8)])).toEqual([
      ['Today', [0, 1]],
      ['Yesterday', [2, 3]],
    ])
  })

  it('folds a quiet day into the one before it, and leaves the oldest apart', () => {
    expect(labels([at(10, 12), at(10, 10), at(10, 9)])).toEqual([
      ['Since Tuesday', [0, 1]],
      ['Monday', [2]],
    ])
    expect(labels([at(10, 12, 14), at(10, 12, 9), at(10, 11), at(10, 10)])).toEqual([
      ['Today', [0, 1]],
      ['Tuesday to yesterday', [2, 3]],
    ])
  })

  it('tells what is older than a week apart by month', () => {
    expect(labels([at(9, 3), at(8, 5), at(7, 20), at(7, 2)])).toEqual([
      ['September – October', [0, 1]],
      ['August', [2, 3]],
    ])
    expect(labels([at(0, 5), at(11, 20, 12, 2025)])).toEqual([['December 2025 – January 2026', [0, 1]]])
  })

  it('says when each was in full, apart from its group', () => {
    const [today, yesterday] = groupByTime(
      [{ value: 'a', at: at(10, 12, 13) }, { value: 'b', at: at(10, 12, 9) }, { value: 'c', at: at(10, 11, 14) }, { value: 'd', at: at(10, 11, 9) }],
      NOW,
    )
    expect(today.entries.map(({ time }) => time)).toEqual(['2 hours ago', '6 hours ago'])
    expect(yesterday.entries.map(({ time }) => time)).toEqual(['Yesterday', 'Yesterday'])
  })

  it('takes one with no time to be from now', () => {
    expect(labels([undefined as unknown as Date, at(10, 12)])).toEqual([['Today', [0, 1]]])
  })
})
