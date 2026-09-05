/** Durable collaborator admission and per-set observer exclusion. */

import { createLogger } from "@gadgets/backend-utils/logger";
import { generateNonce } from "./connect-nonce";
import type { KvScannable } from "./kv";
import { perStorage } from "./per-storage";
import { requirePositiveInt } from "./positive-int";

const logger = createLogger<{ vendorId: string; observerId: string }>({
  component: "gatekeeper.observers",
});

/**
 * Casts an overseer verifier to a vendor-specific API. The overseer returns a verifier only to the
 * vendor that minted it.
 * @param user Overseer verifier capability.
 * @returns The same capability with its vendor-specific type.
 */
export function asVerifier<T>(user: unknown): T {
  return user as T;
}

/** Error text returned when a collaborator fails observer admission. */
export const OBSERVER_DENIED =
  "This collaborator does not have access to data this workspace has read, so they cannot be allowed " +
  "to observe it.";

/** Error text returned once a withheld read has made this binding unshareable. */
export const OBSERVER_WITHHELD =
  "This workspace has read data that cannot be shared, so it can no longer be observed by anyone " +
  "but its owner.";

/** The Durable Object KV surface used by observer tracking. */
export type ObserverKv = KvScannable;

type SetState = "pending" | "observed";

/**
 * Prepared observation state. Exactly one of `commit`, `discard`, or `abandon` runs, synchronously:
 * `discard` only after a marked refusal proves nothing was recorded, `abandon` when the outcome is
 * unknown.
 */
export type ObservationCheck = {
  excludeObservers?: string[];
  /** Commits prepared observation state. */
  commit(): void;
  /** Reclaims prepared state after a refusal that recorded nothing. */
  discard?(): void;
  /** Releases in-memory bookkeeping when the outcome is unknown; durable fences stay. */
  abandon?(): void;
};

/** Internal: the check for a read that reveals no tracked set. */
export const NOTHING_TO_RESOLVE: ObservationCheck = {
  /** Commits the empty observation check. */
  commit() {},
};

const OBSERVER_PREFIX = "observer:";

// Admission attempts are durable so concurrent reads already exclude the candidate.
const OBSERVER_ATTEMPT_PREFIX = "observer-attempt:";
const OBSERVER_NONCE_PREFIX = "observer-nonce:";

type ObserverAttempt<V> = { verifier: V; at: number };

/** Maximum age of a pending observer-admission attempt. */
export const OBSERVER_ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

const OBSERVER_WITHHELD_KEY = "observer-withheld";

// Durable markers fence withheld reads until the overseer accepts or rejects them.
// A marker stranded by a crash fails closed.
const OBSERVER_WITHHOLD_PREFIX = "observer-withhold:";

const RESERVED_PREFIXES = [
  OBSERVER_PREFIX, OBSERVER_ATTEMPT_PREFIX, OBSERVER_NONCE_PREFIX, OBSERVER_WITHHOLD_PREFIX,
  OBSERVER_WITHHELD_KEY,
];

const DEFAULT_MAX_TRACKED_SETS = 1000;

// Keep verifier fan-out below the Workers subrequest ceiling.
const DEFAULT_MAX_OBSERVERS = 10;

const DEFAULT_CONCURRENCY = 6;

// What the reads disclosing one set marker still owe it. A marker may be reclaimed only once every
// claimant settled and all of them settled as proven refusals -- one unknown outcome fences it for
// good, since a lost reply may have followed a durable record. A DO runs in one isolate, so
// in-memory tracking is sound; `perStorage` shares it across trackers over the same storage.
type SetClaim = { held: number; created: boolean; refusedOnly: boolean };

const setClaims = perStorage(() => new Map<string, SetClaim>());

/** How a prepared observation settled, per the overseer's answer. */
type Outcome = "committed" | "refused" | "unknown";

/**
 * Claims the set markers one read discloses.
 * @param claims Per-storage claim records.
 * @param keys Set storage keys the read discloses.
 * @param created Keys whose markers this read wrote.
 */
function claimSets(claims: Map<string, SetClaim>, keys: readonly string[], created: Set<string>) {
  for (const key of keys) {
    const claim = claims.get(key) ?? { held: 0, created: false, refusedOnly: true };
    claim.held += 1;
    claim.created ||= created.has(key);
    claims.set(key, claim);
  }
}

/**
 * Settles one read's claims.
 * @param claims Per-storage claim records.
 * @param keys Set storage keys the read claimed.
 * @param outcome How the read settled.
 * @returns The keys whose markers every claimant has now refused, and nothing else accounts for.
 */
function settleSets(
  claims: Map<string, SetClaim>,
  keys: readonly string[],
  outcome: Outcome,
): string[] {
  const reclaimable: string[] = [];
  for (const key of keys) {
    const claim = claims.get(key);
    if (claim === undefined) continue;
    if (outcome !== "refused") claim.refusedOnly = false;
    if ((claim.held -= 1) > 0) continue;
    claims.delete(key);
    if (claim.created && claim.refusedOnly) reclaimable.push(key);
  }
  return reclaimable;
}

// Map with bounded concurrency while preserving result order.
async function mapLimit<In, Out>(
  items: readonly In[],
  limit: number,
  fn: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Configuration for an observer tracker and its provider-owned ACL oracle. An error thrown by the
 * oracle may be shown to the denied collaborator: keep messages display-safe and free of resource
 * identifiers.
 */
export type ObserverTrackerOptions<V> = {
  /** The binding's `ctx.storage.kv`. */
  kv: ObserverKv;
  /** Key prefix for observed-set records; observers always live under `"observer:"`. */
  setPrefix?: string;
  /**
   * Canonicalizes a provider set ID so equivalent spellings share one stored ACL record.
   * @param setId Provider set ID.
   * @returns Canonical set ID for storage and ACL checks.
   */
  canonicalSetId?(setId: string): string;
  /**
   * Checks admission-level access before set ACLs, at admission only: losing Workshop membership
   * is the revocation path. A provider needing per-read baseline freshness folds that check into
   * `hasSetAccess`.
   * @param verifier Vendor-specific verifier capability.
   */
  verifyBaseline?(verifier: V): Promise<void>;
  /**
   * Checks access to canonical provider sets.
   * @param verifier Vendor-specific verifier capability.
   * @param setIds Canonical set IDs.
   * @returns Exactly one verdict per set ID; only literal `true` grants access.
   */
  hasSetAccess(verifier: V, setIds: readonly string[]): Promise<boolean[]>;
  /**
   * Builds a generic denial message.
   * @param setId Inaccessible canonical set ID.
   * @returns A message that does not disclose the set ID.
   */
  denyMessage?(setId: string): string;
  /**
   * Caps distinct sets before disclosure, so existing observers never become unverifiable. Size it
   * from the provider's read fan-out: a refused read reclaims its slots, but a marker stranded by
   * a crash is kept permanently, since a lost reply may still have recorded the observation.
   */
  maxTrackedSets?: number;
  /** Caps fan-out before reads can exceed Worker invocation limits. */
  maxObservers?: number;
  /** Concurrent verifier round trips. */
  concurrency?: number;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

// Brands set IDs after canonicalization so internal helpers cannot accept raw IDs.
type CanonicalSetId = string & { readonly __canonical: true };

/**
 * Tracks observer admission and forward exclusion across revealed data sets. Persisting verifier
 * capabilities requires `allow_irrevocable_stub_storage` and a durable service stub.
 *
 * @example
 * ```ts
 * #observers = new ObserverTracker<VendorVerifier>({
 *   kv: this.ctx.storage.kv,
 *   setPrefix: "observedProject:",
 *   hasSetAccess: (verifier, projectIds) => verifier.hasProjects(projectIds),
 * });
 * ```
 */
export class ObserverTracker<V> {
  readonly #options: ObserverTrackerOptions<V>;
  readonly #setPrefix: string;
  readonly #canonicalSetId: (setId: string) => CanonicalSetId;
  readonly #maxTrackedSets: number;
  readonly #maxObservers: number;
  readonly #concurrency: number;
  readonly #logger: typeof logger;

  /**
   * Creates an observer tracker.
   * @param options Storage, ACL oracle, and capacity settings.
   */
  constructor(options: ObserverTrackerOptions<V>) {
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
    this.#setPrefix = options.setPrefix ?? "observed:";
    // The brand is asserted here and nowhere else on this path: whatever the caller's function
    // returns *is* the canonical spelling, by definition of the option.
    this.#canonicalSetId =
      (options.canonicalSetId ?? (setId => setId)) as (setId: string) => CanonicalSetId;
    // A cap of zero refuses every read, and a window of zero never advances.
    this.#maxTrackedSets = requirePositiveInt(
      "maxTrackedSets", options.maxTrackedSets ?? DEFAULT_MAX_TRACKED_SETS);
    this.#maxObservers = requirePositiveInt(
      "maxObservers", options.maxObservers ?? DEFAULT_MAX_OBSERVERS);
    this.#concurrency = requirePositiveInt(
      "concurrency", options.concurrency ?? DEFAULT_CONCURRENCY);

    // Overlapping families scan into each other: set ids would come back as verifier keys, and
    // stored verifiers would be handed to `hasSetAccess` as set ids. An empty prefix overlaps by
    // scanning everything, and the same check rejects it.
    for (const reserved of RESERVED_PREFIXES) {
      if (this.#setPrefix.startsWith(reserved) || reserved.startsWith(this.#setPrefix)) {
        throw new Error(
          `Set prefix "${this.#setPrefix}" overlaps the reserved prefix "${reserved}".`);
      }
    }
  }

  /**
   * Verifies and stores an observer.
   * @param id Observer ID.
   * @param verifier Vendor-specific verifier capability.
   * @returns A promise that resolves after admission is durable.
   */
  async addObserver(id: string, verifier: V): Promise<void> {
    const { kv, verifyBaseline, hasSetAccess, denyMessage } = this.#options;
    // A withheld read registers no set, so nothing here can establish this candidate was entitled
    // to it. One still in flight counts: this candidate is absent from the exclusion list it sent.
    if (kv.get<boolean>(OBSERVER_WITHHELD_KEY) || this.#withholdInFlight()) {
      throw new Error(OBSERVER_WITHHELD);
    }
    this.#sweepStaleAttempts();

    // Re-admission of one already here is free; a new one costs a verifier call on every read.
    const existing = this.observerIds();
    if (!existing.includes(id) && existing.length >= this.#maxObservers) {
      throw new Error(
        `This binding already answers for ${existing.length} collaborators, the most it can ` +
        "verify on every read. Remove one before adding another.");
    }
    const attemptKey = `${OBSERVER_ATTEMPT_PREFIX}${id}`;
    const nonceKey = `${OBSERVER_NONCE_PREFIX}${id}`;
    const nonce = generateNonce();
    // Both writes before the first await, so no read can observe the attempt without its nonce.
    kv.put<ObserverAttempt<V>>(attemptKey, { verifier, at: Date.now() });
    kv.put(nonceKey, nonce);

    try {
      if (verifyBaseline) await verifyBaseline(verifier);

      const checked = new Set<string>();
      for (;;) {
        const setIds = this.#trackedSets().filter(setId => !checked.has(setId));
        if (setIds.length === 0) {
          this.#requireCurrentAttempt(id, nonceKey, nonce);
          // Promotion and retirement in one awaitless run: the id is never both, and never neither.
          kv.put(`${OBSERVER_PREFIX}${id}`, verifier);
          kv.delete(attemptKey);
          kv.delete(nonceKey);
          return;
        }
        // Copied per call: the oracle may chunk destructively, and the length check below plus the
        // `checked` bookkeeping read this array afterwards.
        const access = await hasSetAccess(verifier, setIds.slice());
        this.#requireCurrentAttempt(id, nonceKey, nonce);
        // A ragged answer denies rather than admits, in either direction. Short already denied
        // (`undefined !== true`); an answer *longer* than the question used to admit, which is the
        // worse half -- index alignment is the only thing tying a verdict to a set, so a length the
        // oracle disagrees about invalidates every verdict in the array rather than just the extras.
        if (access.length !== setIds.length) throw new Error(OBSERVER_DENIED);
        const denied = setIds.findIndex((_, index) => access[index] !== true);
        if (denied >= 0) throw new Error(denyMessage?.(setIds[denied]!) ?? OBSERVER_DENIED);
        for (const setId of setIds) checked.add(setId);
      }
    } catch (error) {
      // Only this attempt's records: whatever rotated the nonce owns them now.
      if (kv.get<string>(nonceKey) === nonce) {
        kv.delete(attemptKey);
        kv.delete(nonceKey);
      }
      throw error;
    }
  }

  /** @returns A fenced owner-only observation check. */
  prepareWithheld(): ObservationCheck {
    const { kv } = this.#options;
    // Enumerated before the marker goes down: a throw here must strand nothing.
    const excludeObservers = this.observerIds();
    const markerKey = `${OBSERVER_WITHHOLD_PREFIX}${generateNonce()}`;
    kv.put(markerKey, true);
    return {
      excludeObservers,
      // Latch before the marker goes: no state where neither fences. A failed latch write leaves
      // the marker -- the overseer may already hold the record, so the fence must outlive the read.
      commit: () => {
        kv.put(OBSERVER_WITHHELD_KEY, true);
        kv.delete(markerKey);
      },
      // Refusal-only: the overseer proved it recorded nothing, so the fence can go. An unknown
      // outcome leaves the marker, which keeps `addObserver` closed (no `abandon`).
      discard: () => kv.delete(markerKey),
    };
  }

  /** @returns Whether any owner-only read remains unsettled. */
  #withholdInFlight(): boolean {
    for (const _ of this.#options.kv.list({ prefix: OBSERVER_WITHHOLD_PREFIX })) return true;
    return false;
  }

  /**
   * Removes an observer and cancels its in-flight admission.
   * @param id Observer ID to remove.
   */
  removeObserver(id: string): void {
    const { kv } = this.#options;
    // The nonce deletion is the cancellation, and it reaches an admission parked anywhere.
    kv.delete(`${OBSERVER_NONCE_PREFIX}${id}`);
    kv.delete(`${OBSERVER_ATTEMPT_PREFIX}${id}`);
    kv.delete(`${OBSERVER_PREFIX}${id}`);
  }

  /** Removes observer-admission attempts that exceeded their lifetime. */
  #sweepStaleAttempts(): void {
    const { kv } = this.#options;
    const now = Date.now();
    for (const [key, { at }] of kv.list<ObserverAttempt<V>>({ prefix: OBSERVER_ATTEMPT_PREFIX })) {
      // A corrupt `at` fails this comparison and is swept -- the safe direction.
      if (now - at < OBSERVER_ATTEMPT_LIFETIME_MS) continue;
      // Nonce first, as `removeObserver` does: with it gone the stale admission fails closed even
      // if the attempt delete throws, and the surviving attempt waits for the next sweep. Deleting
      // the attempt first would free its slot while the admission could still complete.
      kv.delete(`${OBSERVER_NONCE_PREFIX}${key.slice(OBSERVER_ATTEMPT_PREFIX.length)}`);
      kv.delete(key);
    }
  }

  /**
   * Verifies that an admission attempt still owns its nonce.
   * @param id Observer ID.
   * @param nonceKey Storage key for the attempt nonce.
   * @param nonce Expected nonce.
   */
  #requireCurrentAttempt(id: string, nonceKey: string, nonce: string): void {
    if (this.#options.kv.get<string>(nonceKey) !== nonce) {
      throw new Error(`Observer ${id} was removed while being admitted.`);
    }
  }

  /** @returns Admitted observers and candidates still being verified. */
  observerIds(): string[] {
    return [...this.#observers()].map(([id]) => id);
  }

  /**
   * Prepares a set-scoped observation.
   * @param setIds Provider set IDs disclosed by the read.
   * @returns A check naming observers that lack access.
   */
  async prepareObservation(setIds: readonly string[]): Promise<ObservationCheck> {
    const { kv, hasSetAccess } = this.#options;
    // Canonicalized up front, so the keys written, the state compared, and the ids the oracle is
    // asked about are all the same spelling.
    const canonical = [...new Set(setIds.map(setId => this.#canonicalSetId(setId)))];
    // Both partitions come from one state read per set, before the first await, so the "pending"
    // writes below reflect storage as a concurrent addObserver will scan it.
    const states = canonical.map(setId => [setId, this.#state(setId)] as const);
    const promote = states
      .filter(([, state]) => state !== "observed")
      .map(([setId]) => setId);
    const untracked = states.filter(([, state]) => state === undefined).map(([setId]) => setId);
    if (untracked.length > 0) {
      const tracked = this.#trackedSets().length;
      if (tracked + untracked.length > this.#maxTrackedSets) {
        throw new Error(
          `This binding has read ${tracked} distinct items, the most it can track while remaining ` +
          "shareable. Bind a narrower scope.");
      }
      for (const setId of untracked) kv.put<SetState>(this.#setKey(setId), "pending");
    }
    // Claimed after the capacity throw and before the first await, like the markers themselves, so
    // no concurrent read can reclaim a marker this one still depends on.
    const claims = setClaims(kv);
    const claimed = canonical.map(setId => this.#setKey(setId));
    claimSets(claims, claimed, new Set(untracked.map(setId => this.#setKey(setId))));

    const observers = [...this.#observers()];
    const access = await mapLimit(observers, this.#concurrency, async ([id, verifier]) => {
      try {
        // Copied per verifier: the oracle may chunk destructively, and the exclusion check below
        // compares against this array. Shared, an emptied batch would make that check vacuous and
        // admit every later observer to sets no oracle ever verified.
        return await hasSetAccess(verifier, canonical.slice());
      } catch {
        // A throw excludes, like a denial: rejecting the batch would let one dead stub fail every
        // observation this binding makes. The caught value is deliberately not logged -- provider
        // API errors carry response text in their message.
        this.#logger.warn("observer access check failed", {
          event: "observers.access.check.failed",
          observerId: id,
        });
        return undefined;
      }
    });
    const excluded = observers
      .filter((_, observer) => {
        // Same rule as admission, and for the same reason: a verdict array whose length the oracle
        // disagrees about excludes that observer rather than being read positionally. Excluding
        // rather than throwing keeps one broken verifier from failing the whole read.
        const verdicts = access[observer];
        return verdicts === undefined
          || verdicts.length !== canonical.length
          || canonical.some((_setId, index) => verdicts[index] !== true);
      })
      .map(([id]) => id);

    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      commit: () => {
        settleSets(claims, claimed, "committed");
        for (const setId of promote) kv.put<SetState>(this.#setKey(setId), "observed");
      },
      abandon: () => void settleSets(claims, claimed, "unknown"),
      discard: () => {
        // Reclaimed by whichever claimant settles last, so a set two refused reads disclosed does
        // not keep a slot -- and a marker anything promoted or left unaccounted for stays.
        for (const key of settleSets(claims, claimed, "refused")) {
          if (kv.get<SetState | true>(key) === "pending") kv.delete(key);
        }
      },
    };
  }

  /**
   * Builds an observed-set storage key.
   * @param setId Canonical set ID.
   * @returns Storage key for the set.
   */
  #setKey(setId: CanonicalSetId): string {
    return `${this.#setPrefix}${setId}`;
  }

  /**
   * Reads an observed set's state.
   * @param setId Canonical set ID.
   * @returns Current state, including normalized legacy values.
   */
  #state(setId: CanonicalSetId): SetState | undefined {
    // `true` is the legacy encoding of "observed" some gatekeepers already have in storage. The kit
    // never writes it, and normalizing it here keeps the two spellings out of every other line.
    const stored = this.#options.kv.get<SetState | true>(this.#setKey(setId));
    return stored === true ? "observed" : stored;
  }

  /** @returns Every canonical set ID retained by this tracker. */
  #trackedSets(): CanonicalSetId[] {
    return [...this.#options.kv.list<unknown>({ prefix: this.#setPrefix })].map(([key]) =>
      key.slice(this.#setPrefix.length) as CanonicalSetId,
    );
  }

  /** @returns Admitted observers followed by unique in-flight candidates. */
  *#observers(): IterableIterator<[string, V]> {
    const { kv } = this.#options;
    const seen = new Set<string>();
    for (const [key, verifier] of kv.list<V>({ prefix: OBSERVER_PREFIX })) {
      const id = key.slice(OBSERVER_PREFIX.length);
      seen.add(id);
      yield [id, verifier];
    }
    for (const [key, { verifier }] of kv.list<ObserverAttempt<V>>({
      prefix: OBSERVER_ATTEMPT_PREFIX,
    })) {
      const id = key.slice(OBSERVER_ATTEMPT_PREFIX.length);
      if (!seen.has(id)) yield [id, verifier];
    }
  }
}
