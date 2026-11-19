import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const load = async (systemReduces: boolean, kept?: string) => {
  const store = new Map<string, string>(kept ? [['workshop-app:motion', kept]] : [])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
  vi.stubGlobal('matchMedia', () => ({ matches: systemReduces, addEventListener: () => {} }))
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } })
  vi.resetModules()
  return import('./motion')
}

describe('motion level', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('is full until the system asks for less', async () => {
    expect((await load(false)).readMotionLevel()).toBe('full')
    expect((await load(true)).readMotionLevel()).toBe('off')
  })

  it('is what was chosen, whatever the system asks', async () => {
    expect((await load(true, JSON.stringify({ level: 'calm' }))).readMotionLevel()).toBe('calm')
  })

  it('ignores a choice it does not know', async () => {
    expect((await load(false, JSON.stringify({ level: 'wild' }))).readMotionLevel()).toBe('full')
  })

  it('puts a new choice on the root and tells listeners', async () => {
    const motion = await load(false)
    const heard = vi.fn<() => void>()
    motion.subscribeMotionLevel(heard)
    motion.writeMotionLevel('off')
    expect(motion.isMotionOff()).toBe(true)
    expect(document.documentElement.dataset.motion).toBe('off')
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
