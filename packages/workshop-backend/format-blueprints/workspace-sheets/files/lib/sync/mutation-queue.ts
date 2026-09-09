/**
 * The order a Durable Object's mutations commit in.
 *
 * RPC handlers interleave at every `await`: two `applyOperation` calls arriving together would
 * each load the stored state, each compute on it and each store its own result, the second
 * silently undoing the first. Chaining every mutation through one queue gives each a consistent
 * view -- it loads what the previous one stored -- and makes the queue's order the authoritative
 * order every subscriber observes. Reads that need no such guarantee stay off the queue.
 */
export class MutationQueue {
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `work` once every mutation enqueued before it has settled, and settles the way `work`
   * does. A rejection reaches its caller alone: the queue itself never stalls on one.
   */
  run<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
}
