// Counts what a pass over a tab's runs reads and writes of its carry's numbers. Two numbers and
// no record of a call, so a heap test may run with it in place.

import type { PassCarry } from "../src/markdown-converter";

/** How many entries of a counted carry's numbers were read or written so far. */
let touched = 0;
/** How many counted carries were handed out so far. */
let carries = 0;

/** A map that counts entries asked: one a `get`, `set`, `has` or `delete`; all for a listing. */
export class CountingMap<K, V> extends Map<K, V> {
  override get(key: K): V | undefined {
    touched++;
    return super.get(key);
  }

  override set(key: K, value: V): this {
    touched++;
    return super.set(key, value);
  }

  override has(key: K): boolean {
    touched++;
    return super.has(key);
  }

  override delete(key: K): boolean {
    touched++;
    return super.delete(key);
  }

  override entries(): MapIterator<[K, V]> {
    touched += this.size;
    return super.entries();
  }

  override keys(): MapIterator<K> {
    touched += this.size;
    return super.keys();
  }

  override values(): MapIterator<V> {
    touched += this.size;
    return super.values();
  }

  override forEach(
    callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown,
  ): void {
    touched += this.size;
    super.forEach(callback, thisArg);
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    touched += this.size;
    return super.entries();
  }
}

/** `carry` with its numbers in a `CountingMap`, counted as one carry handed out. */
export function countedCarry(carry: PassCarry): PassCarry {
  carries++;
  let listNumbers = new CountingMap<string, readonly (number | null)[]>();
  // Moved over one by one, uncounted: the count starts with the carry handed out.
  for (let [listId, numbers] of carry.listNumbers) Map.prototype.set.call(listNumbers, listId, numbers);
  return { ...carry, listNumbers };
}

/** The carry entries `call` read or wrote, and the counted carries handed out (2 with a pair). */
export function counted(call: () => unknown): { touched: number; carries: number } {
  let before = { touched, carries };
  call();
  return { touched: touched - before.touched, carries: carries - before.carries };
}

/** The entries of counted carries' numbers `call` read or wrote. */
export function touchedBy(call: () => unknown): number {
  return counted(call).touched;
}
