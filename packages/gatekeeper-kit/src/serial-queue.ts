/**
 * Runs asynchronous operations sequentially in submission order.
 *
 * Its own module because two unrelated leaves need it: the action journal serializes resolution so
 * one action cannot be applied twice, and a streaming cursor serializes paging so two callers
 * cannot claim one provider page. Both spanned an await with mutable state behind it, and a second
 * hand-rolled gate is the kind of parallel mechanism that drifts. Both hold it in Durable Object
 * state, which is what makes a gate the right shape: the queue and every operation waiting on it
 * belong to one actor, so the release in `finally` runs in the same execution context that owns
 * them. Held instead by a per-request entrypoint, an unreleased slot would outlive its own reason
 * to exist.
 */
export class SerialTaskQueue {
  /**
   * A gate rather than a chain of results: it settles regardless of outcome, so a rejection neither
   * blocks later operations nor leaves an unhandled rejection behind. Await or return what `run`
   * hands back — an unattached rejecting promise is reported unhandled, like every other one.
   *
   * Not a tail-chain (`this.#gate = this.#gate.then(operation).then(noop, noop)`): `.then` adopts an
   * async operation's already-rejected promise through a deferred thenable-adoption microtask,
   * leaving it momentarily handlerless, and workerd reports that eagerly where Node waits for the
   * queue to drain. Awaiting the operation inside this async frame has no such gap.
   */
  #gate: Promise<void> = Promise.resolve();

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    // Claim the gate before the first await, or concurrent callers capture the same predecessor.
    const waitFor = this.#gate;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#gate = promise;

    await waitFor;
    try {
      return await operation();
    } finally {
      resolve();
    }
  }
}
