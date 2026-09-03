/** Durable action lifecycle storage for approval, simulation, retry, and retention. */

import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** The Durable Object KV surface used by the action journal. */
export type ActionJournalKv = KvScannable;

/** Storage keys, overridable so a port keeps reading the records it already wrote. */
export type JournalKeys = {
  /** Stores the next unused ID, never the last issued ID. */
  nextIdKey?: string;
  /** Must not contain `nextIdKey`, which would then be scanned as a record. */
  recordPrefix?: string;
};

/**
 * Journal lifecycle state. Applied records live only in retained storage; claimed records have a
 * provider dispatch in flight.
 */
type JournalState = "staged" | "pending" | "claimed" | "failed" | "applied";

/** A stored action. Failed records always include a reason. */
export type JournalRecord<A> =
  | { state: Exclude<JournalState, "failed">; action: A; error?: never }
  | { state: "failed"; action: A; error: string };

/** An action ID and payload used by simulation. */
export type JournalEntry<A> = { readonly id: number; readonly action: A };

// Reads project pending and claimed actions; staged is not yet proven submitted, and failed is terminal.
const PROJECTED: readonly JournalState[] = ["pending", "claimed"];

const UNDECIDED: readonly JournalState[] = ["pending"];

// The version distinguishes kit records from legacy rows that may have the same shape.
// Unmarked rows must go through `upgradeRecord`.
const JOURNAL_VERSION = 1;

type StoredJournalRecord<A> = JournalRecord<A> & { v: typeof JOURNAL_VERSION };

const DEFAULT_MAX_PENDING = 50;

// Bound staged and failed records separately; terminal failures must not consume decision capacity.
const PRUNABLE_RECORD_FACTOR = 2;

const FAILURE_REASON_LOST = "This action failed, and the reason was not recorded.";

// Bound the reason so a post-provider storage write cannot exceed DO limits.
const MAX_FAILURE_REASON = 1024;

export type ActionJournalOptions<A> = JournalKeys & {
  /**
   * Converts a legacy unresolved record. Resolved records must return `undefined`, or their provider
   * effects could be replayed.
   * @param raw Stored legacy value.
   * @returns The converted action, or `undefined` when unsupported.
   */
  upgradeRecord?(raw: unknown): A | undefined;
  /**
   * Maximum unresolved actions. Staged and failed records have a separate bounded allowance.
   */
  maxPending?: number;
};

/**
 * Durable record of a resource's queued actions. Pending and retained records use separate prefixes
 * so pending scans stay bounded. Retained records are not capped; consumers own retirement.
 *
 * @example
 * ```ts
 * const journal = new ActionJournal<PendingAction>(ctx.storage.kv);
 * const pending = createSimulationView(
 *   journal.listPending(),
 *   action => action.projectIds,
 * );
 * return pending.forTarget(projectId);
 * ```
 */
export class ActionJournal<A> {
  readonly #kv: ActionJournalKv;
  readonly #nextIdKey: string;
  readonly #prefix: string;
  readonly #retainedPrefix: string;
  readonly #appliedIdsKey: string;
  readonly #upgradeRecord?: (raw: unknown) => A | undefined;
  readonly #maxPending: number;

  /**
   * Creates an action journal.
   * @param kv Durable Object storage for journal records.
   * @param options Storage keys, migration, and capacity settings.
   */
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

  /**
   * Reserves and stages the next action.
   * @param action Payload to store.
   * @returns Allocated action ID.
   */
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
   * Marks a staged action as submitted, leaving later states unchanged.
   * @param id Action ID to update.
   */
  markSubmitted(id: number): void {
    this.#transition(id, ["staged"], "pending");
  }

  /**
   * Marks a provider dispatch in flight.
   * @param id Action ID to claim.
   */
  markClaimed(id: number): void {
    this.#transition(id, ["staged", "pending"], "claimed");
  }

  /**
   * Restores a retryable claim to pending.
   * @param id Action ID to restore.
   */
  restorePending(id: number): void {
    this.#transition(id, ["claimed"], "pending");
  }

  /**
   * Records a terminal failure and removes the action from simulation.
   * @param id Action ID that failed.
   * @param error Display-safe failure reason.
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

  /**
   * Removes a submission that never reached the overseer.
   * @param id Action ID to roll back.
   */
  rollbackSubmission(id: number): void {
    if (this.#isStaged(id)) this.remove(id);
  }

  /**
   * Finds a record, preferring a retained copy after an interrupted move.
   * @param id Action ID to find.
   * @returns The stored record, or `undefined` when absent.
   */
  get(id: number): JournalRecord<A> | undefined {
    return this.#read(this.#retainedKey(id)) ?? this.#read(this.#pendingKey(id));
  }

  /**
   * Moves a record to the retained tier as applied.
   * @param id Action ID to retain.
   * @param action Optional replacement carrying apply-time artifacts.
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
   * Removes an action from both storage tiers.
   * @param id Action ID to remove.
   */
  remove(id: number): void {
    this.#kv.delete(this.#pendingKey(id));
    this.#kv.delete(this.#retainedKey(id));
  }

  /**
   * Removes an applied action, remembering the id so a replayed resolution settles instead of
   * erroring or mislabeling it. Memory is bounded to the prunable allowance.
   * @param id Action ID to retire.
   */
  retire(id: number): void {
    const ids = this.#kv.get<number[]>(this.#appliedIdsKey) ?? [];
    ids.push(id);
    // Removal first: split writes then degrade to a retryable unknown id, never to a remembered
    // apply whose record still projects.
    this.remove(id);
    this.#kv.put(this.#appliedIdsKey, ids.slice(-this.#maxPending * PRUNABLE_RECORD_FACTOR));
  }

  /**
   * Checks whether a removed action is remembered as applied.
   * @param id Action ID to check.
   * @returns Whether the id is within the retired-action memory.
   */
  wasApplied(id: number): boolean {
    return (this.#kv.get<number[]>(this.#appliedIdsKey) ?? []).includes(id);
  }

  /**
   * Checks whether an action has a valid retained record.
   * @param id Action ID to check.
   * @returns Whether a retained record exists.
   */
  isRetained(id: number): boolean {
    return this.#read(this.#retainedKey(id)) !== undefined;
  }

  /** @returns Actions visible to simulation, ordered by ID. */
  listPending(): JournalEntry<A>[] {
    return this.#scan(PROJECTED);
  }

  /** @returns Actions still eligible for a decision, ordered by ID. */
  listUndecided(): JournalEntry<A>[] {
    return this.#scan(UNDECIDED);
  }

  /**
   * Scans the pending tier for selected states.
   * @param states States to include.
   * @returns Matching actions ordered by ID.
   */
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

  /** Enforces capacity and prunes excess staged or failed records. */
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

  /**
   * Builds a pending-tier key.
   * @param id Action ID.
   * @returns Storage key for the action.
   */
  #pendingKey(id: number): string {
    return `${this.#prefix}${id}`;
  }

  /**
   * Builds a retained-tier key.
   * @param id Action ID.
   * @returns Storage key for the action.
   */
  #retainedKey(id: number): string {
    return `${this.#retainedPrefix}${id}`;
  }

  /**
   * Parses a canonical action ID from a storage key.
   * @param key Scanned storage key.
   * @returns The action ID, or `undefined` for an unrelated key.
   */
  #idFrom(key: string): number | undefined {
    const suffix = key.slice(this.#prefix.length);
    return /^[1-9]\d*$/.test(suffix) ? Number(suffix) : undefined;
  }

  /**
   * Finds a record eligible for a transition.
   * @param id Action ID to inspect.
   * @param from Allowed current states.
   * @returns The record, or `undefined` when the transition is invalid.
   */
  #transitionable(id: number, from: readonly JournalState[]): JournalRecord<A> | undefined {
    const record = this.#read(this.#pendingKey(id));
    return record !== undefined && from.includes(record.state) ? record : undefined;
  }

  /**
   * Applies a state transition when allowed.
   * @param id Action ID to update.
   * @param from Allowed current states.
   * @param next New state.
   */
  #transition(id: number, from: readonly JournalState[], next: Exclude<JournalState, "failed">) {
    const record = this.#transitionable(id, from);
    if (record) this.#write(this.#pendingKey(id), { state: next, action: record.action });
  }

  /**
   * Checks whether an action is still staged.
   * @param id Action ID to inspect.
   * @returns Whether the action is staged.
   */
  #isStaged(id: number): boolean {
    return this.#read(this.#pendingKey(id))?.state === "staged";
  }

  /**
   * Writes a versioned record.
   * @param key Storage key.
   * @param record Record to store.
   */
  #write(key: string, record: JournalRecord<A>): void {
    this.#kv.put<StoredJournalRecord<A>>(key, { ...record, v: JOURNAL_VERSION });
  }

  /**
   * Reads and validates a journal record.
   * @param key Storage key.
   * @returns The record, or `undefined` when absent or invalid.
   */
  #read(key: string): JournalRecord<A> | undefined {
    return this.#coerce(this.#kv.get<unknown>(key));
  }

  /**
   * Converts current or legacy storage into a journal record.
   * @param raw Stored value.
   * @returns A journal record, or `undefined` when unsupported.
   */
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
