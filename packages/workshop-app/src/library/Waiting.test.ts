import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { Waiting } from './Waiting'

const gadget = (waiting?: number, role?: OutputSummary['role']) => ({ waiting, role }) as OutputSummary

describe('Waiting', () => {
  afterEach(() => vi.useRealTimers())

  it('counts what waits on the user to decide, across gadgets, but not on gadgets they only use', async () => {
    const waiting = new Waiting(async () => ({ outputs: [gadget(2), gadget(), gadget(3), gadget(4, 'use')] }))
    await waiting.refresh()
    expect(waiting.getSnapshot()).toEqual({ total: 5, gadgets: 2 })
  })

  it('tells its listeners only of a change, and keeps what it showed when a read fails', async () => {
    let outputs = [gadget(1)]
    let fail = false
    const waiting = new Waiting(async () => {
      if (fail) throw new Error('offline')
      return { outputs }
    })
    const heard = vi.fn<() => void>()
    waiting.subscribe(heard)
    await waiting.refresh()
    await waiting.refresh()
    expect(heard).toHaveBeenCalledTimes(1)
    fail = true
    await waiting.refresh()
    expect(waiting.getSnapshot().total).toBe(1)
    fail = false
    outputs = []
    await waiting.refresh()
    expect(waiting.getSnapshot()).toEqual({ total: 0, gadgets: 0 })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('reads again every so often once started, and not once stopped', async () => {
    vi.useFakeTimers()
    const read = vi.fn<() => Promise<{ outputs: OutputSummary[] }>>(async () => ({ outputs: [] }))
    let hidden = false
    let changed: (() => void) | undefined
    const waiting = new Waiting(read, { everyMs: 1000, sight: { hidden: () => hidden, watch: (given) => ((changed = given), () => {}) } })
    waiting.start()
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
    // Not while out of sight, and at once on coming back.
    hidden = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
    hidden = false
    changed?.()
    expect(read).toHaveBeenCalledTimes(4)
    waiting.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(4)
  })
})
