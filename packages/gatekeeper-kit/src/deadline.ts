/**
 * Waiting on work the caller can't cancel, such as a Worker RPC call: the wait ends, the work may
 * go on. Internal to the kit, shared by `./hook-delivery-queue` and `./hook-registry`.
 */

/**
 * Settle as `work` does, or reject with `signal`'s reason once it aborts. `work` is still observed
 * after that, so its late rejection is never unhandled.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason);
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  return promise;
}

/**
 * Settle as `work` does, or reject with `timeout()` after `ms`, or with `signal`'s reason once it
 * aborts, whichever comes first.
 */
export async function within<T>(work: Promise<T>, ms: number, timeout: () => unknown, signal: AbortSignal): Promise<T> {
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(timeout()), ms);
  try {
    return await untilAborted(untilAborted(work, expired.signal), signal);
  } finally {
    clearTimeout(timer);
  }
}
