// Durable record of the actions a resource has queued: the two-tier keyspace `./actions` resolves
// against, and the capacity rule that keeps its pending scan bounded.

import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** The Durable Object KV surface used by the action journal. */
export type ActionJournalKv = KvScannable;

/** Storage keys, overridable so a port keeps reading the records it already wrote. */
export type JournalKeys = {
  nextIdKey?: string;
  /** Must not contain `nextIdKey`, which would then be scanned as a record. */
  recordPrefix?: string;
};

/**
 * Where a record sits. `"applied"` exists only in the retained tier; `"claimed"` means a dispatch
 * is in flight against the provider, and `"failed"` that one ended terminally.
 */
type JournalState = "staged" | "pending" | "claimed" | "failed" | "applied";

/** A stored action and where it sits. Only a `"failed"` record carries an `error`, and it always
 *  does: that reason is why the record outlives the dispatch. */
export type JournalRecord<A> =
  | { state: Exclude<JournalState, "failed">; action: A; error?: never }
  | { state: "failed"; action: A; error: string };

/** One listed entry: the id the overseer knows and the action stored against it. Structurally the
 *  `SimulationRecord` that `createSimulationView` takes. */
export type JournalEntry<A> = { readonly id: number; readonly action: A };

/** The states a read simulates: an in-flight dispatch is still part of the pending world, while
 *  `staged` is not provably the overseer's (a callback naming one promotes it) and `failed` must
 *  stop projecting. */
const PROJECTED: readonly JournalState[] = ["pending", "claimed"];

/** The states a decision may still retire. Deliberately not `PROJECTED`: see `listUndecided`. */
const UNDECIDED: readonly JournalState[] = ["pending"];

/**
 * Marks a record this journal wrote. What this resource stored before adopting the journal is
 * `{ action, state }` too, with its own discriminants (github's actions key on `type`, not `kind`),
 * so shape alone cannot tell them apart — an unmarked record goes to `upgradeRecord` instead of
 * being trusted as current.
 */
const JOURNAL_VERSION = 1;

type StoredJournalRecord<A> = JournalRecord<A> & { v: typeof JOURNAL_VERSION };

/** Unresolved actions one resource may hold. A kit default, not any port's historical limit. */
const DEFAULT_MAX_PENDING = 50;

/**
 * Bound on the records sitting beside the unresolved ones -- `staged`, plus `failed` awaiting the
 * reject that clears it -- as a multiple of `maxPending`. Separate, because counting a `failed`
 * record against the decision cap would let a run of provider failures stop the agent staging
 * anything until the user cleared them by hand. The ratio follows mcp-shared's 50 pending against
 * 100 retained (`action-store.ts:9-12`).
 */
const PRUNABLE_RECORD_FACTOR = 2;

/** What a `failed` record says when storage lost the reason it should carry. */
const FAILURE_REASON_LOST = "This action failed, and the reason was not recorded.";

/** Failure reasons are bounded: `markFailed` rewrites a record that already holds its action, just
 *  after a provider effect, and a value over the storage limit would throw there -- leaving the
 *  record pending and re-running a handler classified non-replayable. */
const MAX_FAILURE_REASON = 1024;

export type ActionJournalOptions<A> = JournalKeys & {
  /**
   * Reads a record written before this gatekeeper adopted the journal; adopted records are taken as
   * `pending`. Return `undefined` to leave one unadopted, and do so for anything already resolved:
   * a store that also kept applied rows would re-offer them as decidable, and approving one re-runs
   * its provider call.
   */
  upgradeRecord?(raw: unknown): A | undefined;
  /**
   * How many unresolved actions this resource may hold, enforced by `allocate`. Defaults to 50.
   * Only a record awaiting a user decision counts; `staged` and `failed` are bounded by
   * `PRUNABLE_RECORD_FACTOR` times this number instead.
   *
   * Accepted edge: past that bound the oldest `failed` record loses its reason, so a later approve
   * reports `Unknown pending action` and a later reject clears it silently.
   */
  maxPending?: number;
};

/**
 * Durable record of the actions this resource has queued.
 *
 * Two tiers: staged and pending records live under `recordPrefix`, and a retained applied record
 * moves to a sibling prefix, so `listPending()`'s scan stays bounded by genuinely pending records
 * however many applied ones accumulate (the shape github already uses). Lookups check both.
 * Retiring the retained tier is consumer policy -- retention is unbounded and caps are per-vendor.
 */
export class ActionJournal<A> {
  readonly #kv: ActionJournalKv;
  readonly #nextIdKey: string;
  readonly #prefix: string;
  readonly #retainedPrefix: string;
  readonly #appliedIdsKey: string;
  readonly #upgradeRecord?: (raw: unknown) => A | undefined;
  readonly #maxPending: number;

  constructor(kv: ActionJournalKv, options: ActionJournalOptions<A> = {}) {
    this.#kv = kv;
    this.#nextIdKey = options.nextIdKey ?? "pending:nextActionId";
    this.#prefix = options.recordPrefix ?? "pending:action:";
    // Outside the pending prefix, not beneath it: a retained record must fall out of that scan.
    this.#retainedPrefix = `retained:${this.#prefix}`;
    // One key, not a tier: the non-numeric suffix keeps it out of every id scan.
    this.#appliedIdsKey = `applied:${this.#prefix}`;
    this.#upgradeRecord = options.upgradeRecord;
    this.#maxPending = requirePositiveInt("maxPending", options.maxPending ?? DEFAULT_MAX_PENDING);

    // Only ports pass these, and a silent overlap corrupts the keyspace: a counter under the record
    // prefix is scanned as a record, and a record prefix under the retained one un-tiers the scan.
    if (!this.#prefix) throw new Error("recordPrefix must not be empty.");
    if (this.#nextIdKey.startsWith(this.#prefix) || this.#prefix.startsWith(this.#nextIdKey)
      || this.#nextIdKey.startsWith(this.#retainedPrefix)
      || this.#nextIdKey === this.#appliedIdsKey) {
      throw new Error(`nextIdKey "${this.#nextIdKey}" overlaps a record prefix.`);
    }
    if (this.#retainedPrefix.startsWith(this.#prefix)) {
      throw new Error(`recordPrefix "${this.#prefix}" would contain its own retained tier.`);
    }
  }

  /** Reserve the next id and stage the action against it. */
  allocate(action: A): number {
    this.#requireCapacity();
    const id = this.#kv.get<number>(this.#nextIdKey) ?? 1;
    // Occupancy or retired-id memory at this id means the counter is behind -- a port pointed
    // `nextIdKey` at a last-issued counter. Raw reads, not `get`: a legacy row `upgradeRecord`
    // cannot convert still occupies the id, and staging over it would corrupt a live or settled id.
    if (this.#kv.get(this.#pendingKey(id)) !== undefined
      || this.#kv.get(this.#retainedKey(id)) !== undefined || this.wasApplied(id)) {
      throw new Error(`Action ${id} was already issued; `
        + `"${this.#nextIdKey}" must hold the next unused id, not the last issued one.`);
    }
    this.#kv.put(this.#nextIdKey, id + 1);
    this.#write(this.#pendingKey(id), { state: "staged", action });
    return id;
  }

  /**
   * The overseer has the action; it is now awaiting a decision. Only a record still staged in the
   * pending tier moves: an auto-approval can apply and retain the record while `submitAction` is
   * still in flight, and stamping "pending" over that would contradict a completed apply.
   */
  markSubmitted(id: number): void {
    this.#transition(id, ["staged"], "pending");
  }

  /** A dispatch is in flight against the provider. Durable, so a later activation can tell an
   *  interrupted apply from one that never started. */
  markClaimed(id: number): void {
    this.#transition(id, ["staged", "pending"], "claimed");
  }

  /** The claimed dispatch failed in a way the user can retry, so the record awaits a decision again. */
  restorePending(id: number): void {
    this.#transition(id, ["claimed"], "pending");
  }

  /**
   * The action failed terminally: it stops projecting into simulation, and `error` becomes the
   * answer every later resolution attempt sees. Only rejecting it clears the record.
   */
  markFailed(id: number, error: string): void {
    const record = this.#transitionable(id, ["staged", "pending", "claimed"]);
    if (record) {
      const reason = error.length > MAX_FAILURE_REASON
        ? `${error.slice(0, MAX_FAILURE_REASON)}\u2026`
        : error;
      this.#write(this.#pendingKey(id), { state: "failed", action: record.action, error: reason });
    }
  }

  /** Submission failed, so the action was never queued -- unless it was already resolved. */
  rollbackSubmission(id: number): void {
    if (this.#isStaged(id)) this.remove(id);
  }

  /**
   * The record behind an id, in any state, preferring the retained tier. A lookup must never filter
   * by state: the output gate commits the staged record before the `submitAction` RPC can leave, so
   * a record still marked "staged" may already be pending for the overseer. It must prefer the
   * retained copy, because an interrupted `retain` leaves the id in both tiers and the applied
   * record is the true one -- it carries the apply-time artifacts a revert hook reads back.
   */
  get(id: number): JournalRecord<A> | undefined {
    return this.#read(this.#retainedKey(id)) ?? this.#read(this.#pendingKey(id));
  }

  /**
   * Move the record to the retained tier as "applied", optionally replacing the action with one
   * carrying apply-time artifacts. This is the whole post-apply write: one writer, one record.
   *
   * Retained record first, then the delete: a throw does not roll back the implicit transaction
   * (see `credentials.ts`), and this runs just after a provider effect. Losing the record would
   * leave nothing to revert from; a failed delete leaves the id in both tiers, which `get` and
   * `listPending` both resolve in the retained tier's favour, so it still reads as applied
   * everywhere.
   */
  retain(id: number, action?: A): void {
    const record = this.get(id);
    // `get` stays state-blind so an interrupted retain can finish its own delete, so the terminal
    // check lives here: retaining a failure would rewrite it as applied and drop its reason.
    if (!record || record.state === "failed") return;
    this.#write(this.#retainedKey(id), {
      state: "applied",
      action: action ?? record.action,
    });
    this.#kv.delete(this.#pendingKey(id));
  }

  /**
   * Forget the id in both tiers. The kit calls this for a rejection and a rolled-back submission;
   * a consumer's own use is retiring its retained tier, which is consumer policy (above).
   */
  remove(id: number): void {
    this.#kv.delete(this.#pendingKey(id));
    this.#kv.delete(this.#retainedKey(id));
  }

  /**
   * Forget an applied id, remembering that it was applied. A replayed resolution then settles
   * instead of erroring or mislabeling it, and the memory is bounded to the prunable allowance.
   */
  retire(id: number): void {
    const ids = this.#kv.get<number[]>(this.#appliedIdsKey) ?? [];
    ids.push(id);
    // Removal first: split writes then degrade to a retryable unknown id, never to a remembered
    // apply whose record still projects.
    this.remove(id);
    this.#kv.put(this.#appliedIdsKey, ids.slice(-this.#maxPending * PRUNABLE_RECORD_FACTOR));
  }

  /** True when a removed id is still within the retired-action memory. */
  wasApplied(id: number): boolean {
    return (this.#kv.get<number[]>(this.#appliedIdsKey) ?? []).includes(id);
  }

  /**
   * True when this id has been applied and retained. Reads through the same coercion as every other
   * lookup: a value this journal would refuse to return from `get()` must not be reported as a
   * retained record either, or the two answers disagree about whether the action exists.
   */
  isRetained(id: number): boolean {
    return this.#read(this.#retainedKey(id)) !== undefined;
  }

  /** Actions a read simulates, ascending — the input `createSimulationView` expects. */
  listPending(): JournalEntry<A>[] {
    return this.#scan(PROJECTED);
  }

  /**
   * Actions the overseer may still decide on, ascending. A claimed dispatch is excluded because its
   * outcome is unknown: nothing may retire it, and nothing may treat the effect it would have had
   * as certain not to have happened.
   */
  listUndecided(): JournalEntry<A>[] {
    return this.#scan(UNDECIDED);
  }

  /** One bounded pass over the pending tier, keeping the records sitting in `states`. */
  #scan(states: readonly JournalState[]): JournalEntry<A>[] {
    const found: JournalEntry<A>[] = [];
    for (const [key, raw] of this.#kv.list<unknown>({ prefix: this.#prefix })) {
      const record = this.#coerce(raw);
      if (record === undefined || !states.includes(record.state)) continue;
      const id = this.#idFrom(key);
      // A record left behind by an interrupted `retain` is applied, not pending: projecting it
      // would simulate an effect the provider has already made real.
      if (id === undefined || this.isRetained(id)) continue;
      found.push({ id, action: record.action });
    }
    return found.toSorted((a, b) => a.id - b.id);
  }

  /**
   * Enforce `maxPending` before an allocation, and bound the records sitting beside the unresolved
   * ones. One scan does both, and the scan is bounded by what it enforces.
   */
  #requireCapacity(): void {
    let unresolved = 0;
    const staged: number[] = [];
    const failed: number[] = [];
    for (const [key, raw] of this.#kv.list<unknown>({ prefix: this.#prefix })) {
      // A key this journal cannot name an id for is not its record: counting one would hold a slot
      // no approval can clear, and pruning one would delete a stranger's key.
      const id = this.#idFrom(key);
      if (id === undefined) continue;
      const state = this.#coerce(raw)?.state;
      // An interrupted `retain` leaves a stale source record here, whatever its state; the retained
      // tier decides, as it does for `get` and `listPending`.
      if (state === undefined || this.isRetained(id)) continue;
      if (state === "staged") staged.push(id);
      else if (state === "failed") failed.push(id);
      else unresolved += 1;
    }
    if (unresolved >= this.#maxPending) {
      throw new Error(
        "Too many pending actions; approve or reject some in the approval queue first.");
    }

    // Staged first whatever their age: one is plumbing a submission left behind, while a `failed`
    // record holds the only account of what went wrong.
    const byId = (a: number, b: number) => a - b;
    const prunable = [...staged.toSorted(byId), ...failed.toSorted(byId)];
    const excess = prunable.length - this.#maxPending * PRUNABLE_RECORD_FACTOR;
    // Clamped, because a negative end counts back from the array's own length: under the bound,
    // `slice(0, -n)` would drop records the user is still owed an answer for.
    for (const id of prunable.slice(0, Math.max(excess, 0))) this.remove(id);
  }

  /** Where a staged, pending, claimed or failed record lives. */
  #pendingKey(id: number): string {
    return `${this.#prefix}${id}`;
  }

  /** Where an applied record lives, once `retain` has moved it out of the pending scan. */
  #retainedKey(id: number): string {
    return `${this.#retainedPrefix}${id}`;
  }

  /** The id a scanned record key names, or undefined when the key is not one this journal wrote.
   *  Leading zeros and exponents are rejected rather than coerced: `Number("01")` would alias a
   *  live record that `remove(id)` then writes a different key for. */
  #idFrom(key: string): number | undefined {
    const suffix = key.slice(this.#prefix.length);
    return /^[1-9]\d*$/.test(suffix) ? Number(suffix) : undefined;
  }

  /** The record at `id` when it is in one of `from`, or undefined when no transition may happen.
   *  A record in any other state is left alone, which is what keeps a resolved or terminally
   *  failed one from being revived. */
  #transitionable(id: number, from: readonly JournalState[]): JournalRecord<A> | undefined {
    const record = this.#read(this.#pendingKey(id));
    return record !== undefined && from.includes(record.state) ? record : undefined;
  }

  /** Rewrite a pending-tier record into a state that carries no failure reason. */
  #transition(id: number, from: readonly JournalState[], next: Exclude<JournalState, "failed">) {
    const record = this.#transitionable(id, from);
    if (record) this.#write(this.#pendingKey(id), { state: next, action: record.action });
  }

  #isStaged(id: number): boolean {
    return this.#read(this.#pendingKey(id))?.state === "staged";
  }

  #write(key: string, record: JournalRecord<A>): void {
    this.#kv.put<StoredJournalRecord<A>>(key, { ...record, v: JOURNAL_VERSION });
  }

  #read(key: string): JournalRecord<A> | undefined {
    return this.#coerce(this.#kv.get<unknown>(key));
  }

  #coerce(raw: unknown): JournalRecord<A> | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    if ("v" in raw && raw.v === JOURNAL_VERSION) {
      // The marker is storage detail; callers see the record only. One fallback here, not one per
      // reader, keeps the type's promise that a failed record explains itself.
      const { state, action, error } = raw as StoredJournalRecord<A>;
      return state === "failed"
        ? { state, action, error: error ?? FAILURE_REASON_LOST }
        : { state, action };
    }
    // Anything else was written by whatever this gatekeeper stored before adopting the journal,
    // and since it only kept records awaiting approval, it was pending.
    const upgraded = this.#upgradeRecord?.(raw);
    return upgraded === undefined ? undefined : { state: "pending", action: upgraded };
  }
}
