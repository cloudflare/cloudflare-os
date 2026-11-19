import { describe, expect, it, vi } from 'vitest'
import { preferredModelChanged, subscribePreferredModelChanges } from './preferredModelChanges'

describe('preferredModelChanges', () => {
  it('tells each that is listening, until it stops', () => {
    const a = vi.fn<() => void>()
    const b = vi.fn<() => void>()
    const stopA = subscribePreferredModelChanges(a)
    const stopB = subscribePreferredModelChanges(b)
    preferredModelChanged()
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1])
    stopA()
    preferredModelChanged()
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2])
    stopB()
  })
})
