/** FIFO asynchronous task serialization that survives operation failure. */

/**
 * Runs asynchronous operations sequentially.
 *
 * A failed operation never blocks later submissions. Awaiting a nested submission
 * to the same queue deadlocks.
 *
 * @example
 * ```ts
 * #credentialMutations = new SerialTaskQueue();
 *
 * reconnect(next: VendorCreds) {
 *   return this.#credentialMutations.run(async () => {
 *     this.ctx.storage.kv.put("credentials", next);
 *     await this.#notifyCredentialsRestored();
 *   });
 * }
 * ```
 */
export class SerialTaskQueue {
  // The gate settles independently, so rejection cannot block later work.
  #gate: Promise<void> = Promise.resolve();

  /**
   * Runs an operation after earlier submissions settle.
   * @param operation Synchronous or asynchronous work to serialize.
   * @returns The operation result.
   */
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
