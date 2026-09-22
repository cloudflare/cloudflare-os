import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimitedCapability } from './rateLimitedCapability'

const options = (overrides: Partial<Parameters<typeof createRateLimitedCapability>[1]> = {}) => ({
  maxConcurrency: 1,
  maxCallsPerMinute: 10,
  maxPendingCalls: 10,
  onRateLimit: 'throttle' as const,
  label: 'Gatekeeper app',
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createRateLimitedCapability disposal', () => {
  it('rejects queued work at disposal and leaves the active call able to resolve', async () => {
    let resolveActive!: (value: string) => void
    const target = {
      load: vi.fn(() => new Promise<string>(resolve => { resolveActive = resolve })),
    }
    const { capability, dispose } = createRateLimitedCapability(target, options())

    const active = capability.load()
    await Promise.resolve()
    const queued = capability.load()
    dispose()

    await expect(queued).rejects.toThrow('Gatekeeper app capability has been disposed.')
    resolveActive('loaded')
    await expect(active).resolves.toBe('loaded')
    expect(target.load).toHaveBeenCalledOnce()
  })

  it('rejects calls made after disposal without invoking the target', async () => {
    const target = { load: vi.fn(async () => 'loaded') }
    const { capability, dispose } = createRateLimitedCapability(target, options())
    dispose()

    await expect(capability.load()).rejects.toThrow('Gatekeeper app capability has been disposed.')
    expect(target.load).not.toHaveBeenCalled()
  })

  it('cancels a throttle resume timer and does not drain after disposal', async () => {
    vi.useFakeTimers()
    const target = { load: vi.fn(async () => 'loaded') }
    const { capability, dispose } = createRateLimitedCapability(target, options({
      maxCallsPerMinute: 1,
    }))

    await capability.load()
    const queued = capability.load()
    await Promise.resolve()
    dispose()
    dispose()

    await expect(queued).rejects.toThrow('Gatekeeper app capability has been disposed.')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(target.load).toHaveBeenCalledOnce()
  })
})
