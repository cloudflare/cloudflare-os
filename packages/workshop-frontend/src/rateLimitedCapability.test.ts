import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { afterEach, expect, it } from 'vitest'
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
