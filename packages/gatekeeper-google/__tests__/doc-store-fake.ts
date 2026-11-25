// A Durable Object's storage for the Node tests of the Doc store.

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { fakeKv, type FakeKv } from "../../gatekeeper-kit/__tests__/fake-kv";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, type DocStoreStorage } from "../src/docs-store";

/** A cursor of the fake: what the store reads of one, and `next()`, which its own tests step. */
export type FakeDocCursor<T> = {
  /** The next row, as an iterator answers it. Throws once a rollback closed the cursor. */
  next(): { done: false; value: T } | { done: true };
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
};

export type FakeDocStorage = Omit<DocStoreStorage, "sql"> & {
  readonly sql: {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): FakeDocCursor<T>;
  };
  readonly kv: FakeKv;
  /** How many cursors are not drained. */
  openCursors(): number;
  /** Every distinct statement run so far, as it was given to `exec`. */
  statements(): string[];
  /** Every distinct statement whose rows were taken with `toArray()`. */
  arrays(): string[];
  /** SQLite's plan for `statement` (`EXPLAIN QUERY PLAN`), one line a step. */
  plan(statement: string): string[];
  /**
   * Makes `exec` throw "storage refused the write" for a statement `refuse` answers true
   * for, before it runs; `undefined` stops refusing.
   */
  refuse(refuse: ((statement: string, bindings: readonly unknown[]) => boolean) | undefined): void;
  /** Every row of every `doc_` table, by table, in key order: what two states are compared by. */
  rows(): Record<string, unknown[]>;
};

/**
 * A Durable Object's storage as the Doc store uses it, over `node:sqlite`. Like workerd, a cursor
 * steps lazily one row ahead, `transactionSync` nests as savepoints and restores the KV on a
 * rollback, and a cursor open at a rollback throws when next stepped. Billed rows and size limits
 * are not modelled: those are pinned in the workerd project.
 */
export function fakeDocStorage(): FakeDocStorage {
  const db = new DatabaseSync(":memory:");
  const kv = fakeKv();
  const statements = new Set<string>();
  const arrays = new Set<string>();
  // Each cursor that is not drained, with what closes it at a rollback.
  const open = new Map<object, () => void>();
  let refuses: ((statement: string, bindings: readonly unknown[]) => boolean) | undefined;
  let depth = 0;

  // Prepared statements by query, as workerd caches them. One with a cursor open on it is busy: a
  // statement steps one iterator at a time, so a query run again meanwhile is prepared afresh.
  const prepared = new Map<string, StatementSync>();
  const busy = new Set<StatementSync>();
  const prepare = (query: string) => {
    const cached = prepared.get(query);
    if (cached && !busy.has(cached)) return cached;
    const statement = db.prepare(query);
    if (!cached) prepared.set(query, statement);
    return statement;
  };
  // A statement whose step threw answers that error again when next reset, so it is not kept.
  const steps = <R>(query: string, statement: StatementSync, step: () => R): R => {
    try {
      return step();
    } catch (error) {
      if (prepared.get(query) === statement) prepared.delete(query);
      busy.delete(statement);
      throw error;
    }
  };

  const all = (query: string) => db.prepare(query).all() as Record<string, unknown>[];
  const changes = db.prepare("SELECT total_changes() AS changes");
  const totalChanges = () => Number((changes.get() as { changes: number }).changes);

  function exec<T extends Record<string, SqlStorageValue>>(
    query: string, ...bindings: unknown[]
  ): FakeDocCursor<T> {
    statements.add(query);
    if (refuses?.(query, bindings)) throw new Error("storage refused the write");
    const statement = prepare(query);
    const before = totalChanges();
    // A statement that answers no row runs whole, at once; one that answers rows is stepped.
    const iterator = statement.columns().length === 0
      ? undefined
      : statement.iterate(...bindings as SQLInputValue[]);
    if (!iterator) steps(query, statement, () => statement.run(...bindings as SQLInputValue[]));
    const rowsWritten = totalChanges() - before;
    let rolledBack = false;
    // The cursor holds one row ahead of what it has answered, from the moment it is made.
    let ahead: IteratorResult<unknown> = iterator
      ? steps(query, statement, () => iterator.next())
      : { done: true, value: undefined };
    const cursor: FakeDocCursor<T> = {
      next() {
        if (rolledBack) throw new Error("The cursor was closed by a rollback.");
        if (ahead.done) return { done: true };
        const value = { ...ahead.value as T };
        ahead = steps(query, statement, () => iterator!.next());
        if (ahead.done) {
          open.delete(cursor);
          busy.delete(statement);
        }
        return { done: false, value };
      },
      toArray() {
        arrays.add(query);
        const rows: T[] = [];
        for (let row = cursor.next(); !row.done; row = cursor.next()) rows.push(row.value);
        return rows;
      },
      one() {
        const rows: T[] = [];
        for (let row = cursor.next(); !row.done; row = cursor.next()) rows.push(row.value);
        if (rows.length !== 1) {
          throw new Error(`Expected exactly one result from SQL query, but got ${rows.length}`);
        }
        return rows[0];
      },
      rowsWritten,
    };
    if (iterator && !ahead.done) {
      busy.add(statement);
      open.set(cursor, () => {
        rolledBack = true;
        iterator.return?.();
        busy.delete(statement);
      });
    }
    return cursor;
  }

  function transactionSync<T>(callback: () => T): T {
    const savepoint = `fake_${depth++}`;
    // Stored values are clones, so the keys with their values are a snapshot.
    const kvOnEntry = kv.keys().map(key => [key, kv.get<unknown>(key)] as const);
    const writesOnEntry = kv.writes.length;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = callback();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      for (const close of open.values()) close();
      open.clear();
      db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      for (const key of kv.keys()) kv.delete(key);
      for (const [key, value] of kvOnEntry) kv.put(key, value);
      kv.writes.length = writesOnEntry;
      throw error;
    } finally {
      depth--;
    }
  }

  return {
    sql: { exec },
    transactionSync,
    kv,
    openCursors: () => open.size,
    statements: () => [...statements],
    arrays: () => [...arrays],
    plan: statement => all(`EXPLAIN QUERY PLAN ${statement}`).map(step => String(step.detail)),
    refuse: refuse => {
      refuses = refuse;
    },
    rows() {
      const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc_%' ORDER BY name");
      return Object.fromEntries(tables.map(({ name }) => {
        const key = all(`PRAGMA table_info(${String(name)})`)
          .filter(column => Number(column.pk) > 0)
          .toSorted((a, b) => Number(a.pk) - Number(b.pk))
          .map(column => String(column.name));
        return [name, all(`SELECT * FROM ${String(name)} ORDER BY ${key.join(", ")}`).map(row => ({ ...row }))];
      }));
    },
  };
}

/** A `DocStore` over a `fakeDocStorage()` of its own, its runs cut to `sizes` where given. */
export function fakeDocStore(format?: string, made?: string, sizes?: RunSizes): DocStore {
  return new DocStore(fakeDocStorage(), format, made, sizes);
}
