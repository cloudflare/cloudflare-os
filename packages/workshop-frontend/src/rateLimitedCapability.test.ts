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

it.each(['reject', 'throttle'] as const)('rejects queued and later calls after %s disposal', async (onRateLimit) => {
  const pending = Promise.withResolvers<string>()
  const ping = vi.fn<() => Promise<string>>(() => pending.promise)
  const limited = createRateLimitedCapability({ ping }, {
    maxConcurrency: 1, maxCallsPerMinute: 10, maxPendingCalls: 4, onRateLimit, label: 'Test',
  })
  const running = limited.capability.ping()
  const queued = limited.capability.ping()
  await Promise.resolve()
  limited.dispose()
  pending.resolve('pong')
  expect(await running).toBe('pong')
  await expect(queued).rejects.toThrow('Test connection changed.')
  await expect(limited.capability.ping()).rejects.toThrow('Test connection changed.')
  expect(ping).toHaveBeenCalledTimes(1)
})
