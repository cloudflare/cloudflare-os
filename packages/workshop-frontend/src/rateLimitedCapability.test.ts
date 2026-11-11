import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { createRateLimitedCapability } from './rateLimitedCapability'

class Backend extends RpcTarget {
  ping() { return 'pong' }
}

const ports: MessagePort[] = []
afterEach(() => {
  for (const port of ports.splice(0)) port.close()
})

// Cap'n Web looks a remote call's method up on the exported object, so the proxy's members are what
// a sandboxed frame can call.
it("forwards a binding's methods, but none of its stub's own members", async () => {
  const { port1, port2 } = new MessageChannel()
  ports.push(port1, port2)
  newMessagePortRpcSession(port1, new Backend())
  using stub = newMessagePortRpcSession<Backend>(port2)
  const limited = createRateLimitedCapability(stub, {
    maxConcurrency: 1, maxCallsPerMinute: 10, maxPendingCalls: 4, onRateLimit: 'reject', label: 'Test',
  })

  expect(await limited.capability.ping()).toBe('pong')
  // dup() would hand the frame the stub itself, outside the limits.
  expect(limited.capability.dup).toBeUndefined()
  expect(limited.capability.onRpcBroken).toBeUndefined()
})

// A capability whose calls finish only when the test says so. The limiter starts each call in a
// microtask, so the test lets one pass before it counts.
const held = () => {
  const pending: (() => void)[] = []
  let calls = 0
  const capability = {
    ping: () => {
      calls++
      const { promise, resolve } = Promise.withResolvers<string>()
      pending.push(() => resolve('pong'))
      return promise
    },
  }
  return { capability, finish: () => pending.shift()?.(), calls: () => calls }
}
const started = () => Promise.resolve()

it('ends at dispose: rejects queued calls, refuses new ones, and drains nothing after', async () => {
  const backend = held()
  const limited = createRateLimitedCapability(backend.capability, {
    maxConcurrency: 1, maxCallsPerMinute: 10, maxPendingCalls: 4, onRateLimit: 'throttle', label: 'Test',
  })
  const inFlight = limited.capability.ping()
  const queued = limited.capability.ping()
  await started()
  expect(backend.calls()).toBe(1)

  limited.dispose()
  await expect(queued).rejects.toThrow('Test has closed.')
  await expect(limited.capability.ping()).rejects.toThrow('Test has closed.')
  backend.finish()
  expect(await inFlight).toBe('pong')
  expect(backend.calls()).toBe(1)
})

it('arms no resume timer after dispose, though a call in flight finishes in a full window', async () => {
  vi.useFakeTimers()
  try {
    const backend = held()
    const limited = createRateLimitedCapability(backend.capability, {
      maxConcurrency: 2, maxCallsPerMinute: 1, maxPendingCalls: 4, onRateLimit: 'throttle', label: 'Test',
    })
    const inFlight = limited.capability.ping()
    const throttled = limited.capability.ping().catch((error: Error) => error.message)
    await started()
    limited.dispose()
    backend.finish()
    await inFlight
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(await throttled).toBe('Test has closed.')
    expect(backend.calls()).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})
