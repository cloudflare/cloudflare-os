import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepSubscribed } from './keepSubscribed'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// Subscriptions made so far, each with what lets its listener go and whether it is current, and
// the leases let go of.
const backend = (outcomes: ('ok' | 'fail')[]) => {
  const made: { released: () => void; current: () => boolean }[] = []
  const disposed: number[] = []
  const subscribe = (released: () => void, current: () => boolean) => {
    const index = made.length
    made.push({ released, current })
    return outcomes[index] === 'fail' ? Promise.reject(new Error('down')) : Promise.resolve({ [Symbol.dispose]: () => disposed.push(index) })
  }
  return { subscribe, made, disposed }
}

describe('keepSubscribed', () => {
  it('tries a failed subscription again after a wait that doubles', async () => {
    const { subscribe, made } = backend(['fail', 'fail', 'ok'])
    keepSubscribed(subscribe)
    await vi.advanceTimersByTimeAsync(999)
    expect(made).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(made).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(made).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(made).toHaveLength(3)
  })

  it('subscribes again at once when the server lets go of the listener, letting go of the old lease', async () => {
    const { subscribe, made, disposed } = backend(['ok', 'ok'])
    keepSubscribed(subscribe)
    await vi.advanceTimersByTimeAsync(0)
    made[0].released()
    await vi.advanceTimersByTimeAsync(0)
    expect(made).toHaveLength(2)
    expect(made[0].current()).toBe(false)
    expect(made[1].current()).toBe(true)
    expect(disposed).toEqual([0])
  })

  it('takes a subscribe that throws as one that failed', async () => {
    let calls = 0
    keepSubscribed(() => {
      calls++
      throw new Error('not mocked')
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
  })

  it('lets go of the lease once stopped, and subscribes no more', async () => {
    const { subscribe, made, disposed } = backend(['ok'])
    const stop = keepSubscribed(subscribe)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(disposed).toEqual([0])
    expect(made[0].current()).toBe(false)
    made[0].released()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(made).toHaveLength(1)
  })
})
