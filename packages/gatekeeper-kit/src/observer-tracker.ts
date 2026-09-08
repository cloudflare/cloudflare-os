/** Durable collaborator admission and per-collection observer exclusion. */

import { createLogger } from "@gadgets/backend-utils/logger";
import { generateNonce } from "./connect-nonce";
import type { KvScannable } from "./kv";
import { perStorage } from "./per-storage";
import { requirePositiveInt } from "./positive-int";
import {
  OBSERVER_ATTEMPT_PREFIX,
  OBSERVER_NONCE_PREFIX,
  OBSERVER_PREFIX,
  OBSERVER_WITHHOLD_LATCH_KEY,
  OBSERVER_WITHHOLD_FENCE_PREFIX,
  reservedObserverOverlap,
} from "./observer-keys";

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

type CollectionState = "pending" | "observed";

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

/** Internal: the check for a read that reveals no tracked collection. */
export const NOTHING_TO_RESOLVE: ObservationCheck = {
  /** Commits the empty observation check. */
  commit() {},
};

type ObserverAttempt<V> = { verifier: V; at: number };

/** Maximum age of a pending observer-admission attempt. */
export const OBSERVER_ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

const DEFAULT_MAX_TRACKED_COLLECTIONS = 1000;

// Keep verifier fan-out below the Workers subrequest ceiling.
const DEFAULT_MAX_OBSERVERS = 10;

const DEFAULT_CONCURRENCY = 6;

// What the reads disclosing one collection marker still owe it. A marker may be reclaimed only once every
// claimant settled and all of them settled as proven refusals -- one unknown outcome fences it for
// good, since a lost reply may have followed a durable record. A DO runs in one isolate, so
// in-memory tracking is sound; `perStorage` shares it across trackers over the same storage.
type CollectionClaim = { held: number; created: boolean; refusedOnly: boolean };

const collectionClaims = perStorage(() => new Map<string, CollectionClaim>());

// Withhold markers this activation still owns. A durable marker missing here belongs to an
// operation whose outcome can no longer be learned -- a lost reply, or a restart that emptied this
// set -- so it is promoted to the permanent latch rather than left to accumulate.
const activeWithholds = perStorage(() => new Set<string>());

/** How a prepared observation settled, per the overseer's answer. */
type Outcome = "committed" | "refused" | "unknown";

/**
 * Claims the collection markers one read discloses.
 * @param claims Per-storage claim records.
 * @param keys Set storage keys the read discloses.
 * @param created Keys whose markers this read wrote.
 */
function claimSets(claims: Map<string, CollectionClaim>, keys: readonly string[], created: Set<string>) {
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
  claims: Map<string, CollectionClaim>,
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
  /**
   * The binding's `ctx.storage.kv`, passed as the same object every time. Pending-marker claims
   * are coordinated in memory keyed on this object, so trackers handed distinct wrappers over one
   * storage cannot see each other's in-flight reads: one refused read could then reclaim a marker
   * another still depends on, and the next `addObserver` would admit against a collection it never
   * checked.
   */
  kv: ObserverKv;
  /** Key prefix for observed-collection records; observers always live under `"observer:"`. */
  collectionPrefix?: string;
  /**
   * Canonicalizes a provider collection ID so equivalent spellings share one stored ACL record.
   * @param collectionId Provider collection ID.
   * @returns Canonical collection ID for storage and ACL checks.
   */
  canonicalCollectionId?(collectionId: string): string;
  /**
   * Checks admission-level access before collection ACLs, at admission only: losing Workshop membership
   * is the revocation path. A provider needing per-read baseline freshness folds that check into
   * `hasCollectionAccess`.
   * @param verifier Vendor-specific verifier capability.
   */
  verifyBaseline?(verifier: V): Promise<void>;
  /**
   * Checks access to canonical provider collections.
   * @param verifier Vendor-specific verifier capability.
   * @param collectionIds Canonical collection IDs.
   * @returns Exactly one verdict per collection ID; only literal `true` grants access.
   */
  hasCollectionAccess(verifier: V, collectionIds: readonly string[]): Promise<boolean[]>;
  /**
   * Builds a generic denial message.
   * @param collectionId Inaccessible canonical collection ID.
   * @returns A message that does not disclose the collection ID.
   */
  denyMessage?(collectionId: string): string;
  /**
   * Caps distinct collections before disclosure, so existing observers never become unverifiable. Size it
   * from the provider's read fan-out: a refused read reclaims its slots, but a marker stranded by
   * a crash is kept permanently, since a lost reply may still have recorded the observation.
   */
  maxTrackedCollections?: number;
  /** Caps fan-out before reads can exceed Worker invocation limits. */
  maxObservers?: number;
  /** Concurrent verifier round trips. */
  concurrency?: number;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

// Brands collection IDs after canonicalization so internal helpers cannot accept raw IDs.
type CanonicalCollectionId = string & { readonly __canonical: true };

/**
 * Tracks observer admission and forward exclusion across revealed collections. Persisting verifier
 * capabilities requires `allow_irrevocable_stub_storage` and a durable service stub.
 *
 * @example
 * ```ts
 * #observers = new ObserverTracker<VendorVerifier>({
 *   kv: this.ctx.storage.kv,
 *   collectionPrefix: "observedProject:",
 *   hasCollectionAccess: (verifier, projectIds) => verifier.hasProjects(projectIds),
 * });
 * ```
 */
export class ObserverTracker<V> {
  readonly #options: ObserverTrackerOptions<V>;
  readonly #collectionPrefix: string;
  readonly #canonicalCollectionId: (collectionId: string) => CanonicalCollectionId;
  readonly #maxTrackedCollections: number;
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
    this.#collectionPrefix = options.collectionPrefix ?? "observed:";
    // The brand is asserted here and nowhere else on this path: whatever the caller's function
    // returns *is* the canonical spelling, by definition of the option.
    this.#canonicalCollectionId =
      (options.canonicalCollectionId ?? (collectionId => collectionId)) as (collectionId: string) => CanonicalCollectionId;
    // A cap of zero refuses every read, and a window of zero never advances.
    this.#maxTrackedCollections = requirePositiveInt(
      "maxTrackedCollections", options.maxTrackedCollections ?? DEFAULT_MAX_TRACKED_COLLECTIONS);
    this.#maxObservers = requirePositiveInt(
      "maxObservers", options.maxObservers ?? DEFAULT_MAX_OBSERVERS);
    this.#concurrency = requirePositiveInt(
      "concurrency", options.concurrency ?? DEFAULT_CONCURRENCY);

    // Overlapping families scan into each other: collection ids would come back as verifier keys,
    // and stored verifiers would be handed to `hasCollectionAccess` as collection ids. An empty
    // prefix overlaps by scanning everything, and the same check rejects it.
    const overlap = reservedObserverOverlap(this.#collectionPrefix);
    if (overlap !== undefined) {
      throw new Error(
        `Collection prefix "${this.#collectionPrefix}" overlaps the reserved prefix "${overlap}".`);
    }
  }

  /**
   * Verifies and stores an observer.
   * @param id Observer ID.
   * @param verifier Vendor-specific verifier capability.
   * @returns A promise that resolves after admission is durable.
   */
  async addObserver(id: string, verifier: V): Promise<void> {
    const { kv, verifyBaseline, hasCollectionAccess, denyMessage } = this.#options;
    this.#compactWithholds();
    // A withheld read registers no collection, so nothing here can establish this candidate was entitled
    // to it. One still in flight counts: this candidate is absent from the exclusion list it sent.
    if (kv.get<boolean>(OBSERVER_WITHHOLD_LATCH_KEY) || this.#withholdInFlight()) {
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
        const collectionIds = this.#trackedCollections().filter(collectionId => !checked.has(collectionId));
        if (collectionIds.length === 0) {
          this.#requireCurrentAttempt(id, nonceKey, nonce);
          // Promotion and retirement in one awaitless run: the id is never both, and never neither.
          kv.put(`${OBSERVER_PREFIX}${id}`, verifier);
          kv.delete(attemptKey);
          kv.delete(nonceKey);
          return;
        }
        // Copied per call: the oracle may chunk destructively, and the length check below plus the
        // `checked` bookkeeping read this array afterwards.
        const access = await hasCollectionAccess(verifier, collectionIds.slice());
        this.#requireCurrentAttempt(id, nonceKey, nonce);
        // A ragged answer denies rather than admits, in either direction. Short already denied
        // (`undefined !== true`); an answer *longer* than the question used to admit, which is the
        // worse half -- index alignment is the only thing tying a verdict to a collection, so a length the
        // oracle disagrees about invalidates every verdict in the array rather than just the extras.
        if (access.length !== collectionIds.length) throw new Error(OBSERVER_DENIED);
        const denied = collectionIds.findIndex((_, index) => access[index] !== true);
        if (denied >= 0) throw new Error(denyMessage?.(collectionIds[denied]!) ?? OBSERVER_DENIED);
        for (const collectionId of collectionIds) checked.add(collectionId);
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
    const markerKey = `${OBSERVER_WITHHOLD_FENCE_PREFIX}${generateNonce()}`;
    kv.put(markerKey, true);
    activeWithholds(kv).add(markerKey);
    // Commit and an unknown outcome reach the same durable state: the overseer may hold the
    // record, so sharing is fenced for good. Latch before delete, so no instant fences neither.
    const fenceForGood = () => {
      kv.put(OBSERVER_WITHHOLD_LATCH_KEY, true);
      kv.delete(markerKey);
      activeWithholds(kv).delete(markerKey);
    };
    return {
      excludeObservers,
      commit: fenceForGood,
      abandon: fenceForGood,
      // A marked refusal proves the overseer recorded nothing, so the fence can go.
      discard: () => {
        kv.delete(markerKey);
        activeWithholds(kv).delete(markerKey);
      },
    };
  }

  /** Latches markers stranded by an activation that died before settling one. */
  #compactWithholds(): void {
    const { kv } = this.#options;
    const active = activeWithholds(kv);
    for (const [key] of kv.list({ prefix: OBSERVER_WITHHOLD_FENCE_PREFIX })) {
      if (active.has(key)) continue;
      // Latch before delete, as `commit` does: no instant where neither fences.
      kv.put(OBSERVER_WITHHOLD_LATCH_KEY, true);
      kv.delete(key);
    }
  }

  /** @returns Whether any owner-only read remains unsettled. */
  #withholdInFlight(): boolean {
    for (const _ of this.#options.kv.list({ prefix: OBSERVER_WITHHOLD_FENCE_PREFIX })) return true;
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
   * Prepares a collection-scoped observation.
   * @param collectionIds Provider collection IDs disclosed by the read.
   * @returns A check naming observers that lack access.
   */
  async prepareObservation(collectionIds: readonly string[]): Promise<ObservationCheck> {
    const { kv, hasCollectionAccess } = this.#options;
    // Canonicalized up front, so the keys written, the state compared, and the ids the oracle is
    // asked about are all the same spelling.
    const canonical = [...new Set(collectionIds.map(collectionId => this.#canonicalCollectionId(collectionId)))];
    // Both partitions come from one state read per collection, before the first await, so the "pending"
    // writes below reflect storage as a concurrent addObserver will scan it.
    const states = canonical.map(collectionId => [collectionId, this.#state(collectionId)] as const);
    const promote = states
      .filter(([, state]) => state !== "observed")
      .map(([collectionId]) => collectionId);
    const untracked = states.filter(([, state]) => state === undefined).map(([collectionId]) => collectionId);
    if (untracked.length > 0) {
      const tracked = this.#trackedCollections().length;
      if (tracked + untracked.length > this.#maxTrackedCollections) {
        throw new Error(
          `This binding has read ${tracked} distinct items, the most it can track while remaining ` +
          "shareable. Bind a narrower scope.");
      }
      for (const collectionId of untracked) kv.put<CollectionState>(this.#collectionKey(collectionId), "pending");
    }
    // Claimed after the capacity throw and before the first await, like the markers themselves, so
    // no concurrent read can reclaim a marker this one still depends on.
    const claims = collectionClaims(kv);
    const claimed = canonical.map(collectionId => this.#collectionKey(collectionId));
    claimSets(claims, claimed, new Set(untracked.map(collectionId => this.#collectionKey(collectionId))));

    const observers = [...this.#observers()];
    const access = await mapLimit(observers, this.#concurrency, async ([id, verifier]) => {
      try {
        // Copied per verifier: the oracle may chunk destructively, and the exclusion check below
        // compares against this array. Shared, an emptied batch would make that check vacuous and
        // admit every later observer to collections no oracle ever verified.
        return await hasCollectionAccess(verifier, canonical.slice());
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
          || canonical.some((_collectionId, index) => verdicts[index] !== true);
      })
      .map(([id]) => id);

    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      commit: () => {
        settleSets(claims, claimed, "committed");
        for (const collectionId of promote) kv.put<CollectionState>(this.#collectionKey(collectionId), "observed");
      },
      abandon: () => void settleSets(claims, claimed, "unknown"),
      discard: () => {
        // Reclaimed by whichever claimant settles last, so a set two refused reads disclosed does
        // not keep a slot -- and a marker anything promoted or left unaccounted for stays.
        for (const key of settleSets(claims, claimed, "refused")) {
          if (kv.get<CollectionState | true>(key) === "pending") kv.delete(key);
        }
      },
    };
  }

  /**
   * Builds an observed-collection storage key.
   * @param collectionId Canonical collection ID.
   * @returns Storage key for the collection.
   */
  #collectionKey(collectionId: CanonicalCollectionId): string {
    return `${this.#collectionPrefix}${collectionId}`;
  }

  /**
   * Reads an observed collection's state.
   * @param collectionId Canonical collection ID.
   * @returns Current state, including normalized legacy values.
   */
  #state(collectionId: CanonicalCollectionId): CollectionState | undefined {
    // `true` is the legacy encoding of "observed" some gatekeepers already have in storage. The kit
    // never writes it, and normalizing it here keeps the two spellings out of every other line.
    const stored = this.#options.kv.get<CollectionState | true>(this.#collectionKey(collectionId));
    return stored === true ? "observed" : stored;
  }

  /** @returns Every canonical collection ID retained by this tracker. */
  #trackedCollections(): CanonicalCollectionId[] {
    return [...this.#options.kv.list<unknown>({ prefix: this.#collectionPrefix })].map(([key]) =>
      key.slice(this.#collectionPrefix.length) as CanonicalCollectionId,
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
