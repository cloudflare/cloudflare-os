/**
 * The per-hook delivery queue a hook driver keeps in its Durable Object storage: each event a
 * provider pushes is queued once per hook that watches for it, retried with backoff while the
 * hook's firing fails, and remembered for a day once finished so a duplicate push doesn't queue it
 * again.
 */

import { untilAborted } from "./deadline";
import type { KvScannable } from "./kv";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Attempts at delivering one message to one hook before it is dropped. */
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Duplicate pushes of a message that needs no further delivery are ignored for this long. */
export const DELIVERED_RETENTION_MS = 24 * HOUR_MS;
/** Attempts a run has in flight at once. */
const MAX_IN_FLIGHT = 20;
/** Attempts in flight for a hook that has delivered this run; one before it has, none after a timeout. */
const MAX_PER_HOOK = 4;
/** How long a run keeps starting attempts; it then waits only for those in flight. */
const START_BUDGET_MS = 2 * MINUTE_MS;
/** Attempts one run starts: each is a few subrequests. */
const MAX_STARTS_PER_RUN = 200;
/** Due entries one run reads, a page at a time, so a slow hook that keeps succeeding is never trimmed. */
const READ_BUDGET = 50_000;
const PAGE_SIZE = 200;
/** The passed-over rows a hook keeps once its delivery times out with no success in the run. */
const BACKLOG_KEEP = 1_000;
/** Rows one run trims, which bounds the writes it spends on drops. */
const MAX_TRIMMED_PER_RUN = 2_000;
/** Finished messages one run forgets once their dedupe window has passed; the rest stay due. */
const MAX_FORGOTTEN_PER_RUN = 500;
/**
 * How long a run waits on one attempt (T_kit) before counting it failed: the worst preparation a
 * gatekeeper's `deliver` makes, PagerDuty's, plus the gadget's own call.
 */
const DELIVERY_TIMEOUT_MS = 4 * MINUTE_MS;

/** Why an attempt gave up: the firing missed the dispatch cutoff, or the whole attempt ran past T_kit. */
export class DeliveryTimeout extends Error {
  /** @param stage `"dispatch"` when the kernel was slow to start the firing, else `"deliver"`. */
  constructor(readonly stage: "dispatch" | "deliver") {
    super(`Hook delivery timed out (${stage}).`);
  }
}

/**
 * Delivers one message to one hook. It resolves once the hook has taken the message, and throws or
 * rejects for a retry. `signal` aborts, with a `DeliveryTimeout`, when the run stops waiting: the
 * call can't be cancelled, so stop waiting on it too and release what it holds.
 */
export type Deliver<Message> = (hookKey: string, message: Message, signal: AbortSignal) => Promise<void>;

/** What one run did, for the driver to log. Counts only: never an error, a message or a hook id. */
export type RunReport = {
  /** Attempts that called `deliver`. */
  started: number;
  delivered: number;
  /** Attempts that threw or rejected, not counting timeouts. */
  failed: number;
  /** Firings that missed the 30 s cutoff: the kernel is slow. */
  dispatchTimeouts: number;
  /** Attempts that ran past T_kit: the gatekeeper or the gadget is slow. */
  deliverTimeouts: number;
  /** Rows dropped after `MAX_DELIVERY_ATTEMPTS`. */
  dropped: number;
  /** Rows dropped from the backlog of a hook that hung: never tried, or tried and still due. */
  trimmed: number;
  /** The run read as many due entries as it may: hooks behind them weren't reached. */
  readBudgetReached: boolean;
};

const newReport = (): RunReport => ({
  started: 0, delivered: 0, failed: 0, dispatchTimeouts: 0, deliverTimeouts: 0, dropped: 0, trimmed: 0,
  readBudgetReached: false,
});
/** A clean run reports nothing. A slow hook's backlog nearing the read budget is reported even so. */
const eventful = (report: RunReport) => report.readBudgetReached ||
  report.failed + report.dispatchTimeouts + report.deliverTimeouts + report.dropped + report.trimmed > 0;

/** How an attempt ended. Tagged, so no value `deliver` rejects with can read as a delivery. */
type Outcome = { ok: true } | { ok: false; error: unknown };

/** One run's pool of attempts. */
type RunState = {
  /** The rows with an attempt in flight. */
  inFlight: Set<string>;
  /** Attempts in flight, per hook. */
  perHook: Map<string, number>;
  /** Hooks with a delivery this run. */
  proven: Set<string>;
  /** Hooks with a timeout of either stage this run, which start nothing more. */
  timedOut: Set<string>;
  /** Per hook, the due entries passed over at its cap, oldest first. */
  skipped: Map<string, string[]>;
  /** The one forward pass over the due index: the last entry read, and how many. */
  scan: { position?: string; read: number };
  /** The start window is open. */
  starting: boolean;
  report: RunReport;
  /** What storage threw, rethrown once everything in flight has settled. */
  failure?: { error: unknown };
  /** Lets the run look for room again: a slot freed, a row was queued, or the window closed. */
  wake(): void;
  nextWake(): Promise<void>;
};

function newRunState(): RunState {
  let woken = Promise.withResolvers<void>();
  return {
    inFlight: new Set(), perHook: new Map(), proven: new Set(), timedOut: new Set(), skipped: new Map(),
    scan: { read: 0 }, starting: true, report: newReport(),
    wake: () => woken.resolve(),
    nextWake: async () => {
      await woken.promise;
      woken = Promise.withResolvers<void>();
    },
  };
}

/** A queued delivery of `message` to one hook, when it is next tried, and how many attempts started. */
type Pending<Message> = { message: Message; attempts: number; at: number };
/** A message delivered, skipped or dropped, remembered so a duplicate push doesn't queue it again. */
type Finished = { deliveredAt: number };
type Row<Message> = Pending<Message> | Finished;

const ROWS = "msg:";
const rowKey = (hookKey: string, messageId: string) => `${ROWS}${hookKey}:${messageId}`;
const hookOf = (key: string) => key.slice(ROWS.length, key.indexOf(":", ROWS.length));
/** The wait before a retry, after `attempts` attempts. */
const backoff = (attempts: number) => Math.min(MINUTE_MS * 2 ** (attempts - 1), HOUR_MS);

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
 * A run keeps a pool of attempts in flight, refilled as each settles, so one hook that hangs holds
 * back only its own messages: a hook gets one slot until it delivers in the run, then
 * `MAX_PER_HOOK`, and none after a timeout. Each attempt is counted before its call and given up on
 * after T_kit (4 minutes), so a call cut off by a reset still uses up an attempt. The gadget's call
 * isn't cancelled: a hook can be called again while an earlier call still runs.
 *
 * @example
 * ```ts
 * #queue = new HookDeliveryQueue<Event>(this.ctx.storage.kv, {
 *   onRunReport: report => logger.warn("hook deliveries failed", { event: "hooks.delivery.report", ...report }),
 * });
 *
 * async alarm() {
 *   await this.ctx.storage.setAlarm(Date.now() + MINUTE_MS); // the retry if this handler fails or is killed
 *   try {
 *     await this.#queue.run(Date.now(), (hookKey, event, signal) => this.#deliver(hookKey, event, signal));
 *     const next = this.#queue.nextDue();
 *     if (next !== undefined) await this.ctx.storage.setAlarm(next);
 *     else await this.ctx.storage.deleteAlarm();
 *   } catch (error) {
 *     logger.error("hook driver alarm failed", { event: "hooks.alarm.failed", error }); // the fallback alarm stands
 *   }
 * }
 * ```
 */
export class HookDeliveryQueue<Message> {
  readonly #kv: KvScannable;
  readonly #onRunReport: (report: RunReport) => void;
  /** The run in flight, which `enqueue()` wakes. */
  #active?: RunState;

  /**
   * @param kv The driver's `ctx.storage.kv`.
   * @param options.onRunReport Called once at the end of a run in which an attempt failed or timed
   * out, a message was dropped or trimmed, or the read budget ran out, with its counts. A clean run
   * reports nothing. It is given no error, since a hook's exception can quote the private message
   * it failed on.
   */
  constructor(kv: KvScannable, { onRunReport }: { onRunReport: (report: RunReport) => void }) {
    this.#kv = kv;
    this.#onRunReport = onRunReport;
  }

  /**
   * Queue `message` for the hook unless it is pending or finished within the dedupe window. A run
   * in flight is woken to start it.
   * @param hookKey The hook to deliver to.
   * @param messageId The provider's id for the message, which a duplicate push repeats.
   * @param message What `run()` hands the delivery callback.
   * @param now When the message is first due.
   */
  enqueue(hookKey: string, messageId: string, message: Message, now: number): void {
    this.#index();
    const key = rowKey(hookKey, messageId);
    if (this.#kv.get(key) !== undefined) return;
    this.#putPending(key, { message, attempts: 0, at: now });
    this.#active?.wake();
  }

  /**
   * Finish the hook's pending messages: disabling ends its retries even if it is re-enabled first.
   * A message in flight is finished too, and its attempt's outcome is then ignored.
   * @param hookKey The hook whose messages to finish.
   */
  cancel(hookKey: string): void {
    this.#index();
    const prefix = rowKey(hookKey, "");
    // Listed up front, as finishing deletes. The finished rows still collapse duplicate pushes.
    const pending = [...this.#kv.list<true>({ prefix: DUE })];
    for (const [entry] of pending) {
      const { key, time } = entryRow(DUE, entry);
      if (!key.startsWith(prefix)) continue;
      const row = this.#kv.get<Row<Message>>(key);
      if (!row || "deliveredAt" in row || row.at !== time) this.#kv.delete(entry); // stale: not finished again
      else this.#finish(key, row.at);
    }
  }

  /**
   * Forget finished rows whose dedupe window has passed, then deliver due rows through a pool of
   * up to 20 attempts, refilled as each settles, for up to 2 minutes and at most 200 attempts, and
   * wait for those in flight: about 6 minutes at most. Each attempt is counted before `deliver` is
   * called, and given up on after T_kit. A row is finished once `deliver` resolves, retried with
   * backoff when it throws or times out, and dropped once `MAX_DELIVERY_ATTEMPTS` have started. A
   * hook whose `deliver` times out with no delivery in the run keeps only its newest
   * `BACKLOG_KEEP` (1,000) passed-over rows.
   * @param now The current time, which finished rows are forgotten by. What is due is read against
   * the clock as the run goes, since a run lasts minutes.
   * @param deliver Delivers one message to one hook.
   * @throws What storage threw, once everything in flight has settled and the run is reported.
   */
  async run(now: number, deliver: Deliver<Message>): Promise<void> {
    this.#index();
    this.#forgetExpired(now);
    const run = newRunState();
    this.#active = run;
    const window = setTimeout(() => {
      run.starting = false;
      run.wake();
    }, START_BUDGET_MS);
    try {
      for (;;) {
        if (!run.failure && run.starting) {
          try {
            this.#fill(run, deliver);
          } catch (error) {
            run.failure ??= { error };
          }
        }
        if (run.inFlight.size === 0) break;
        await run.nextWake();
      }
    } finally {
      clearTimeout(window);
      this.#active = undefined;
    }
    if (eventful(run.report)) this.#onRunReport(run.report);
    if (run.failure) throw run.failure.error;
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

  /** Forget finished rows whose dedupe window has passed. */
  #forgetExpired(now: number): void {
    // Read in full before the loop deletes.
    const expired = [...this.#kv.list<true>({
      prefix: FINISHED, end: through(FINISHED, now - DELIVERED_RETENTION_MS), limit: MAX_FORGOTTEN_PER_RUN,
    })];
    for (const [entry] of expired) {
      const { key, time } = entryRow(FINISHED, entry);
      // An entry stays when its row was deleted, and a new one queued under its key.
      if (this.#finishedAt(key) === time) this.#kv.delete(key);
      this.#kv.delete(entry);
    }
  }

  /** Start what the run has room for: passed-over rows first, then on along the due index. */
  #fill(run: RunState, deliver: Deliver<Message>): void {
    // Slow-start: one slot until the hook delivers this run, then MAX_PER_HOOK; none after a timeout.
    const cap = (hook: string) => run.timedOut.has(hook) ? 0 : run.proven.has(hook) ? MAX_PER_HOOK : 1;
    const room = () => run.starting && run.inFlight.size < MAX_IN_FLIGHT && run.report.started < MAX_STARTS_PER_RUN;
    const fits = (hook: string) => (run.perHook.get(hook) ?? 0) < cap(hook);
    for (const [hook, entries] of run.skipped) {
      while (room() && entries.length > 0 && fits(hook)) this.#tryStart(run, entries.shift()!, deliver);
      if (entries.length === 0) run.skipped.delete(hook);
    }
    // One forward pass, its end recomputed per page so rows queued meanwhile are found.
    while (room() && run.scan.read < READ_BUDGET) {
      const page = [...this.#kv.list<true>({
        prefix: DUE, startAfter: run.scan.position, end: through(DUE, Date.now()), limit: PAGE_SIZE,
      })];
      if (page.length === 0) return;
      for (const [entry] of page) {
        run.scan.position = entry;
        run.scan.read++;
        const { key } = entryRow(DUE, entry);
        const hook = hookOf(key); // from the entry: no row read for a row passed over
        if (run.inFlight.has(key)) continue;
        if (fits(hook)) this.#tryStart(run, entry, deliver);
        else if (run.skipped.has(hook)) run.skipped.get(hook)!.push(entry);
        else run.skipped.set(hook, [entry]);
        if (!room()) return;
      }
    }
    if (run.scan.read >= READ_BUDGET) run.report.readBudgetReached = true;
  }

  /** Count an attempt at the row due entry `entry` stands for, and start it. */
  #tryStart(run: RunState, entry: string, deliver: Deliver<Message>): void {
    const { key, time } = entryRow(DUE, entry);
    const row = this.#kv.get<Row<Message>>(key);
    if (!row || "deliveredAt" in row || row.at !== time) {
      this.#kv.delete(entry); // outlived by its row
      return;
    }
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Its last attempt started and never reported back.
      this.#finish(key, row.at);
      run.report.dropped++; // after #finish, so a failed write reports no drop
      return;
    }
    // Stored before the call goes out, as the output gate holds it until then. `at` stays, so a
    // row cut off by a reset is due again at once.
    const counted = { ...row, attempts: row.attempts + 1 };
    this.#kv.put<Pending<Message>>(key, counted);
    run.report.started++;
    const hook = hookOf(key);
    run.inFlight.add(key);
    run.perHook.set(hook, (run.perHook.get(hook) ?? 0) + 1);
    void this.#attempt(run, key, hook, counted, deliver)
      .catch((error: unknown) => { run.failure ??= { error }; })
      .finally(() => {
        run.inFlight.delete(key);
        run.perHook.set(hook, run.perHook.get(hook)! - 1);
        run.wake();
      });
  }

  #attempt(run: RunState, key: string, hook: string, counted: Pending<Message>, deliver: Deliver<Message>): Promise<void> {
    const giveUp = new AbortController();
    const timer = setTimeout(() => giveUp.abort(new DeliveryTimeout("deliver")), DELIVERY_TIMEOUT_MS);
    // Called in a callback, so a synchronous throw is a failed attempt.
    const attempt = Promise.resolve().then(() => deliver(hook, counted.message, giveUp.signal));
    // Raced here as well, so T_kit holds whatever `deliver` does with its signal.
    return untilAborted(attempt, giveUp.signal)
      .then((): Outcome => ({ ok: true }), (error: unknown): Outcome => ({ ok: false, error }))
      .then(outcome => {
        this.#settle(run, key, hook, counted, outcome);
        // After the refile, so a trim write that throws still leaves this row refiled. A dispatch
        // timeout trims nothing: that is the kernel stalling, not the hook.
        const hung = !outcome.ok && outcome.error instanceof DeliveryTimeout && outcome.error.stage === "deliver";
        if (hung && !run.proven.has(hook)) this.#trim(run, hook);
      })
      .finally(() => clearTimeout(timer));
  }

  #settle(run: RunState, key: string, hook: string, counted: Pending<Message>, outcome: Outcome): void {
    const { report } = run;
    if (outcome.ok) {
      report.delivered++;
      run.proven.add(hook);
    } else if (outcome.error instanceof DeliveryTimeout) {
      report[`${outcome.error.stage}Timeouts`]++;
      run.timedOut.add(hook);
    } else {
      report.failed++;
    }
    const row = this.#kv.get<Row<Message>>(key);
    if (!row) {
      // Deleted meanwhile, as a driver forgetting every hook does, which it stays.
      this.#kv.delete(entryKey(DUE, counted.at, key));
      return;
    }
    // Finished meanwhile by disabling the hook, or deleted and queued again: not this attempt's row.
    if ("deliveredAt" in row || row.at !== counted.at || row.attempts !== counted.attempts) return;
    if (outcome.ok) {
      this.#finish(key, counted.at);
    } else if (counted.attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.#finish(key, counted.at);
      report.dropped++;
    } else {
      this.#refile(key, counted.at, { ...counted, at: Date.now() + backoff(counted.attempts) });
    }
  }

  /** Keep only the newest `BACKLOG_KEEP` of the rows `hook`'s run passed over. */
  #trim(run: RunState, hook: string): void {
    const entries = run.skipped.get(hook) ?? [];
    let next = 0;
    while (entries.length - next > BACKLOG_KEEP && run.report.trimmed < MAX_TRIMMED_PER_RUN) {
      const entry = entries[next++]; // oldest first
      const { key, time } = entryRow(DUE, entry);
      if (run.inFlight.has(key)) continue;
      const row = this.#kv.get<Row<Message>>(key);
      if (!row || "deliveredAt" in row || row.at !== time) {
        this.#kv.delete(entry); // outlived by its row: not a drop
        continue;
      }
      if (row.attempts === 0) {
        // Never tried, so forgotten: the row first, as an entry without one is dropped when read.
        this.#kv.delete(key);
        this.#kv.delete(entry);
      } else {
        this.#finish(key, row.at); // tried, so it may have reached the gadget: remembered
      }
      run.report.trimmed++;
    }
    entries.splice(0, next); // one splice, not a shift per entry: a list can hold 50,000
  }

  /** When row `key` finished, if it is a finished row. */
  #finishedAt(key: string): number | undefined {
    const row = this.#kv.get<Row<Message>>(key);
    return row && "deliveredAt" in row ? row.deliveredAt : undefined;
  }

  // Each write below files the new index entry first and deletes the old one last, so a write that
  // throws leaves at worst an extra entry, which is dropped when read, never a row without one.

  #putPending(key: string, row: Pending<Message>): void {
    this.#kv.put(entryKey(DUE, row.at, key), true);
    this.#kv.put<Pending<Message>>(key, row);
  }

  /** Store pending row `key`, filed under `oldAt`, as `row`. */
  #refile(key: string, oldAt: number, row: Pending<Message>): void {
    this.#putPending(key, row);
    if (row.at !== oldAt) this.#kv.delete(entryKey(DUE, oldAt, key));
  }

  /**
   * Finish pending row `key`, filed under `oldAt`, remembering it until the dedupe window has
   * passed. The caller has checked the row is filed there.
   */
  #finish(key: string, oldAt: number): void {
    const at = Date.now();
    this.#kv.put(entryKey(FINISHED, at, key), true);
    this.#kv.put<Finished>(key, { deliveredAt: at });
    this.#kv.delete(entryKey(DUE, oldAt, key));
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
