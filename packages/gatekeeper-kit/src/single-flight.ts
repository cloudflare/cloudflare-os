/** Concurrent work coalescing by key without result caching. */

/**
 * Coalesces concurrent work by key. Flights are installed synchronously and released after success
 * or rejection, so a later caller can retry. `forget()` stops new joins but does not cancel work.
 *
 * @example
 * ```ts
 * #schemaLoads = new SingleFlight();
 *
 * schema(projectId: string) {
 *   return this.#schemaLoads.run(projectId, () => this.#api.getSchema(projectId));
 * }
 * ```
 */
export class SingleFlight {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  /**
   * Joins the existing flight for a key or starts one.
   * @param key Flight key.
   * @param start Work to start when no flight exists.
   * @returns The shared in-flight result.
   */
  run<T>(key: string, start: () => Promise<T>): Promise<T> {
    const joined = this.#inFlight.get(key) as Promise<T> | undefined;
    const flight = joined ?? start();
    if (joined === undefined) this.#inFlight.set(key, flight);
    return this.#release(key, flight);
  }

  /**
   * Stops offering a flight to later callers.
   * @param key Flight key to forget.
   */
  forget(key: string): void {
    this.#inFlight.delete(key);
  }

  /**
   * Releases a completed flight without deleting a replacement.
   * @param key Flight key.
   * @param flight Flight being returned.
   * @returns The flight result.
   */
  async #release<T>(key: string, flight: Promise<T>): Promise<T> {
    try {
      return await flight;
    } finally {
      if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
    }
  }
}
