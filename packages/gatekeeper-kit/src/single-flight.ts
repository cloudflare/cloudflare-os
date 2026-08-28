/**
 * Coalesces concurrent work onto one in-flight promise per key.
 *
 * Its own module for the reason `serial-queue` is: four leaves need it -- credential refresh keyed
 * by the identity fence, credential fetch, cache fills, and the expiry notification keyed by its
 * arm -- and each hand-rolled copy carried the same two rules. They are: the entry is installed
 * before the first await, so a caller in the same turn joins rather than starting a second round
 * trip; and it is released by a caller while still the one that caller joined, never from inside
 * the work, which would run before the entry existed whenever the work settles synchronously.
 *
 * A rejection is shared with every joined caller and releases the entry, so the next caller retries.
 */
export class SingleFlight {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  /**
   * `start()`'s promise, or the one already in flight for `key`. `T` is the caller's assertion, as
   * with any keyed store. Not `async`, so `start()` runs in the caller's own turn -- which is what
   * lets a Durable Object write and then join a flight in one uninterrupted step.
   */
  run<T>(key: string, start: () => Promise<T>): Promise<T> {
    const joined = this.#inFlight.get(key) as Promise<T> | undefined;
    const flight = joined ?? start();
    if (joined === undefined) this.#inFlight.set(key, flight);
    return this.#release(key, flight);
  }

  /** Stop offering `key` to later callers; those already joined still get its result. */
  forget(key: string): void {
    this.#inFlight.delete(key);
  }

  async #release<T>(key: string, flight: Promise<T>): Promise<T> {
    try {
      return await flight;
    } finally {
      if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
    }
  }
}
