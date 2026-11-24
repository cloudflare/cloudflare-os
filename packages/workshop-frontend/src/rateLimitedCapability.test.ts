import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { createRateLimitedCapability } from './rateLimitedCapability'

class Backend extends RpcTarget {
  ping() { return 'pong' }
}

const ports: MessagePort[] = []
afterEach(() => {
  vi.useRealTimers()
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

// A capability whose calls finish only when the test says so. The limiter starts each call, and
// drains again after each one finishes, in a microtask, so a test flushes that work before it counts.
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

it('ends at dispose: rejects every call the capability has not received, and drains nothing after', async () => {
  vi.useFakeTimers()
  const backend = held()
  const limited = createRateLimitedCapability(backend.capability, {
    maxConcurrency: 2, maxCallsPerMinute: 10, maxPendingCalls: 4, onRateLimit: 'throttle', label: 'Test',
  })
  const received = limited.capability.ping()
  await vi.advanceTimersByTimeAsync(0)
  // Out of the queue, but not yet started.
  const dispatching = limited.capability.ping().catch((error: Error) => error.message)
  const queued = limited.capability.ping().catch((error: Error) => error.message)

  limited.dispose()
  await expect(limited.capability.ping()).rejects.toThrow('Test has closed.')
  backend.finish()
  expect(await received).toBe('pong')
  await vi.advanceTimersByTimeAsync(0)
  expect(backend.calls()).toBe(1)
  expect(await dispatching).toBe('Test has closed.')
  expect(await queued).toBe('Test has closed.')
})

it('arms no resume timer after dispose, though a call in flight finishes in a full window', async () => {
  vi.useFakeTimers()
  const backend = held()
  const limited = createRateLimitedCapability(backend.capability, {
    maxConcurrency: 2, maxCallsPerMinute: 1, maxPendingCalls: 4, onRateLimit: 'throttle', label: 'Test',
  })
  const inFlight = limited.capability.ping()
  const throttled = limited.capability.ping().catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(0)
  limited.dispose()
  backend.finish()
  await inFlight
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await throttled).toBe('Test has closed.')
  expect(backend.calls()).toBe(1)
})
