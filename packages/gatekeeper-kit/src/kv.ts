// The slices of the Durable Object's synchronous KV surface the leaf modules take. Each names the
// narrowest one it needs and re-exports it under its own subpath, so `ActionJournalKv` and
// `CredentialsKv` still come from the module that uses them.
//
// Structural rather than `Pick<DurableObjectStorage["kv"], …>`: the real `delete` answers `boolean`
// and the real `list` takes the whole option set, neither of which the kit uses, so a `Pick` would
// oblige every test fake to reproduce signatures nothing calls. `ctx.storage.kv` satisfies these as
// written -- `boolean` is assignable to a discarded `void`, and a wider parameter accepts a
// narrower argument.
//
// The types are structural but the contract is not: the kit's write orderings (`retain`,
// `clearCredentialExpiryLatch`, the withheld latch) assume `ctx.storage.kv` semantics --
// synchronous writes joining the turn's implicit transaction, never rolled back by a later throw.
// An adapter that batches, defers, or rolls back on throw silently invalidates them; test fakes
// must preserve those semantics too.

/** Typed reads and writes by key. */
export type KvReadWrite = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/** Reads, writes, and removal. */
export type KvMutable = KvReadWrite & {
  delete(key: string): void;
};

/** Reads, writes, removal, and a prefix scan. */
export type KvScannable = KvMutable & {
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};
