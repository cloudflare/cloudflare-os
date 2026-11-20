// The one measure of what a call of the Doc store holds, for the Node tests that pin a bound in
// bytes a run or a list. Node only: the collector is Node's.

import { getHeapSpaceStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { FakeDocStorage } from "./doc-store-fake";

// The collector, for the tests that what a fetch has written can be collected: a full
// collection, run synchronously where it is called.
setFlagsFromString("--expose-gc");
export const collect = runInNewContext("gc") as () => void;

/**
 * How a suite or a test that bounds a heap reading is declared: one of its tests that fails is
 * run again, twice at most. A READING HOLDS MORE THAN THE CALL DOES, AT TIMES: a frame the
 * engine has not optimised yet keeps the last values of its registers, and when it is
 * optimised moves with the machine's load. A bound is held by one reading of three.
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

/**
 * What is in use after full collections: the heap's objects, which is all of it but the
 * engine's own code, and the buffers outside the heap. THE ENGINE'S CODE IS LEFT OUT: compiled
 * or not, it comes and goes by tens of kilobytes as a call runs, at moments that move with
 * the machine's load, and none of it is what the call holds.
 */
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
 * How much more is in use at a statement inside `call` than before it. `call` is handed
 * `storage` wrapped so that `inUse()` is read before each statement `at` answers true for;
 * the answer is the greatest of those readings less `inUse()` taken before `call`, and how
 * many statements `at` chose (0 says the measure is vacuous: assert it is not). `call`
 * builds its own store over the storage it is handed and answers nothing: this frame
 * holds numbers only, so no temporary of it pins what it measures.
 * EACH READING IS THE LOWER OF TWO TAKEN IN A ROW: what the calls before left on the stack can
 * hold their last values through one round of collections (measured: the answer of the call
 * before, whole), and is gone by the second.
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
