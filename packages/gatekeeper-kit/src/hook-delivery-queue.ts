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
/** A message still due this long after it came due is dropped without a call. */
const EXPIRY_MS = 24 * HOUR_MS;
/** Expired rows a run drops for a hook each time it reaches it; the rest wait for the next time. */
const MAX_EXPIRED_PER_VISIT = 1_000;
/** Attempts a run has in flight at once. */
const MAX_IN_FLIGHT = 20;
/**
 * Attempts in flight for a hook that has delivered this run; one before it has. Four even for a
 * hook alone on its driver: more calls at once into one gadget make races and rate limits likelier,
 * and a burst only drains more slowly.
 */
const MAX_PER_HOOK = 4;
/** How long a run keeps starting attempts; it then waits only for those in flight. */
const START_BUDGET_MS = 2 * MINUTE_MS;
/** Attempts one run starts: each is a few subrequests. */
const MAX_STARTS_PER_RUN = 200;
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
  /** Rows dropped still due a day after they came due, as a hook that keeps hanging leaves them. */
  expired: number;
};

const newReport = (): RunReport =>
  ({ started: 0, delivered: 0, failed: 0, dispatchTimeouts: 0, deliverTimeouts: 0, dropped: 0, expired: 0 });
/** A clean run reports nothing. */
const eventful = (report: RunReport) =>
  report.failed + report.dispatchTimeouts + report.deliverTimeouts + report.dropped + report.expired > 0;

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
    inFlight: new Set(), perHook: new Map(), proven: new Set(), starting: true, report: newReport(),
    wake: () => woken.resolve(),
    nextWake: async () => {
      await woken.promise;
      woken = Promise.withResolvers<void>();
    },
  };
}

const room = (run: RunState) =>
  run.starting && run.inFlight.size < MAX_IN_FLIGHT && run.report.started < MAX_STARTS_PER_RUN;
/** Slow-start: one slot until the hook delivers this run, then `MAX_PER_HOOK`. */
const fits = (run: RunState, hook: string) =>
  (run.perHook.get(hook) ?? 0) < (run.proven.has(hook) ? MAX_PER_HOOK : 1);

/** A queued delivery of `message` to one hook, when it is next tried, and how many attempts started. */
type Pending<Message> = { message: Message; attempts: number; at: number };
/** A message delivered, skipped or dropped, remembered so a duplicate push doesn't queue it again. */
type Finished = { deliveredAt: number };
type Row<Message> = Pending<Message> | Finished;
/** A hook's timeouts in a row, and when the pause they earned it ends. */
type Pause = { timeouts: number; until: number };

const ROWS = "msg:";
const rowKey = (hookKey: string, messageId: string) => `${ROWS}${hookKey}:${messageId}`;
const hookOf = (key: string) => key.slice(ROWS.length, key.indexOf(":", ROWS.length));
/** The wait before a retry after `attempts` attempts, and a hook's pause after that many timeouts. */
const backoff = (attempts: number) => Math.min(MINUTE_MS * 2 ** (attempts - 1), HOUR_MS);

// Index entries are filed under a time, so that a range read finds what has come due by then: each
// hook's pending rows by when they are due, each hook with pending rows by when it next needs a run
// (its first due row, or the end of its pause if later), and finished rows by when they finished,
// which the dedupe window counts from.
const DUE = "queue:due:";
const dueOf = (hook: string) => `${DUE}${hook}:`;
const READY = "queue:ready:";
const FINISHED = "queue:finished:";
/** Per hook, the time its `READY` entry is filed under. */
const READY_AT = "queue:readyAt:";
/** Per hook, its `Pause`, until it delivers. */
const PAUSED = "queue:paused:";
/**
 * The layout the rows are indexed in, rebuilt from the rows when it changes: unset before there
 * were indexes, `true` with one due index across hooks.
 */
const INDEXED = "queue:indexed";
const LAYOUT = 2;
/** A time as index keys order it, in milliseconds: fifteen digits, enough until the year 33658. */
const TIME_DIGITS = 15;
const timeKey = (time: number) => String(time).padStart(TIME_DIGITS, "0");
/** The entry filing `rest` under `time` in `index`. */
const entryKey = (index: string, time: number, rest: string) => `${index}${timeKey(time)}:${rest}`;
/** The time an entry of `index` is filed under, and what follows it. */
function entryOf(index: string, entry: string): { time: number; rest: string } {
  return {
    time: Number(entry.slice(index.length, index.length + TIME_DIGITS)),
    rest: entry.slice(index.length + TIME_DIGITS + 1),
  };
}
/** Row `key`'s due entry at `time`. */
function dueKey(key: string, time: number): string {
  const hook = hookOf(key);
  return entryKey(dueOf(hook), time, key.slice(ROWS.length + hook.length + 1));
}
const finishedKey = (key: string, time: number) => entryKey(FINISHED, time, key.slice(ROWS.length));
/** The bound below which an index's entries are filed at `time` or earlier. */
const through = (index: string, time: number) => `${index}${timeKey(time + 1)}`;

/**
 * Queued deliveries, stored under `msg:{hookKey}:{messageId}`, with the indexes the queue reads
 * them by under `queue:`. Hook keys must contain no `:` (drivers use UUIDs). The driver owns its
 * alarm: it calls `run()` from it, and sets it for `nextDue()` afterwards. A driver may delete what
 * the queue stores, as on disconnecting: an index entry whose row is gone is dropped when read.
 *
 * A run keeps a pool of attempts in flight, refilled as each settles, and fills it from the hooks
 * that have come ready, in the order they did, so a hook that hangs holds back only its own
 * messages: it gets one slot until it delivers in the run, then `MAX_PER_HOOK`. A timeout pauses
 * the hook, for longer with each in a row, until it delivers. Each attempt is counted before its
 * call and given up on after T_kit (4 minutes), so a call cut off by a reset still uses up an
 * attempt. The gadget's call isn't cancelled: a hook can be called again while an earlier call
 * still runs.
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
   * out or a message was dropped or expired, with its counts. A clean run reports nothing. It is
   * given no error, since a hook's exception can quote the private message it failed on.
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
   * Finish the hook's pending messages, and end its pause: disabling ends its retries even if it is
   * re-enabled first. A message in flight is finished too, and its attempt's outcome is then
   * ignored.
   * @param hookKey The hook whose messages to finish.
   */
  cancel(hookKey: string): void {
    this.#index();
    const prefix = dueOf(hookKey);
    // Listed up front, as finishing deletes. The finished rows still collapse duplicate pushes.
    const pending = [...this.#kv.list<true>({ prefix })];
    for (const [entry] of pending) {
      const { time, rest } = entryOf(prefix, entry);
      const key = rowKey(hookKey, rest);
      if (this.#pendingAt(key, time)) this.#finish(key, time);
      else this.#kv.delete(entry); // outlived by its row: not finished again
    }
    this.#kv.delete(PAUSED + hookKey);
    this.#schedule(hookKey);
  }

  /**
   * Forget finished rows whose dedupe window has passed, then deliver due rows through a pool of
   * up to 20 attempts, refilled as each settles, for up to 2 minutes and at most 200 attempts, and
   * wait for those in flight: about 6 minutes at most. Each attempt is counted before `deliver` is
   * called, and given up on after T_kit. A row is finished once `deliver` resolves, retried with
   * backoff when it throws or times out, and dropped once `MAX_DELIVERY_ATTEMPTS` have started, or
   * when it is reached still due a day after it came due.
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
   * @returns The earliest time the queue needs the alarm (a hook coming ready, or a finished row's
   * expiry), or undefined. A paused hook comes ready when its pause ends.
   */
  nextDue(): number | undefined {
    this.#index();
    const first = (index: string) =>
      [...this.#kv.list<true>({ prefix: index, limit: 1 })].map(([entry]) => entryOf(index, entry).time);
    const times = [...first(READY), ...first(FINISHED).map(finishedAt => finishedAt + DELIVERED_RETENTION_MS)];
    return times.length === 0 ? undefined : Math.min(...times);
  }

  /** Forget finished rows whose dedupe window has passed. */
  #forgetExpired(now: number): void {
    // Read in full before the loop deletes.
    const expired = [...this.#kv.list<true>({
      prefix: FINISHED, end: through(FINISHED, now - DELIVERED_RETENTION_MS), limit: MAX_FORGOTTEN_PER_RUN,
    })];
    for (const [entry] of expired) {
      const { time, rest } = entryOf(FINISHED, entry);
      const key = ROWS + rest;
      // An entry stays when its row was deleted, and a new one queued under its key.
      if (this.#finishedAt(key) === time) this.#kv.delete(key);
      this.#kv.delete(entry);
    }
  }

  /** Start what the run has room for: the ready hooks, in the order they came ready. */
  #fill(run: RunState, deliver: Deliver<Message>): void {
    const now = Date.now();
    // Hooks at their cap are at most MAX_IN_FLIGHT, so twice that many ready ones reach every slot.
    const ready = [...this.#kv.list<true>({ prefix: READY, end: through(READY, now), limit: 2 * MAX_IN_FLIGHT })];
    for (const [entry] of ready) {
      if (!room(run)) return;
      const { time, rest: hook } = entryOf(READY, entry);
      if (this.#kv.get<number>(READY_AT + hook) !== time) this.#kv.delete(entry); // outlived by the hook's
      else if (fits(run, hook)) this.#fillHook(run, hook, now, deliver);
    }
  }

  /** Start what `hook` has room for, oldest first, once it has dropped its expired rows. */
  #fillHook(run: RunState, hook: string, now: number, deliver: Deliver<Message>): void {
    this.#expire(run, hook, now);
    const prefix = dueOf(hook);
    // Those in flight come first, being the oldest, so this many reach every slot the hook has.
    const due = [...this.#kv.list<true>({
      prefix, startAfter: through(prefix, now - EXPIRY_MS), end: through(prefix, now), limit: MAX_PER_HOOK,
    })];
    for (const [entry] of due) {
      if (!room(run) || !fits(run, hook)) return;
      const { time, rest } = entryOf(prefix, entry);
      const key = rowKey(hook, rest);
      if (!run.inFlight.has(key)) this.#tryStart(run, hook, key, time, deliver);
    }
    // Filed early, as after a write that threw: nothing is due yet.
    if (due.length === 0 && !run.perHook.get(hook)) this.#schedule(hook);
  }

  /** Drop `hook`'s rows still due a day after they came due, but none in flight. */
  #expire(run: RunState, hook: string, now: number): void {
    const prefix = dueOf(hook);
    // Read in full before the loop finishes rows.
    const expired = [...this.#kv.list<true>({
      prefix, end: through(prefix, now - EXPIRY_MS), limit: MAX_EXPIRED_PER_VISIT,
    })];
    if (expired.length === 0) return;
    for (const [entry] of expired) {
      const { time, rest } = entryOf(prefix, entry);
      const key = rowKey(hook, rest);
      if (run.inFlight.has(key)) continue;
      if (!this.#pendingAt(key, time)) {
        this.#kv.delete(entry); // outlived by its row: not a drop
        continue;
      }
      this.#finish(key, time); // as it may have reached the gadget: remembered
      run.report.expired++; // after #finish, so a failed write reports nothing
    }
    this.#schedule(hook);
  }

  /** Count an attempt at row `key`, which `hook`'s due entry at `time` stands for, and start it. */
  #tryStart(run: RunState, hook: string, key: string, time: number, deliver: Deliver<Message>): void {
    const row = this.#pendingAt(key, time);
    if (!row) {
      this.#kv.delete(dueKey(key, time)); // outlived by its row
      return this.#schedule(hook);
    }
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      // Its last attempt started and never reported back.
      this.#finish(key, row.at);
      run.report.dropped++; // after #finish, so a failed write reports no drop
      return this.#schedule(hook);
    }
    // Stored before the call goes out, as the output gate holds it until then. `at` stays, so a
    // row cut off by a reset is due again at once.
    const counted = { ...row, attempts: row.attempts + 1 };
    this.#kv.put<Pending<Message>>(key, counted);
    run.report.started++;
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
      .then(outcome => this.#settle(run, key, hook, counted, outcome))
      .finally(() => clearTimeout(timer));
  }

  #settle(run: RunState, key: string, hook: string, counted: Pending<Message>, outcome: Outcome): void {
    const { report } = run;
    const timeout = !outcome.ok && outcome.error instanceof DeliveryTimeout ? outcome.error : undefined;
    if (outcome.ok) {
      report.delivered++;
      run.proven.add(hook);
    } else if (timeout) {
      report[`${timeout.stage}Timeouts`]++;
    } else {
      report.failed++;
    }
    const row = this.#kv.get<Row<Message>>(key);
    if (!row) {
      // Deleted meanwhile, as a driver forgetting every hook does, which it stays.
      this.#kv.delete(dueKey(key, counted.at));
      return this.#schedule(hook);
    }
    // Finished meanwhile by disabling the hook, or deleted and queued again: not this attempt's row.
    if ("deliveredAt" in row || row.at !== counted.at || row.attempts !== counted.attempts) return;
    if (outcome.ok) {
      this.#finish(key, counted.at);
      this.#kv.delete(PAUSED + hook);
    } else if (counted.attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.#finish(key, counted.at);
      report.dropped++;
    } else {
      this.#refile(key, counted.at, { ...counted, at: Date.now() + backoff(counted.attempts) });
    }
    if (timeout) {
      const timeouts = (this.#kv.get<Pause>(PAUSED + hook)?.timeouts ?? 0) + 1;
      this.#kv.put<Pause>(PAUSED + hook, { timeouts, until: Date.now() + backoff(timeouts) });
    }
    this.#schedule(hook);
  }

  /**
   * File `hook` in the ready index for when it next needs a run: when its first row is due, or its
   * pause ends if later. The new entry is filed first and the old one deleted last, so a write that
   * throws leaves at worst an entry its hook has outlived, dropped when read, or one filed early.
   */
  #schedule(hook: string): void {
    const prefix = dueOf(hook);
    const [first] = this.#kv.list<true>({ prefix, limit: 1 });
    const ready = first && Math.max(entryOf(prefix, first[0]).time, this.#kv.get<Pause>(PAUSED + hook)?.until ?? 0);
    const filed = this.#kv.get<number>(READY_AT + hook);
    if (ready === filed) return;
    if (ready === undefined) {
      this.#kv.delete(READY_AT + hook);
    } else {
      this.#kv.put(entryKey(READY, ready, hook), true);
      this.#kv.put(READY_AT + hook, ready);
    }
    if (filed !== undefined) this.#kv.delete(entryKey(READY, filed, hook));
  }

  /** Row `key`, if it is pending and filed under `time`: not finished, deleted or refiled since. */
  #pendingAt(key: string, time: number): Pending<Message> | undefined {
    const row = this.#kv.get<Row<Message>>(key);
    return row && !("deliveredAt" in row) && row.at === time ? row : undefined;
  }

  /** When row `key` finished, if it is a finished row. */
  #finishedAt(key: string): number | undefined {
    const row = this.#kv.get<Row<Message>>(key);
    return row && "deliveredAt" in row ? row.deliveredAt : undefined;
  }

  // Each write below files the new index entry first and deletes the old one last, so a write that
  // throws leaves at worst an extra entry, which is dropped when read, never a row without one. A
  // row's hook is filed for it before the row is stored, and refiled later only once it is.

  #putPending(key: string, row: Pending<Message>): void {
    this.#kv.put(dueKey(key, row.at), true);
    this.#schedule(hookOf(key));
    this.#kv.put<Pending<Message>>(key, row);
  }

  /** Store pending row `key`, filed under `oldAt`, as `row`. */
  #refile(key: string, oldAt: number, row: Pending<Message>): void {
    this.#putPending(key, row);
    if (row.at !== oldAt) this.#kv.delete(dueKey(key, oldAt));
  }

  /**
   * Finish pending row `key`, filed under `oldAt`, remembering it until the dedupe window has
   * passed. The caller has checked the row is filed there, and refiles its hook.
   */
  #finish(key: string, oldAt: number): void {
    const at = Date.now();
    this.#kv.put(finishedKey(key, at), true);
    this.#kv.put<Finished>(key, { deliveredAt: at });
    this.#kv.delete(dueKey(key, oldAt));
  }

  /** File every row in the current layout, once: rows stored in an older one, or before any. */
  #index(): void {
    const layout = this.#kv.get(INDEXED);
    if (layout === LAYOUT) return;
    // The old layout's one due index across hooks, `queue:due:<time>:<hook>:<id>`.
    const old = [...this.#kv.list<true>({ prefix: DUE })];
    for (const [entry] of old) this.#kv.delete(entry);
    const hooks = new Set<string>();
    const rows = [...this.#kv.list<Row<Message>>({ prefix: ROWS })];
    for (const [key, row] of rows) {
      if ("deliveredAt" in row) {
        if (layout === undefined) this.#kv.put(finishedKey(key, row.deliveredAt), true);
      } else {
        this.#kv.put(dueKey(key, row.at), true);
        hooks.add(hookOf(key));
      }
    }
    for (const hook of hooks) this.#schedule(hook);
    this.#kv.put(INDEXED, LAYOUT);
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
