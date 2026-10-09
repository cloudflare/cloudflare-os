// The per-hook delivery queue a hook driver keeps in its Durable Object storage: each new message
// is queued once per hook that watches for it, retried with backoff while the hook's firing
// fails, and remembered for a day once finished so a duplicate push doesn't queue it again.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
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

/** The rows a driver stores under `msg:{hookKey}:{messageId}`; hook keys are UUIDs, so contain no `:`. */
export class HookDeliveryQueue<Message> {
  constructor(private storage: DurableObjectStorage, private onDrop: () => void) {}

  /** Queue `message` for the hook unless it is pending or finished within the dedupe window. */
  enqueue(hookKey: string, messageId: string, message: Message, now: number): void {
    const key = rowKey(hookKey, messageId);
    if (this.storage.kv.get(key) === undefined) {
      this.storage.kv.put<Pending<Message>>(key, { message, attempts: 0, at: now });
    }
  }

  /** Finish the hook's pending messages: disabling ends its retries even if it is re-enabled first. */
  cancel(hookKey: string): void {
    // The finished rows still collapse duplicate pushes.
    for (const [key, row] of this.storage.kv.list<Row<Message>>({ prefix: rowKey(hookKey, "") })) {
      if (!("deliveredAt" in row)) this.storage.kv.put<Finished>(key, { deliveredAt: Date.now() });
    }
  }

  /**
   * Sweep expired finished rows, then attempt up to `MAX_DELIVERIES_PER_RUN` due rows, oldest
   * `at` first, concurrently. A row is finished once `deliver` resolves, and retried with backoff
   * when it throws.
   */
  async run(now: number, deliver: (hookKey: string, message: Message) => Promise<void>): Promise<void> {
    const due: [string, Pending<Message>][] = [];
    for (const [key, row] of this.storage.kv.list<Row<Message>>({ prefix: "msg:" })) {
      if ("deliveredAt" in row) {
        if (row.deliveredAt + DELIVERED_RETENTION_MS <= now) this.storage.kv.delete(key);
      } else if (row.at <= now) {
        due.push([key, row]);
      }
    }
    due.sort(([, a], [, b]) => a.at - b.at);
    await Promise.all(due.slice(0, MAX_DELIVERIES_PER_RUN)
      .map(([key, pending]) => this.#attempt(key, pending, deliver)));
  }

  /** The earliest time the queue needs the alarm (a pending `at`, or a finished row's expiry), or undefined. */
  nextDue(): number | undefined {
    let next: number | undefined;
    for (const [, row] of this.storage.kv.list<Row<Message>>({ prefix: "msg:" })) {
      const time = "deliveredAt" in row ? row.deliveredAt + DELIVERED_RETENTION_MS : row.at;
      if (next === undefined || time < next) next = time;
    }
    return next;
  }

  async #attempt(key: string, pending: Pending<Message>,
                 deliver: (hookKey: string, message: Message) => Promise<void>): Promise<void> {
    try {
      await deliver(key.slice(4, key.indexOf(":", 4)), pending.message);
      this.storage.kv.put<Finished>(key, { deliveredAt: Date.now() });
    } catch {
      // Retry only a message still pending: disabling the hook during this attempt finished it.
      const row = this.storage.kv.get<Row<Message>>(key);
      if (!row || "deliveredAt" in row) return;
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        // No error passed on: a hook's exception can quote the private message it failed on.
        this.onDrop();
        this.storage.kv.put<Finished>(key, { deliveredAt: Date.now() });
      } else {
        const delay = Math.min(MINUTE_MS * 2 ** (attempts - 1), HOUR_MS);
        this.storage.kv.put<Pending<Message>>(key, { ...pending, attempts, at: Date.now() + delay });
      }
    }
  }
}

/** Dispose every stub stored as a value of `stubs`. */
export function disposeStubs(stubs: object | undefined): void {
  for (const stub of Object.values(stubs ?? {}) as Partial<Disposable>[]) stub[Symbol.dispose]?.();
}
