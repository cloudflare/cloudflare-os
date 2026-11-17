/**
 * Caps how many operations run at once per key. Callers past the cap wait in FIFO order; a
 * released slot passes straight to the next waiter.
 *
 * Release functions are idempotent, so a caller can release from several settle paths without
 * freeing someone else's slot.
 */
export class KeyedConcurrencyLimiter {
  #active = new Map<string, number>();
  #waiting = new Map<string, Array<(release: () => void) => void>>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive integer");
    }
  }

  /** Take a slot if one is free right now, else return undefined. */
  tryAcquire(key: string): (() => void) | undefined {
    let active = this.#active.get(key) ?? 0;
    if (active >= this.limit) return undefined;
    this.#active.set(key, active + 1);
    return this.#releaser(key);
  }

  /** Take a slot, waiting for one when the key is at its cap. */
  acquire(key: string): Promise<() => void> {
    let release = this.tryAcquire(key);
    if (release) return Promise.resolve(release);
    return new Promise(resolve => {
      let queue = this.#waiting.get(key);
      if (queue === undefined) this.#waiting.set(key, queue = []);
      queue.push(resolve);
    });
  }

  /** Slots in use and callers waiting for `key`. */
  stats(key: string): {active: number, waiting: number} {
    return {active: this.#active.get(key) ?? 0, waiting: this.#waiting.get(key)?.length ?? 0};
  }

  #releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      let queue = this.#waiting.get(key);
      let next = queue?.shift();
      if (queue?.length === 0) this.#waiting.delete(key);
      if (next) {
        // The slot moves to the next waiter, so the active count stays the same.
        next(this.#releaser(key));
        return;
      }
      let active = (this.#active.get(key) ?? 1) - 1;
      if (active <= 0) this.#active.delete(key);
      else this.#active.set(key, active);
    };
  }
}
