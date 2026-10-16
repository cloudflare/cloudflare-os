/**
 * The per-hook delivery queue a hook driver keeps in its Durable Object storage: each event a
 * provider pushes is queued once per hook that watches for it, retried with backoff while the
 * hook's firing fails, and remembered for a day once finished so a duplicate push doesn't queue it
 * again.
 */

import type { KvScannable } from "./kv";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Attempts at delivering one message to one hook before it is dropped. */
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Duplicate pushes of a message that needs no further delivery are ignored for this long. */
export const DELIVERED_RETENTION_MS = 24 * HOUR_MS;
/**
 * Deliveries one run starts together; the rest stay due, so the alarm a driver reschedules for the
 * past takes them next.
 */
export const MAX_DELIVERIES_PER_RUN = 20;
/** Finished messages one run forgets once their dedupe window has passed; the rest stay due. */
const MAX_FORGOTTEN_PER_RUN = 500;

/** A queued delivery of `message` to one hook, and when it is next tried. */
type Pending<Message> = { message: Message; attempts: number; at: number };
/** A message delivered, skipped or dropped, remembered so a duplicate push doesn't queue it again. */
type Finished = { deliveredAt: number };
type Row<Message> = Pending<Message> | Finished;

const ROWS = "msg:";
const rowKey = (hookKey: string, messageId: string) => `${ROWS}${hookKey}:${messageId}`;

// Each row is indexed by a time that says when it next needs the queue: a pending one by when it is
// due, a finished one by when it finished, which the dedupe window counts from. Index keys order by
// that time, so a run reads what has come due, and nothing of the day's backlog besides.
const DUE = "queue:due:";
const FINISHED = "queue:finished:";
/** Set once every row is indexed: rows stored before the indexes existed are indexed once. */
const INDEXED = "queue:indexed";
/** A time as index keys order it, in milliseconds: fifteen digits, enough until the year 33658. */
const TIME_DIGITS = 15;
const timeKey = (time: number) => String(time).padStart(TIME_DIGITS, "0");
/** The index entry for row `key` at `time`. */
const entryKey = (index: string, time: number, key: string) => `${index}${timeKey(time)}:${key.slice(ROWS.length)}`;
/** The row an index entry stands for, and the time it is filed under. */
function entryRow(index: string, entry: string): { key: string; time: number } {
  return {
    key: ROWS + entry.slice(index.length + TIME_DIGITS + 1),
    time: Number(entry.slice(index.length, index.length + TIME_DIGITS)),
  };
}
/** The bound below which an index's entries are filed at `time` or earlier. */
const through = (index: string, time: number) => `${index}${timeKey(time + 1)}`;

/**
 * Queued deliveries, stored under `msg:{hookKey}:{messageId}`, with the indexes the queue reads
 * them by under `queue:`. Hook keys must contain no `:` (drivers use UUIDs). The driver owns its
 * alarm: it calls `run()` from it, and sets it for `nextDue()` afterwards. A driver may delete what
 * the queue stores, as on disconnecting: an index entry whose row is gone is dropped when read.
 *
 * @example
 * ```ts
 * #queue = new HookDeliveryQueue<Event>(this.ctx.storage.kv, () => logger.warn("dropped an event"));
 *
 * async alarm() {
 *   await this.#queue.run(Date.now(), (hookKey, event) => this.#deliver(hookKey, event));
 *   const next = this.#queue.nextDue();
 *   if (next !== undefined) await this.ctx.storage.setAlarm(next);
 * }
 * ```
 */
export class HookDeliveryQueue<Message> {
  readonly #kv: KvScannable;
  readonly #onDrop: () => void;

  /**
   * @param kv The driver's `ctx.storage.kv`.
   * @param onDrop Called once for each message dropped after `MAX_DELIVERY_ATTEMPTS`; it is given
   * no error, since a hook's exception can quote the private message it failed on.
   */
  constructor(kv: KvScannable, onDrop: () => void) {
    this.#kv = kv;
    this.#onDrop = onDrop;
  }

  /**
   * Queue `message` for the hook unless it is pending or finished within the dedupe window.
   * @param hookKey The hook to deliver to.
   * @param messageId The provider's id for the message, which a duplicate push repeats.
   * @param message What `run()` hands the delivery callback.
   * @param now When the message is first due.
   */
  enqueue(hookKey: string, messageId: string, message: Message, now: number): void {
    this.#index();
    const key = rowKey(hookKey, messageId);
    if (this.#kv.get(key) === undefined) this.#putPending(key, { message, attempts: 0, at: now });
  }

  /**
   * Finish the hook's pending messages: disabling ends its retries even if it is re-enabled first.
   * @param hookKey The hook whose messages to finish.
   */
  cancel(hookKey: string): void {
    this.#index();
    // The finished rows still collapse duplicate pushes. Listed up front, as finishing deletes.
    const prefix = rowKey(hookKey, "");
    const pending = [...this.#kv.list<true>({ prefix: DUE })];
    for (const [entry] of pending) {
      const { key } = entryRow(DUE, entry);
      if (key.startsWith(prefix)) this.#finish(key, Date.now());
    }
  }

  /**
   * Forget finished rows whose dedupe window has passed, then attempt up to
   * `MAX_DELIVERIES_PER_RUN` due rows, oldest `at` first, concurrently. A row is finished once
   * `deliver` resolves, and retried with backoff when it throws.
   * @param now The current time.
   * @param deliver Delivers one message to one hook.
   */
  async run(now: number, deliver: (hookKey: string, message: Message) => Promise<void>): Promise<void> {
    this.#index();
    // Each list is read in full before the loop below it deletes.
    const expired = [...this.#kv.list<true>({
      prefix: FINISHED, end: through(FINISHED, now - DELIVERED_RETENTION_MS), limit: MAX_FORGOTTEN_PER_RUN,
    })];
    for (const [entry] of expired) {
      const { key, time } = entryRow(FINISHED, entry);
      // An entry stays when its row was deleted, and a new one queued under its key.
      if (this.#finishedAt(key) === time) this.#kv.delete(key);
      this.#kv.delete(entry);
    }
    const listed = [...this.#kv.list<true>({ prefix: DUE, end: through(DUE, now), limit: MAX_DELIVERIES_PER_RUN })];
    const due: [string, Pending<Message>][] = [];
    for (const [entry] of listed) {
      const { key, time } = entryRow(DUE, entry);
      const row = this.#kv.get<Row<Message>>(key);
      if (row && !("deliveredAt" in row) && row.at === time) due.push([key, row]);
      else this.#kv.delete(entry);
    }
    await Promise.all(due.map(([key, pending]) => this.#attempt(key, pending, deliver)));
  }

  /**
   * @returns The earliest time the queue needs the alarm (a pending `at`, or a finished row's
   * expiry), or undefined.
   */
  nextDue(): number | undefined {
    this.#index();
    const first = (index: string) =>
      [...this.#kv.list<true>({ prefix: index, limit: 1 })].map(([entry]) => entryRow(index, entry).time);
    const times = [...first(DUE), ...first(FINISHED).map(finishedAt => finishedAt + DELIVERED_RETENTION_MS)];
    return times.length === 0 ? undefined : Math.min(...times);
  }

  async #attempt(key: string, pending: Pending<Message>,
                 deliver: (hookKey: string, message: Message) => Promise<void>): Promise<void> {
    let delivered = true;
    try {
      await deliver(key.slice(ROWS.length, key.indexOf(":", ROWS.length)), pending.message);
    } catch {
      delivered = false;
    }
    const row = this.#kv.get<Row<Message>>(key);
    if (!row) {
      // Deleted meanwhile, as a driver forgetting every hook does, which it stays.
      this.#kv.delete(entryKey(DUE, pending.at, key));
      return;
    }
    // Finished meanwhile by disabling the hook, which ends its retries.
    if ("deliveredAt" in row) return;
    const attempts = pending.attempts + 1;
    if (delivered) {
      this.#finish(key, Date.now());
    } else if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.#onDrop();
      this.#finish(key, Date.now());
    } else {
      this.#kv.delete(entryKey(DUE, row.at, key));
      const delay = Math.min(MINUTE_MS * 2 ** (attempts - 1), HOUR_MS);
      this.#putPending(key, { ...pending, attempts, at: Date.now() + delay });
    }
  }

  /** When row `key` finished, if it is a finished row. */
  #finishedAt(key: string): number | undefined {
    const row = this.#kv.get<Row<Message>>(key);
    return row && "deliveredAt" in row ? row.deliveredAt : undefined;
  }

  #putPending(key: string, row: Pending<Message>): void {
    this.#kv.put<Pending<Message>>(key, row);
    this.#kv.put(entryKey(DUE, row.at, key), true);
  }

  /** Finish pending row `key`, remembering it until the dedupe window has passed. */
  #finish(key: string, deliveredAt: number): void {
    const row = this.#kv.get<Row<Message>>(key);
    if (row && !("deliveredAt" in row)) this.#kv.delete(entryKey(DUE, row.at, key));
    this.#kv.put<Finished>(key, { deliveredAt });
    this.#kv.put(entryKey(FINISHED, deliveredAt, key), true);
  }

  /** Index rows stored before the indexes existed, once. */
  #index(): void {
    if (this.#kv.get(INDEXED) !== undefined) return;
    const rows = [...this.#kv.list<Row<Message>>({ prefix: ROWS })];
    for (const [key, row] of rows) {
      if ("deliveredAt" in row) this.#kv.put(entryKey(FINISHED, row.deliveredAt, key), true);
      else this.#kv.put(entryKey(DUE, row.at, key), true);
    }
    this.#kv.put(INDEXED, true);
  }
}

/**
 * Dispose every stub stored as a value of `stubs`, such as the capabilities a driver keeps for one
 * hook.
 * @param stubs An object whose values are stubs, or undefined.
 */
export function disposeStubs(stubs: object | undefined): void {
  for (const stub of Object.values(stubs ?? {}) as Partial<Disposable>[]) stub[Symbol.dispose]?.();
}
