import type { ObserverKv } from "../src/observers";

/** An in-memory stand-in for a Durable Object's `ctx.storage.kv`.
 *
 * Values are structured-cloned on every put/get/list so object identity does not survive, matching
 * a Durable Object that serializes on write and deserializes on read.
 */
export class FakeKv implements ObserverKv {
  entries = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    let value = this.entries.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }
  put<T>(key: string, value: T): void {
    this.entries.set(key, structuredClone(value));
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
  list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    return [...this.entries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, structuredClone(value) as T]);
  }
}
