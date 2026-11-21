// The one measure of what a call of the Doc store holds as live heap, for the Node tests that
// bound it. Node only: the collector is Node's.

import { getHeapSpaceStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { FakeDocStorage } from "./doc-store-fake";

// A full collection, run synchronously where it is called.
setFlagsFromString("--expose-gc");
export const collect = runInNewContext("gc") as () => void;

/**
 * How a heap-bounding suite or test is declared: retried twice at most, since an unoptimised
 * frame can keep its registers' last values alive for a while.
 */
export const HEAP_MEASURED = { retry: 2 } as const;

/** `storage` as a store is handed it, with `seen` called before each statement runs. */
export function observing(
  storage: FakeDocStorage, seen: (query: string, bindings: readonly unknown[]) => void,
): FakeDocStorage {
  return {
    ...storage,
    sql: { exec: (query: string, ...bindings: unknown[]) => {
      seen(query, bindings);
      return storage.sql.exec(query, ...bindings);
    } },
  } as FakeDocStorage;
}

/** What is in use after full collections: heap objects and outside buffers, not engine code. */
export function inUse(): number {
  for (let pass = 0; pass < 4; pass++) collect();
  let objects = 0;
  for (let { space_name, space_used_size } of getHeapSpaceStatistics()) {
    if (!/code|trusted/.test(space_name)) objects += space_used_size;
  }
  return objects + process.memoryUsage().arrayBuffers;
}

/** The lower of two readings of what is in use, taken in a row. */
const settled = () => Math.min(inUse(), inUse());

/**
 * The most more in use, at the statements `at` picks inside `call`, than before it, and how many
 * it picked (0 means vacuous: assert it is not). `call` builds its own store and answers nothing,
 * so this frame pins nothing it measures.
 */
export function heapHeld(
  storage: FakeDocStorage,
  at: (query: string, bindings: readonly unknown[]) => boolean,
  call: (observed: FakeDocStorage) => void,
): { bytes: number; seen: number } {
  let seen = 0, most = 0;
  let observed = observing(storage, (query, bindings) => {
    if (!at(query, bindings)) return;
    seen++;
    most = Math.max(most, settled());
  });
  let before = settled();
  call(observed);
  return { bytes: most - before, seen };
}
