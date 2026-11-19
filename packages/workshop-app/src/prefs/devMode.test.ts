import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const load = async (kept: Record<string, string> = {}) => {
  const store = new Map<string, string>(Object.entries(kept))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  })
  vi.resetModules()
  const [dev, live] = await Promise.all([import('./devMode'), import('./liveWork')])
  return { dev, live, store }
}

describe('developer mode', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('is off until it is turned on, and kept', async () => {
    const { dev, store } = await load()
    expect(dev.readDevMode()).toBe(false)
    dev.writeDevMode(true)
    expect(dev.readDevMode()).toBe(true)
    expect(store.get('workshop-app:developer-mode')).toBe('true')
  })

  it('ignores a value that is not on or off', async () => {
    expect((await load({ 'workshop-app:developer-mode': '"yes"' })).dev.readDevMode()).toBe(false)
  })

  it('tells listeners', async () => {
    const { dev } = await load()
    const heard = vi.fn<() => void>()
    dev.subscribeDevMode(heard)
    dev.writeDevMode(true)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('opens what the agent is doing when it is turned on, and not again once that was put away', async () => {
    const { dev, live } = await load()
    expect(live.readLiveWorkOpen()).toBe(false)
    dev.writeDevMode(true)
    expect(live.readLiveWorkOpen()).toBe(true)
    live.writeLiveWorkOpen(false)
    dev.writeDevMode(true)
    expect(live.readLiveWorkOpen()).toBe(false)
  })

  it('opens it again when turned off and on', async () => {
    const { dev, live } = await load()
    dev.writeDevMode(true)
    live.writeLiveWorkOpen(false)
    dev.writeDevMode(false)
    expect(live.readLiveWorkOpen()).toBe(false)
    dev.writeDevMode(true)
    expect(live.readLiveWorkOpen()).toBe(true)
  })
})
