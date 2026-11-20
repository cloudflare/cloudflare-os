import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chosenMotionLevel, writeMotionLevel } from './motion'

const system = vi.hoisted(() => ({ reduces: false }))

vi.mock('@gadgets/ui', () => ({
  MOTION_LEVELS: ['full', 'calm', 'off'],
  systemMotionLevel: { read: () => (system.reduces ? 'off' : 'full'), subscribe: () => () => {} },
}))

const keep = (kept?: string) => {
  const store = new Map<string, string>(kept ? [['workshop-app:motion', kept]] : [])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
}

describe('motion level', () => {
  beforeEach(() => {
    system.reduces = false
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('removeEventListener', () => {})
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is full until the system asks for less', () => {
    keep()
    expect(chosenMotionLevel.read()).toBe('full')
    system.reduces = true
    expect(chosenMotionLevel.read()).toBe('off')
  })

  it('is what was chosen, whatever the system asks', () => {
    keep(JSON.stringify({ level: 'calm' }))
    system.reduces = true
    expect(chosenMotionLevel.read()).toBe('calm')
  })

  it('ignores a choice it does not know', () => {
    keep(JSON.stringify({ level: 'wild' }))
    expect(chosenMotionLevel.read()).toBe('full')
  })

  it('keeps a new choice and tells listeners', () => {
    keep()
    const heard = vi.fn<() => void>()
    const stop = chosenMotionLevel.subscribe(heard)
    writeMotionLevel('off')
    expect(chosenMotionLevel.read()).toBe('off')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    writeMotionLevel('full')
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
