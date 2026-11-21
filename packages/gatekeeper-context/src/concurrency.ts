/** Fan-out cap for calls made to every collection in a library. */
export const MAX_COLLECTION_FANOUT = 8;

/**
 * Map `items` through `fn` with at most `limit` calls in flight, keeping input order. After a call
 * fails no new one starts, and the first failure is thrown once the calls already in flight have
 * finished, so none of them outlives the map.
 */
export async function mapWithConcurrency<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let results: R[] = Array.from({ length: items.length });
  let next = 0;
  let failure: { error: unknown } | undefined;
  async function worker(): Promise<void> {
    while (!failure && next < items.length) {
      let i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  let workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (failure) throw failure.error;
  return results;
}
