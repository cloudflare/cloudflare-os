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

/** A queued delivery of `message` to one hook, and when it is next tried. */
type Pending<Message> = { message: Message; attempts: number; at: number };
/** A message delivered, skipped or dropped, remembered so a duplicate push doesn't queue it again. */
type Finished = { deliveredAt: number };
type Row<Message> = Pending<Message> | Finished;

const rowKey = (hookKey: string, messageId: string) => `msg:${hookKey}:${messageId}`;

/**
 * Queued deliveries, stored under `msg:{hookKey}:{messageId}`. Hook keys must contain no `:`
 * (drivers use UUIDs). The driver owns its alarm: it calls `run()` from it, and sets it for
 * `nextDue()` afterwards.
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
    const key = rowKey(hookKey, messageId);
    if (this.#kv.get(key) === undefined) {
      this.#kv.put<Pending<Message>>(key, { message, attempts: 0, at: now });
    }
  }

  /**
   * Finish the hook's pending messages: disabling ends its retries even if it is re-enabled first.
   * @param hookKey The hook whose messages to finish.
   */
  cancel(hookKey: string): void {
    // The finished rows still collapse duplicate pushes.
    for (const [key, row] of this.#kv.list<Row<Message>>({ prefix: rowKey(hookKey, "") })) {
      if (!("deliveredAt" in row)) this.#kv.put<Finished>(key, { deliveredAt: Date.now() });
    }
  }

  /**
   * Sweep expired finished rows, then attempt up to `MAX_DELIVERIES_PER_RUN` due rows, oldest
   * `at` first, concurrently. A row is finished once `deliver` resolves, and retried with backoff
   * when it throws.
   * @param now The current time.
   * @param deliver Delivers one message to one hook.
   */
  async run(now: number, deliver: (hookKey: string, message: Message) => Promise<void>): Promise<void> {
    const due: [string, Pending<Message>][] = [];
    for (const [key, row] of this.#kv.list<Row<Message>>({ prefix: "msg:" })) {
      if ("deliveredAt" in row) {
        if (row.deliveredAt + DELIVERED_RETENTION_MS <= now) this.#kv.delete(key);
      } else if (row.at <= now) {
        due.push([key, row]);
      }
    }
    due.sort(([, a], [, b]) => a.at - b.at);
    await Promise.all(due.slice(0, MAX_DELIVERIES_PER_RUN)
      .map(([key, pending]) => this.#attempt(key, pending, deliver)));
  }

  /**
   * @returns The earliest time the queue needs the alarm (a pending `at`, or a finished row's
   * expiry), or undefined.
   */
  nextDue(): number | undefined {
    let next: number | undefined;
    for (const [, row] of this.#kv.list<Row<Message>>({ prefix: "msg:" })) {
      const time = "deliveredAt" in row ? row.deliveredAt + DELIVERED_RETENTION_MS : row.at;
      if (next === undefined || time < next) next = time;
    }
    return next;
  }

  async #attempt(key: string, pending: Pending<Message>,
                 deliver: (hookKey: string, message: Message) => Promise<void>): Promise<void> {
    try {
      await deliver(key.slice(4, key.indexOf(":", 4)), pending.message);
      this.#kv.put<Finished>(key, { deliveredAt: Date.now() });
    } catch {
      // Retry only a message still pending: disabling the hook during this attempt finished it.
      const row = this.#kv.get<Row<Message>>(key);
      if (!row || "deliveredAt" in row) return;
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.#onDrop();
        this.#kv.put<Finished>(key, { deliveredAt: Date.now() });
      } else {
        const delay = Math.min(MINUTE_MS * 2 ** (attempts - 1), HOUR_MS);
        this.#kv.put<Pending<Message>>(key, { ...pending, attempts, at: Date.now() + delay });
      }
    }
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
