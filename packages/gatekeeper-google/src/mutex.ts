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

/** Lets at most `permits` operations run at once; the rest wait their turn, first come first served. */
export class Semaphore {
  #free: number;
  #waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.#free = permits;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#free > 0) {
      this.#free--;
    } else {
      let turn = Promise.withResolvers<void>();
      this.#waiting.push(turn.resolve);
      await turn.promise;
    }
    try {
      return await operation();
    } finally {
      // A waiter takes the permit over directly, so a newcomer cannot slip in ahead of it.
      let next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}
