/** Durable action lifecycle storage for approval, simulation, retry, and retention. */

import type { BranchView } from "@gadgets/workshop-shared/gatekeeper";
import type { KvScannable } from "./kv";
import { reservedObserverOverlap } from "./observer-keys";
import { requirePositiveInt } from "./positive-int";

/** The Durable Object KV surface used by the action journal. */
export type ActionJournalKv = KvScannable;

/**
 * Where one journal's records live. Two journals over one Durable Object must not share a
 * keyspace: they would share ids and capacity while each bound action set serializes apply and
 * reject on its own in-memory queue, so nothing would order their provider calls against each
 * other.
 *
 * `namespace` derives every key and is what new code passes. `legacyKeys` is the escape hatch for
 * a port that must keep reading records it already wrote; the two are mutually exclusive.
 */
export type JournalKeys =
  | {
    /** Distinguishes this journal's keys from every other journal over the same storage. */
    namespace: string;
    legacyKeys?: never;
  }
  | {
    namespace?: never;
    /** The exact pre-kit key layout. Only a port with existing records passes this. */
    legacyKeys: {
      /** Stores the next unused ID, never the last issued ID. */
      nextIdKey: string;
      /** Must not contain `nextIdKey`, which would then be scanned as a record. */
      recordPrefix: string;
    };
  };

/**
 * Journal lifecycle state. Applied records live only in retained storage; claimed records have a
 * provider dispatch in flight.
 */
type JournalState = "staged" | "pending" | "claimed" | "failed" | "applied";

/**
 * The authority an action was staged under, opaque and equality-only. Nothing may be inferred from
 * its content or ordering, and the journal never interprets it: a kind the set declares
 * `"authority"` is staged with one and apply refuses a record whose value has changed.
 *
 * The field is named `generation` because the common fence is the connection generation, which
 * makes a `CredentialRead` structurally an `ActionFence`. A consumer wanting account-scoped rather
 * than connection-scoped fencing stores its own stable provider account id here instead, and
 * passes that same id at apply.
 */
export type ActionFence = { generation: string };

/**
 * A stored action. Failed records always include a reason, and classify whether the provider
 * effect is known not to have landed or is simply unknown.
 *
 * `view` is the view the action was submitted under (see `BranchView`), stored by a session handle
 * (`BoundActionSet.session()`). A record with none was submitted another way, or before views
 * existed: every view sees it, ahead of everything that has one.
 */
export type JournalRecord<A> =
  | {
    state: Exclude<JournalState, "failed">; action: A; fence?: ActionFence; view?: BranchView;
    error?: never; undispatched?: never; outcome?: never;
  }
  | {
    state: "failed"; action: A; fence?: ActionFence; view?: BranchView; error: string;
    /** The apply refused before the handler ran, so a rejection still owes its cleanup. */
    undispatched?: true;
    /**
     * Whether the provider effect is known absent. `"unknown"` means the handler may have
     * committed it: the record is never replayed, never pruned, and strands no dependents, since
     * the reference it provides may in fact exist. Absent reads as `"not-applied"`, which is the
     * only classification a record written before this field could have had.
     */
    outcome?: "not-applied" | "unknown";
  };

/** An action ID and payload used by simulation. */
export type JournalEntry<A> = { readonly id: number; readonly action: A };

/** Where a pending action stands in a view's order: what it was submitted under, and its ID. */
type Placed = { readonly id: number; readonly view?: BranchView };

/**
 * Whether an action is visible in `view`: one with no view, or staged, is visible in every view;
 * one on a branch, in that branch's view and in the views of branches forked from it after it.
 * @param view The view reading.
 * @param action The action and the view it was submitted under.
 * @returns Whether `view` sees the action.
 */
export function visibleIn(view: BranchView, action: Placed): boolean {
  const branch = action.view?.branch;
  if (branch === undefined || branch === null || branch === view.branch) return true;
  return view.ancestors?.some(ancestor =>
    ancestor.branch === branch && action.id <= ancestor.through) ?? false;
}

// A view's order (see `BranchView`): actions with no view, then staged ones, then the branch's and
// its ancestors', each group by ID.
const groupOf = (action: Placed): number =>
  action.view === undefined ? 0 : action.view.branch === null ? 1 : 2;
const inViewOrder = (a: Placed, b: Placed): number =>
  groupOf(a) - groupOf(b) || a.id - b.id;

/**
 * Whether `later` could have been built on `earlier`: `earlier` is visible in the view `later`
 * was submitted under, and comes before it in that view's order. An action with no view was
 * submitted when every session saw every pending action, in ID order.
 */
function builtOn(later: Placed, earlier: Placed): boolean {
  if (later.view === undefined) return earlier.id < later.id;
  return visibleIn(later.view, earlier) && inViewOrder(earlier, later) < 0;
}

/**
 * Whether the action that submitted under `dependent.view` could see `provider`, and so may name
 * a reference it provides. One with no view could see everything.
 */
export function couldSee(dependent: Placed, provider: Placed): boolean {
  return dependent.view === undefined || visibleIn(dependent.view, provider);
}

/**
 * Copies a view down to the fields it declares, so what a record stores is a view and nothing
 * the caller happened to attach to it.
 * @param view The view to copy.
 * @returns The copy, with no `ancestors` key when there are none.
 */
export function copyView(view: BranchView): BranchView {
  return {
    branch: view.branch,
    ...(view.ancestors?.length
      ? { ancestors: view.ancestors.map(({ branch, through }) => ({ branch, through })) }
      : {}),
  };
}

/** One storage-bounded page of retained actions. */
export type RetainedActionPage<A> = {
  /** Valid applied records found in this storage page. */
  entries: JournalEntry<A>[];
  /** Opaque position for the next scan; absent once storage returned a short page. */
  nextCursor?: string;
};

// Reads project pending and claimed actions; staged is not yet proven submitted, and failed is terminal.
const PROJECTED: readonly JournalState[] = ["pending", "claimed"];

const UNDECIDED: readonly JournalState[] = ["pending"];

// The version distinguishes kit records from legacy rows that may have the same shape, so it skips
// 1: a port whose own pre-kit rows carry `v: 1` would have them read as kit records, bypassing
// `upgradeRecord`. Unmarked rows must go through it.
const JOURNAL_VERSION = 2;

type StoredJournalRecord<A> = JournalRecord<A> & { v: typeof JOURNAL_VERSION };

const DEFAULT_MAX_PENDING = 50;

// Bound staged and failed records separately; terminal failures must not consume decision capacity.
const PRUNABLE_RECORD_FACTOR = 2;

const FAILURE_REASON_LOST = "This action failed, and the reason was not recorded.";

// Bound the reason so a post-provider storage write cannot exceed DO limits.
const MAX_FAILURE_REASON = 1024;

// Keeps a derived key unambiguous: no separator that could forge a prefix boundary.
const JOURNAL_NAMESPACE = /^[A-Za-z0-9_-]+$/;

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
 * const journal = new ActionJournal<PendingAction>(ctx.storage.kv, { namespace: "calendar" });
 * // A session reads through its handle (`BoundActionSet.session()`), which shows it its own view.
 * const pending = createSimulationView(
 *   session.pending(),
 *   action => action.projectIds,
 *   { keepOrder: true },
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
   * @param options `namespace` (or a port's `legacyKeys`), migration, and capacity settings.
   */
  constructor(kv: ActionJournalKv, options: ActionJournalOptions<A>) {
    this.#kv = kv;
    const keys = options.legacyKeys ?? {
      nextIdKey: `${options.namespace}:nextActionId`,
      recordPrefix: `${options.namespace}:action:`,
    };
    this.#nextIdKey = keys.nextIdKey;
    this.#prefix = keys.recordPrefix;
    // Outside the pending prefix, not beneath it: a retained record must fall out of that scan.
    this.#retainedPrefix = `retained:${this.#prefix}`;
    // One key, not a tier: the non-numeric suffix keeps it out of every id scan.
    this.#appliedIdsKey = `applied:${this.#prefix}`;
    this.#upgradeRecord = options.upgradeRecord;
    this.#maxPending = requirePositiveInt("maxPending", options.maxPending ?? DEFAULT_MAX_PENDING);

    if (options.legacyKeys === undefined && !JOURNAL_NAMESPACE.test(options.namespace ?? "")) {
      throw new Error(
        `Journal namespace "${options.namespace}" must match ${JOURNAL_NAMESPACE.source}.`);
    }
    // A silent overlap corrupts the keyspace: a counter under the record prefix is scanned as a
    // record, and a record prefix under the retained one un-tiers the scan. Only reachable through
    // `legacyKeys`, since a derived pair cannot collide.
    if (!this.#prefix) throw new Error("recordPrefix must not be empty.");
    if (this.#nextIdKey.startsWith(this.#prefix) || this.#prefix.startsWith(this.#nextIdKey)
      || this.#nextIdKey.startsWith(this.#retainedPrefix)
      || this.#nextIdKey === this.#appliedIdsKey) {
      throw new Error(`nextIdKey "${this.#nextIdKey}" overlaps a record prefix.`);
    }
    if (this.#retainedPrefix.startsWith(this.#prefix)) {
      throw new Error(`recordPrefix "${this.#prefix}" would contain its own retained tier.`);
    }
    // Observer storage is scanned by prefix, so records landing inside it come back as verifiers
    // or as an unsettled withheld read -- type-confused ACL checks, and sharing fenced for good.
    const observerOverlap = reservedObserverOverlap(this.#prefix)
      ?? reservedObserverOverlap(this.#nextIdKey);
    if (observerOverlap !== undefined) {
      throw new Error(`Journal keys overlap the reserved observer prefix "${observerOverlap}".`);
    }
  }

  /**
   * Reserves and stages the next action.
   * @param action Payload to store.
   * @param fence Connection generation the staging operation ran under.
   * @param view The view the action is submitted under, when a session handle submits it. The cap
   * then counts only the unresolved actions of its branch (or of staging).
   * @returns Allocated action ID.
   */
  allocate(action: A, fence?: ActionFence, view?: BranchView): number {
    this.#requireCapacity(view);
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
    this.#write(this.#pendingKey(id), {
      state: "staged",
      action,
      ...(fence ? { fence: { generation: fence.generation } } : {}),
      ...(view ? { view: copyView(view) } : {}),
    });
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
   * @param options `undispatched` when the apply refused before reaching the handler; `outcome`
   * classifies whether the provider effect is known absent, defaulting to `"not-applied"`.
   */
  markFailed(
    id: number,
    error: string,
    options: { undispatched?: boolean; outcome?: "not-applied" | "unknown" } = {},
  ): void {
    const record = this.#transitionable(id, ["staged", "pending", "claimed"]);
    if (record) {
      const reason = error.length > MAX_FAILURE_REASON
        ? `${error.slice(0, MAX_FAILURE_REASON)}\u2026`
        : error;
      this.#write(this.#pendingKey(id), {
        state: "failed",
        action: record.action,
        error: reason,
        ...(options.undispatched ? { undispatched: true } as const : {}),
        // Only the non-default is stored, so a record carries no key for the ordinary case.
        ...(options.outcome === "unknown" ? { outcome: "unknown" } as const : {}),
        ...carried(record),
      });
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
      ...carried(record),
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
   * erroring or mislabeling it. Idempotent, so an interrupted retire can be finished by the next
   * apply. Memory is bounded to the prunable allowance.
   * @param id Action ID to retire.
   */
  retire(id: number): void {
    const ids = this.#appliedIds();
    // Tombstone first: split writes then degrade to a stale record the scans below filter out and
    // the next apply retires, never to a remembered apply whose record still projects. A failed
    // tombstone write leaves the record applicable again, which at-least-once apply already owns.
    if (!ids.includes(id)) {
      ids.push(id);
      this.#kv.put(this.#appliedIdsKey, ids.slice(-this.#maxPending * PRUNABLE_RECORD_FACTOR));
    }
    this.remove(id);
  }

  /**
   * Checks whether a removed action is remembered as applied.
   * @param id Action ID to check.
   * @returns Whether the id is within the retired-action memory.
   */
  wasApplied(id: number): boolean {
    return this.#appliedIds().includes(id);
  }

  /** @returns The action IDs held in the retired-action memory. */
  #appliedIds(): number[] {
    return this.#kv.get<number[]>(this.#appliedIdsKey) ?? [];
  }

  /** @returns The retired-action memory as a set, for scans that test many ids. */
  #appliedSet(): Set<number> {
    return new Set(this.#appliedIds());
  }

  /**
   * Checks whether an action has a valid retained record.
   * @param id Action ID to check.
   * @returns Whether a retained record exists.
   */
  isRetained(id: number): boolean {
    return this.#read(this.#retainedKey(id)) !== undefined;
  }

  /**
   * Lists one storage-bounded page of retained actions. Invalid or non-applied rows are omitted
   * (and a row an interrupted `retire` left behind is deleted) but still consume the storage limit,
   * so an empty `entries` array may carry `nextCursor`. Keep calling with the returned opaque
   * cursor until it is absent. Call `retire(id)` to remove a retained action while preserving
   * applied-id replay memory.
   * @param options Storage page size and the previous page's opaque cursor.
   * @returns Retained actions from this storage page and its continuation position.
   */
  listRetained(
    options: { limit: number; cursor?: string },
  ): RetainedActionPage<A> {
    const limit = requirePositiveInt("limit", options.limit);
    const entries: JournalEntry<A>[] = [];
    // A `retire` whose delete threw leaves a tombstoned row here. Finish that delete rather than
    // hide the row: the tombstone memory is bounded, so a row merely omitted would resurface --
    // and hand the consumer a finished action twice -- once later retires evict its id.
    const applied = this.#appliedSet();
    const stale: string[] = [];
    let scanned = 0;
    let lastKey: string | undefined;
    for (const [key, raw] of this.#kv.list<unknown>({
      prefix: this.#retainedPrefix,
      ...(options.cursor === undefined ? {} : { startAfter: options.cursor }),
      limit,
    })) {
      scanned++;
      lastKey = key;
      const id = this.#idFrom(key, this.#retainedPrefix);
      if (id === undefined) continue;
      if (applied.has(id)) {
        stale.push(key);
        continue;
      }
      const record = this.#coerce(raw);
      if (record?.state === "applied") entries.push({ id, action: record.action });
    }
    // After the walk, so the scan never deletes under the live list iterator.
    for (const key of stale) this.#kv.delete(key);
    return {
      entries,
      ...(scanned === limit && lastKey !== undefined ? { nextCursor: lastKey } : {}),
    };
  }

  /**
   * @deprecated Reads across every branch, which a session must not. Session code reads through
   * its handle's `pending()`; housekeeping calls `listPendingAcrossBranches()`.
   * @returns Actions visible to simulation in any view, ordered by ID.
   */
  listPending(): JournalEntry<A>[] {
    return this.listPendingAcrossBranches();
  }

  /**
   * @deprecated Reads across every branch, which a session must not. Session code reads through
   * its handle's `undecided()`; housekeeping calls `listUndecidedAcrossBranches()`.
   * @returns Actions still eligible for a decision in any view, ordered by ID.
   */
  listUndecided(): JournalEntry<A>[] {
    return this.listUndecidedAcrossBranches();
  }

  /**
   * Every branch's projected actions, for housekeeping that is about storage rather than what a
   * session sees, such as pruning stored files. Not for a session's reads: see `listPendingIn()`.
   * @returns Actions visible to simulation in any view, ordered by ID.
   */
  listPendingAcrossBranches(): JournalEntry<A>[] {
    return this.#scan(PROJECTED).map(entryOf);
  }

  /**
   * Every branch's actions still eligible for a decision. Not for a session's reads: see
   * `listUndecidedIn()`.
   * @returns Matching actions ordered by ID.
   */
  listUndecidedAcrossBranches(): JournalEntry<A>[] {
    return this.#scan(UNDECIDED).map(entryOf);
  }

  /**
   * The actions a session reading through `view` simulates, in the order it replays them: those
   * with no view, then staged ones, then its branch's and its ancestors', each group by ID.
   * @param view The session's view.
   * @returns Projected actions visible in `view`.
   */
  listPendingIn(view: BranchView): JournalEntry<A>[] {
    return this.#scanIn(view, PROJECTED);
  }

  /**
   * As `listPendingIn()`, for the actions still eligible for a decision.
   * @param view The session's view.
   * @returns Undecided actions visible in `view`, in its order.
   */
  listUndecidedIn(view: BranchView): JournalEntry<A>[] {
    return this.#scanIn(view, UNDECIDED);
  }

  /**
   * The projected actions action `id` was built on, in the order its view replays them: those
   * visible in the view it was submitted under that come before it there. For an apply-time guard
   * that needs "the changes queued before it", which runs outside any session.
   * @param id A pending action.
   * @returns The actions before it, or `[]` when it is not in the pending tier.
   */
  pendingBefore(id: number): JournalEntry<A>[] {
    const scanned = this.#scan(PROJECTED);
    const self = this.#placed(id);
    if (self === undefined) return [];
    const before = scanned.filter(entry => entry.id !== id && builtOn(self, entry));
    return (self.view === undefined ? before : before.toSorted(inViewOrder)).map(entryOf);
  }

  /**
   * The projected actions built on action `id`: those whose view sees it and puts it before them.
   * For a denial, which runs outside any session and must know whose simulation it changes.
   * @param id A pending action.
   * @returns The actions after it, ordered by ID, or `[]` when it is not in the pending tier.
   */
  pendingAfter(id: number): JournalEntry<A>[] {
    const self = this.#placed(id);
    if (self === undefined) return [];
    return this.#scan(PROJECTED)
      .filter(entry => entry.id !== id && builtOn(entry, self))
      .map(entryOf);
  }

  /**
   * Every record a decision is still owed for, with its state and the view it was submitted
   * under: pending, claimed and failed records, across every branch. For a denial's cascade, which
   * looks at failures as well as pending actions, and outside any session.
   * @returns Their IDs and records, ordered by ID.
   */
  listOutstanding(): { id: number; record: JournalRecord<A> }[] {
    const outstanding: { id: number; record: JournalRecord<A> }[] = [];
    for (const { id } of this.#scan(["pending", "claimed", "failed"])) {
      const record = this.#read(this.#pendingKey(id));
      if (record !== undefined) outstanding.push({ id, record });
    }
    return outstanding;
  }

  /**
   * Staged records that carry a view: submissions a session handle made whose `submitAction()`
   * reply this journal never saw. Each waits, unread, until the Workshop says whether it holds it
   * (see `ApprovalQueue.submitAction()`, rule 4). Records with no view are not listed: a later
   * callback naming one confirms it, as before views existed.
   * @returns Their IDs, in order.
   */
  listUnconfirmed(): number[] {
    return this.#scan(["staged"]).filter(entry => entry.view !== undefined).map(({ id }) => id);
  }

  /**
   * Where a pending-tier record stands in the views, for the order helpers.
   * @param id Action ID.
   * @returns Its ID and view, or `undefined` when absent or already applied.
   */
  #placed(id: number): Placed | undefined {
    if (this.wasApplied(id) || this.isRetained(id)) return undefined;
    const record = this.#read(this.#pendingKey(id));
    return record && { id, ...(record.view ? { view: record.view } : {}) };
  }

  /**
   * Scans the pending tier for selected states visible in a view.
   * @param view The reading view.
   * @param states States to include.
   * @returns Matching actions in the view's order.
   */
  #scanIn(view: BranchView, states: readonly JournalState[]): JournalEntry<A>[] {
    return this.#scan(states).filter(entry => visibleIn(view, entry)).toSorted(inViewOrder)
      .map(entryOf);
  }

  /**
   * Scans the pending tier for selected states.
   * @param states States to include.
   * @returns Matching actions, with the view each was submitted under, ordered by ID.
   */
  #scan(states: readonly JournalState[]): ScannedEntry<A>[] {
    const found: ScannedEntry<A>[] = [];
    const applied = this.#appliedSet();
    for (const [key, raw] of this.#kv.list<unknown>({ prefix: this.#prefix })) {
      const record = this.#coerce(raw);
      if (record === undefined || !states.includes(record.state)) continue;
      const id = this.#idFrom(key);
      // A record left behind by an interrupted `retain` or `retire` is applied, not pending:
      // projecting it would simulate an effect the provider has already made real.
      if (id === undefined || applied.has(id) || this.isRetained(id)) continue;
      found.push({ id, action: record.action, ...(record.view ? { view: record.view } : {}) });
    }
    return found.toSorted((a, b) => a.id - b.id);
  }

  /**
   * Enforces capacity and prunes excess staged or failed records.
   * @param view The view of the action about to be staged. With one, only unresolved actions on
   * the same branch (or staged, for a staged action) count against the cap; without one, every
   * unresolved action does, as before views existed.
   */
  #requireCapacity(view?: BranchView): void {
    let unresolved = 0;
    const staged: number[] = [];
    const failed: number[] = [];
    const applied = this.#appliedSet();
    for (const [key, raw] of this.#kv.list<unknown>({ prefix: this.#prefix })) {
      // A key this journal cannot name an id for is not its record: counting one would hold a slot
      // no approval can clear, and pruning one would delete a stranger's key.
      const id = this.#idFrom(key);
      if (id === undefined) continue;
      const record = this.#coerce(raw);
      // An interrupted `retain` or `retire` leaves a stale source record here, whatever its state;
      // the retained tier and the retired-id memory decide, as they do for `get` and `listPending`.
      if (record === undefined || applied.has(id) || this.isRetained(id)) continue;
      if (record.state === "staged") {
        // A staged record with a view is an unconfirmed submission, owed the Workshop's answer
        // before it may go (see `listUnconfirmed`); it holds no slot meanwhile.
        if (record.view === undefined) staged.push(id);
        continue;
      }
      // An undispatched failure holds a slot rather than joining the prunable set: only a
      // rejection can release what its staging set up, so discarding the record would strand
      // those artifacts for good. An unknown outcome holds one for the opposite reason -- it is
      // the only record saying the provider may already have changed, and pruning it would evict
      // that warning first. Blocking is recoverable -- the user rejects it.
      if (record.state === "failed" && !record.undispatched && record.outcome !== "unknown") {
        failed.push(id);
      } else if (view === undefined || record.view?.branch === view.branch) {
        // Per branch for a session's submission, so one chat's actions cannot fill another's
        // allowance; leftovers with no view count against no branch.
        unresolved += 1;
      }
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
   * @param prefix Prefix preceding the id.
   * @returns The action ID, or `undefined` for an unrelated key.
   */
  #idFrom(key: string, prefix = this.#prefix): number | undefined {
    const suffix = key.slice(prefix.length);
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
    if (record) {
      this.#write(this.#pendingKey(id), { state: next, action: record.action, ...carried(record) });
    }
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
      const { state, action, error, fence, view, undispatched, outcome } =
        raw as StoredJournalRecord<A>;
      const kept = {
        ...(fence ? { fence: { generation: fence.generation } } : {}),
        ...(isView(view) ? { view: copyView(view) } : {}),
      };
      return state === "failed"
        ? {
          state, action, error: error ?? FAILURE_REASON_LOST, ...kept,
          ...(undispatched ? { undispatched: true } as const : {}),
          // A record written before this field existed reads as the default, `"not-applied"`.
          ...(outcome === "unknown" ? { outcome: "unknown" } as const : {}),
        }
        : { state, action, ...kept };
    }
    // Anything else was written by whatever this gatekeeper stored before adopting the journal,
    // and since it only kept records awaiting approval, it was pending. An upgraded record carries
    // no fence: nothing staged it under a generation this journal recorded.
    const upgraded = this.#upgradeRecord?.(raw);
    return upgraded === undefined ? undefined : { state: "pending", action: upgraded };
  }
}

type ScannedEntry<A> = JournalEntry<A> & { readonly view?: BranchView };

/** Drops what a scan carries beyond an entry, which callers outside the journal never see. */
const entryOf = <A>({ id, action }: ScannedEntry<A>): JournalEntry<A> => ({ id, action });

/**
 * What a transition carries over from the record it rewrites.
 * @param record The record before the transition.
 * @returns Its fence and view, each only when present.
 */
function carried<A>(record: JournalRecord<A>): { fence?: ActionFence; view?: BranchView } {
  return {
    ...(record.fence ? { fence: record.fence } : {}),
    ...(record.view ? { view: record.view } : {}),
  };
}

/** Whether a stored value is a view a session handle wrote, rather than damage or nothing. */
function isView(value: unknown): value is BranchView {
  if (typeof value !== "object" || value === null || !("branch" in value)) return false;
  const { branch, ancestors } = value as { branch: unknown; ancestors?: unknown };
  return (branch === null || typeof branch === "string")
    && (ancestors === undefined || (Array.isArray(ancestors) && ancestors.every(ancestor =>
      typeof ancestor?.branch === "string" && Number.isSafeInteger(ancestor?.through))));
}
