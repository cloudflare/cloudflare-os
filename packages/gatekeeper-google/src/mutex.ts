/**
 * Serializes operations against each other, so none observes another's mid-flight state.
 *
 * A promise chain rather than `blockConcurrencyWhile`: that would freeze the whole object for the
 * duration of a fetch, and an exception or a 30s overrun inside it resets the Durable Object. Same
 * pattern as the Slack and Supabase gatekeepers.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
