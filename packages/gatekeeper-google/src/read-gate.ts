/** Lets reads overlap each other, but not a change being applied or rejected. */
export class ReadGate {
  #reads = new Set<Promise<unknown>>();
  #resolving: Promise<unknown> = Promise.resolve();

  async read<T>(body: () => Promise<T>): Promise<T> {
    // Waits out resolutions queued while it waited, too, so none starts under the read.
    let resolving;
    do await (resolving = this.#resolving); while (resolving !== this.#resolving);
    let reading = body();
    this.#reads.add(reading);
    try {
      return await reading;
    } finally {
      this.#reads.delete(reading);
    }
  }

  /** Runs `body` once earlier resolutions and every read in progress have settled. */
  resolve<T>(body: () => Promise<T>): Promise<T> {
    let resolving = Promise.allSettled([this.#resolving, ...this.#reads]).then(body);
    this.#resolving = resolving.catch(() => {});
    return resolving;
  }
}
