import { RpcTarget } from 'capnweb'

// Shared, rate-limited proxy around an arbitrary gatekeeper-defined capability exposed to a
// sandboxed iframe (the resource configurator and full-page gatekeeper apps both use it). The
// iframe is untrusted (gatekeeper-authored HTML running in a sandbox), so we cap concurrency, rate,
// and backlog to keep a misbehaving app from hammering the backend. The capability's method shape is
// gatekeeper-defined and opaque to Workshop, so we treat it as `any` and let Cap'n Web carry calls.

export type RateLimitOptions = {
  maxConcurrency: number
  maxCallsPerMinute: number
  maxPendingCalls: number
  /**
   * What to do when the per-minute window is full. `throttle` pauses and resumes once the window has
   * room (used by long-lived apps); `reject` fails the call immediately (used by the short-lived
   * configurator form, where a flood is always a bug).
   */
  onRateLimit: 'throttle' | 'reject'
  /** Human-readable noun for error messages, e.g. "Gatekeeper app" or "Resource configurator". */
  label: string
}

/**
 * Returns the rate-limited proxy plus a `dispose` that cancels any pending resume timer (otherwise it
 * could fire after the session is torn down). `dispose` is a no-op in `reject` mode (no timer).
 */
export function createRateLimitedCapability(
  capability: any,
  options: RateLimitOptions,
): { capability: any; dispose: () => void } {
  type QueuedCall = {
    method: string
    args: unknown[]
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }

  const startedCalls: number[] = []
  const queue: QueuedCall[] = []
  let inFlight = 0
  let resumeTimer: ReturnType<typeof setTimeout> | null = null

  const pruneCallWindow = () => {
    const cutoff = Date.now() - 60_000
    while (startedCalls.length > 0 && startedCalls[0] < cutoff) startedCalls.shift()
  }

  const drain = () => {
    pruneCallWindow()
    while (inFlight < options.maxConcurrency && queue.length > 0) {
      if (startedCalls.length >= options.maxCallsPerMinute) {
        if (options.onRateLimit === 'reject') {
          queue.shift()?.reject(new Error(`${options.label} made too many requests.`))
          continue
        }
        // Throttle: pause and resume once the oldest call ages out of the window (a completion may
        // resume sooner). The backlog stays bounded by maxPendingCalls below.
        if (resumeTimer === null) {
          const waitMs = startedCalls[0] + 60_000 - Date.now()
          resumeTimer = setTimeout(() => { resumeTimer = null; drain() }, Math.max(waitMs, 0) + 1)
        }
        break
      }
      const call = queue.shift()!
      if (typeof capability?.[call.method] !== 'function') {
        call.reject(new Error(`${options.label} method is not available: ${call.method}`))
        continue
      }
      startedCalls.push(Date.now())
      inFlight++
      Promise.resolve()
        .then(() => capability[call.method](...call.args))
        .then(call.resolve, call.reject)
        .finally(() => {
          inFlight--
          drain()
        })
    }
  }

  const proxy = new Proxy(new (class extends RpcTarget {})(), {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === Symbol.dispose) return undefined
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => new Promise((resolve, reject) => {
        if (queue.length + inFlight >= options.maxPendingCalls) {
          reject(new Error(`${options.label} has too many pending requests.`))
          return
        }
        queue.push({ method: property, args, resolve, reject })
        drain()
      })
    },
  })

  return {
    capability: proxy,
    dispose: () => {
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer)
        resumeTimer = null
      }
    },
  }
}
