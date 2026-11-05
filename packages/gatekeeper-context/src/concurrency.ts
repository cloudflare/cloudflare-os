/** Fan-out cap for calls made to every collection in a library. */
export const MAX_COLLECTION_FANOUT = 8;

/** Map `items` through `fn` with at most `limit` calls in flight, keeping input order. */
export async function mapWithConcurrency<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      let i = next++;
      results[i] = await fn(items[i]);
    }
  }
  let workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
