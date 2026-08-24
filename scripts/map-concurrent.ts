// Runs an async operation over a list with a bounded number of them in flight.
//
// Written for the release build, where each package's `wrangler deploy --dry-run` is independent
// and saturates about one core. Two properties matter there, and they are why this is a shared,
// tested helper rather than a `Promise.all` at the call site:
//
//  - Results keep the input's order, so a manifest built from them is byte-stable no matter which
//    bundle happened to finish first.
//  - A rejection does not abandon the tasks still running. `Promise.all` settles on the first
//    failure and leaves the rest writing to disk under a process that is already exiting; here
//    every task is awaited, and all the failures are reported together -- in CI that names every
//    broken package rather than whichever one lost the race.
//
// The optional signal is the fail-fast complement: when the caller learns elsewhere that the whole
// run is doomed (the frontend build failed), aborting stops new tasks from being claimed while the
// wait-for-all guarantee on the ones already running still holds.

/**
 * Applies `task` to every item, with at most `limit` running at a time, and returns the results in
 * the input's order.
 *
 * Every task runs even if an earlier one rejects. If any did, this rejects once they have all
 * settled: with that error if there was exactly one, or an `AggregateError` over them otherwise.
 *
 * An aborted `signal` stops further items from starting; tasks already running are still awaited.
 * If the signal aborted at any point and no task failed, this rejects with `signal.reason`; task
 * failures take precedence over the abort reason.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results: R[] = Array.from({ length: items.length });
  const failures: unknown[] = [];
  // Each runner claims the next index and works until the list is exhausted. The claim is a bare
  // `next++` because JS runs it to completion before any other runner resumes.
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      if (signal?.aborted) break;
      try {
        results[i] = await task(items[i], i);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(runners);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} of ${items.length} tasks failed`);
  }
  // Aborted is aborted, whether or not it cost us an item. Keying this off "we skipped something"
  // instead reports success for the case where the signal lands once every item is already claimed
  // and each task then finishes on its own merits -- no holes in `results`, nothing rejected, and a
  // caller that asked to stop handed a full set of results as if it had not.
  if (signal?.aborted) throw signal.reason;
  return results;
}
