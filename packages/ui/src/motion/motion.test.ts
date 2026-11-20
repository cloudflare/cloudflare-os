import { describe, expect, it, vi } from 'vitest'
import { isMotionOff, provideMotionLevel, readMotionLevel, subscribeMotionLevel, type MotionLevel } from './motion'

describe('motion level', () => {
  it('comes from the source it is given, and is heard of through it', () => {
    let level: MotionLevel = 'calm'
    const listeners = new Set<() => void>()
    provideMotionLevel({
      read: () => level,
      subscribe: (onChange) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
    })
    const heard = vi.fn<() => void>()
    const stop = subscribeMotionLevel(heard)
    expect(readMotionLevel()).toBe('calm')
    level = 'off'
    for (const listener of listeners) listener()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(isMotionOff()).toBe(true)
    stop()
    expect(listeners.size).toBe(0)
  })
})
