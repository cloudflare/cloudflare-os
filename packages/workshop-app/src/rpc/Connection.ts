import { newWebSocketRpcSession, type RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'

export type ConnectionSnapshot = {
  /** The live, proven connection; null while connecting or reconnecting. */
  readonly publicApi: RpcStub<PublicApi> | null
}

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 10_000
// Generous, so a slow but alive backend settles instead of being torn down and retried in a loop.
const PROBE_TIMEOUT_MS = 20_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const disposeQuietly = (stub: RpcStub<PublicApi>) => {
  try {
    stub[Symbol.dispose]()
  } catch {
    // Already broken.
  }
}

/** The page's own origin: the dev server proxies `/api`, and production serves it directly. */
export const defaultApiUrl = () =>
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api`

/**
 * Keeps one WebSocket RPC session to the backend alive, reconnecting with backoff when it drops.
 * Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 */
export class Connection {
  #snapshot: ConnectionSnapshot = { publicApi: null }
  #listeners = new Set<() => void>()
  #disposed = false

  constructor(private readonly url: string) {
    void this.#connect()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  dispose() {
    this.#disposed = true
    const { publicApi } = this.#snapshot
    if (publicApi) disposeQuietly(publicApi)
    this.#publish(null)
  }

  #publish(publicApi: RpcStub<PublicApi> | null) {
    this.#snapshot = { publicApi }
    this.#listeners.forEach((listener) => listener())
  }

  // Resolves only with a candidate that answered a ping: capnweb queues sends while a socket is
  // still connecting, so an unproven stub looks healthy until everything pipelined onto it fails.
  async #connect() {
    let backoff = 0
    while (!this.#disposed) {
      if (backoff) await sleep(backoff * (0.85 + 0.3 * Math.random()))
      const candidate = newWebSocketRpcSession<PublicApi>(this.url)
      try {
        await withTimeout(candidate.ping(), PROBE_TIMEOUT_MS)
      } catch {
        disposeQuietly(candidate)
        backoff = Math.min(backoff ? backoff * 2 : INITIAL_BACKOFF_MS, MAX_BACKOFF_MS)
        continue
      }
      if (this.#disposed) {
        disposeQuietly(candidate)
        return
      }
      candidate.onRpcBroken(() => this.#onBroken(candidate))
      this.#publish(candidate)
      return
    }
  }

  #onBroken(stub: RpcStub<PublicApi>) {
    if (this.#snapshot.publicApi !== stub) return
    this.#publish(null)
    disposeQuietly(stub)
    void this.#connect()
  }
}
