/** Runs asynchronous operations sequentially. A failed operation never blocks later submissions. */
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
