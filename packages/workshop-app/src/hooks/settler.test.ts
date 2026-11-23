import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settler } from './settler'

const OPTIONS = { wait: 500, maxWait: 1500 }

describe('Settler', () => {
  let shown: string[]
  const settler = () => new Settler<string>(OPTIONS, (value) => shown.push(value))

  beforeEach(() => {
    vi.useFakeTimers()
    shown = []
  })
  afterEach(() => vi.useRealTimers())

  it('shows the first value at once, and a change only once it has held still', () => {
    const s = settler()
    s.set('a')
    expect(shown).toEqual(['a'])
    s.set('b')
    vi.advanceTimersByTime(499)
    expect(shown).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(shown).toEqual(['a', 'b'])
  })

  it('waits again each time it changes, and shows the latest', () => {
    const s = settler()
    s.set('a')
    s.set('b')
    vi.advanceTimersByTime(300)
    s.set('c')
    vi.advanceTimersByTime(300)
    s.set('d')
    vi.advanceTimersByTime(499)
    expect(shown).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(shown).toEqual(['a', 'd'])
  })

  it('does not hold one thing for as long as it keeps changing: the latest is shown by `maxWait`', () => {
    const s = settler()
    s.set('0')
    // Changing every 200ms for a long time: never still for 500ms.
    for (let i = 1; i <= 30; i++) {
      s.set(String(i))
      vi.advanceTimersByTime(200)
    }
    // Shown every 1500ms or so rather than never, and each time the latest at that moment.
    expect(shown.length).toBeGreaterThanOrEqual(4)
    expect(shown.length).toBeLessThanOrEqual(6)
    expect(shown.slice(1).every((value, index) => Number(value) > Number(shown[index]))).toBe(true)
    for (let i = 1; i < shown.length; i++) expect(Number(shown[i]) - Number(shown[i - 1])).toBeGreaterThanOrEqual(6)
  })

  it('is not made to wait longer by being told again of what it is waiting to show', () => {
    const s = settler()
    s.set('a')
    s.set('b')
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(40)
      s.set('b')
    }
    vi.advanceTimersByTime(100)
    expect(shown).toEqual(['a', 'b'])
  })

  it('shows nothing for a value that went back to what is shown', () => {
    const s = settler()
    s.set('a')
    s.set('b')
    vi.advanceTimersByTime(300)
    s.set('a')
    vi.advanceTimersByTime(5000)
    expect(shown).toEqual(['a'])
  })

  it('shows what comes after a rest at once', () => {
    const s = settler()
    s.set('a')
    s.rest()
    s.set('b')
    expect(shown).toEqual(['a', 'b'])
    s.set('c')
    vi.advanceTimersByTime(500)
    expect(shown).toEqual(['a', 'b', 'c'])
  })

  it('shows nothing it was waiting to show once it is let go of', () => {
    const s = settler()
    s.set('a')
    s.set('b')
    s.dispose()
    vi.advanceTimersByTime(5000)
    expect(shown).toEqual(['a'])
  })

  it('takes an equality of its own for values that are not primitives', () => {
    const seen: Array<{ n: number }> = []
    const s = new Settler<{ n: number }>(OPTIONS, (value) => seen.push(value), (a, b) => a.n === b.n)
    s.set({ n: 1 })
    s.set({ n: 1 })
    vi.advanceTimersByTime(5000)
    expect(seen).toEqual([{ n: 1 }])
  })
})
