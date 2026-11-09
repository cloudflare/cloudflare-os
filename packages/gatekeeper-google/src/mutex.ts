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

/** Lets at most `permits` holders in at once; the rest wait their turn, first come first served. */
export class Semaphore {
  #free: number;
  #waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.#free = permits;
  }

  /**
   * Take a permit, waiting up to `waitMs` for one. Resolves to the function that gives it back,
   * which does so once however often it is called, or to `undefined` when none came free in time.
   */
  async acquire(waitMs: number): Promise<(() => void) | undefined> {
    if (this.#free > 0) {
      this.#free--;
    } else {
      let turn = Promise.withResolvers<boolean>();
      let take = () => turn.resolve(true);
      this.#waiting.push(take);
      // Leaves the queue as it gives up, so a permit is never handed to a waiter that has gone.
      let timer = setTimeout(() => {
        let at = this.#waiting.indexOf(take);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        turn.resolve(false);
      }, waitMs);
      let taken = await turn.promise;
      clearTimeout(timer);
      if (!taken) return undefined;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A waiter takes the permit over directly, so a newcomer cannot slip in ahead of it.
      let next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    };
  }
}
