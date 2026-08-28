// Observer admission and forward exclusion across the data sets a binding has revealed: the
// tracker behind `trackedSetObservers`, plus the storage vocabulary it shares with `./observers`.

import { createLogger } from "@gadgets/backend-utils/logger";
import { generateNonce } from "./connect-nonce";
import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

const logger = createLogger<{ vendorId: string; observerId: string }>({
  component: "gatekeeper.observers",
});

/**
 * Reinterpret the opaque verifier stub the overseer hands to `addObserver()` as this gatekeeper's
 * concrete verifier API. A cast is unavoidable: Workers RPC types cannot express that
 * `Fetcher<Sub>` is assignable to `Fetcher<Base>`. It is safe at runtime because the overseer only
 * routes a verifier back to the vendor that minted it. Centralized so the cast lives in one place.
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

/** How far a tracked set has gone: revealed but awaiting an authorized read, or observed. */
type SetState = "pending" | "observed";

/**
 * How a prepared observation ends. Exactly one of these runs: `commit` when the overseer agreed to
 * hide the read from the observers named here, `discard` when it did not. Both MUST be synchronous
 * -- the gate does not await them, and the tracker's fences rely on their writes landing in one
 * awaitless run.
 *
 * `discard` is for state a refusal must not leave behind. Pending set records are not that: a read
 * that never committed disclosed nothing, so leaving them costs a slot of the tracking budget and
 * a later read of the same sets promotes them -- which is what the corpus does, to a gatekeeper.
 */
export type ObservationCheck = {
  excludeObservers?: string[];
  commit(): void;
  discard?(): void;
};

/** Internal: the check for a read that reveals no tracked set. */
export const NOTHING_TO_RESOLVE: ObservationCheck = { commit() {} };

/**
 * Where stored verifiers live. Fixed: every gatekeeper in the corpus keys its observers under this
 * prefix, and only the observed-set family varies (`observedProject:`, `trackedConversation:`, ...).
 */
const OBSERVER_PREFIX = "observer:";

/**
 * A candidate's verifier while its admission verifies, and the nonce naming that attempt.
 * Enumerated beside admitted observers, so a read in flight already withholds from it. Durable, so
 * it also fences an admission running through another tracker over the same storage.
 */
const OBSERVER_ATTEMPT_PREFIX = "observer-attempt:";
const OBSERVER_NONCE_PREFIX = "observer-nonce:";

/** What an attempt record stores: the candidate's verifier and when the admission began. */
type ObserverAttempt<V> = { verifier: V; at: number };

/**
 * How long an attempt record fences before a later admission may sweep it. Matches
 * `INITIATION_NONCE_LIFETIME_MS`, and sweeping a live attempt is safe: it just fails closed at its
 * next nonce check and retries.
 */
export const OBSERVER_ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

/** Latches this binding closed to admission. One key, not a family: it names no observer. */
const OBSERVER_WITHHELD_KEY = "observer-withheld";

/**
 * Withheld reads awaiting the overseer, one nonce-named marker each. Durable, and written before
 * the overseer call so the output gate orders it ahead of the remote record: the overseer stores
 * the description durably before our continuation runs, and a crash there must not reopen
 * admission. Stranded by a crash, a marker over-fences for good -- the safe direction.
 */
const OBSERVER_WITHHOLD_PREFIX = "observer-withhold:";

/** Every prefix the observer family owns, which an observed-set prefix may not overlap. */
const RESERVED_PREFIXES = [
  OBSERVER_PREFIX, OBSERVER_ATTEMPT_PREFIX, OBSERVER_NONCE_PREFIX, OBSERVER_WITHHOLD_PREFIX,
  OBSERVER_WITHHELD_KEY,
];

/** How many distinct sets a binding may track before it stops being verifiable. */
const DEFAULT_MAX_TRACKED_SETS = 1000;

/**
 * How many observers a binding may retain. Each costs a verifier call per read, and past the
 * platform ceiling every read throws -- so admission is where the refusal has to be legible.
 *
 * The ceiling is documented once and loosely ("a single request has a maximum of 32 Worker
 * invocations"), leaving open whether a callee's own invocations are charged to the same request.
 * A corpus verifier calls its account DO, so 20 observers is 40 under the strict reading and fits
 * under the loose one; workerd enforces neither locally. 10 is safe under both, and the trade is
 * asymmetric: too high locks every collaborator out for good, too low is one raised `maxObservers`.
 */
const DEFAULT_MAX_OBSERVERS = 10;

/** How many verifiers may be consulted at once. */
const DEFAULT_CONCURRENCY = 6;

/**
 * Awaits `fn` over `items` with at most `limit` in flight, preserving order. A pool rather than
 * fixed windows, so one slow verifier delays only its own slot, not the start of everything behind
 * it -- this runs on the gated read path.
 *
 * The observer dimension is the kit's to bound; the set dimension is the oracle's, since
 * `hasSetAccess` receives every observed set in one call and can chunk them as its provider
 * requires. Unbounded here, a binding with many observers would exceed the Workers subrequest budget
 * on a path the overseer re-runs at every open, locking out every collaborator at once.
 */
async function mapLimit<In, Out>(
  items: readonly In[],
  limit: number,
  fn: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Configuration for an observer tracker and its provider-owned ACL oracle. */
export type ObserverTrackerOptions<V> = {
  /** The binding's `ctx.storage.kv`. */
  kv: ObserverKv;
  /** Key prefix for observed-set records; observers always live under `"observer:"`. */
  setPrefix?: string;
  /**
   * Canonicalizes a set id before it is stored, compared, or handed to the oracle, so two spellings
   * of one resource cannot become two tracked sets (Notion's equivalent item-id forms). Identity
   * when omitted. Set ids stay opaque strings: a compound identity is the caller's own join, the
   * shape Confluence already uses for its `space:`/`content:` families.
   */
  canonicalSetId?(setId: string): string;
  /**
   * Throwing membership check run before per-set checks at admission, e.g. org or workspace
   * membership. Admission-only: a per-observation re-check would cost a provider round trip per
   * observer per read, and a baseline that can be revoked belongs in `hasSetAccess`, which can
   * answer all-`false` from one batched call.
   */
  verifyBaseline?(verifier: V): Promise<void>;
  /**
   * Batched per-set ACL oracle: one entry per requested set, in order. Free to chunk the array
   * destructively (see `mapLimit`) -- every call receives its own copy.
   */
  hasSetAccess(verifier: V, setIds: readonly string[]): Promise<boolean[]>;
  /**
   * Denial text for a failing set; defaults to `OBSERVER_DENIED`. Shown verbatim to the denied
   * collaborator, who by definition lacks access to `setId` -- naming the set would disclose that
   * this workspace read it. Keep the text generic; `setId` is for diagnostics or category-level
   * wording, never the message.
   */
  denyMessage?(setId: string): string;
  /**
   * Distinct sets this binding may track before it refuses to reveal another.
   *
   * Enforced when a set is recorded rather than when an observer joins, because the alternative is
   * worse: a binding that has already read past the cap could never be verified against, which
   * locks out the collaborators already using it as well as new ones, with no way back.
   */
  maxTrackedSets?: number;
  /**
   * Observers this binding may retain. `concurrency` throttles the fan-out but does not bound it;
   * this does, and refuses at admission rather than letting every later read throw.
   */
  maxObservers?: number;
  /** Concurrent verifier round trips. */
  concurrency?: number;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * A set id that has been through `canonicalSetId`. Purely internal: it appears in no exported
 * signature, so a consumer never has to produce one, and the brand cannot leak into their types.
 * Its whole job is to make "canonicalize once, at the entry point" a compile error to get wrong.
 */
type CanonicalSetId = string & { readonly __canonical: true };

/** Tracks observer admission and forward exclusion across revealed data sets. */
export class ObserverTracker<V> {
  readonly #options: ObserverTrackerOptions<V>;
  readonly #setPrefix: string;
  readonly #canonicalSetId: (setId: string) => CanonicalSetId;
  readonly #maxTrackedSets: number;
  readonly #maxObservers: number;
  readonly #concurrency: number;
  readonly #logger: typeof logger;

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
   * Verify against every set observed so far, then persist the verifier for forward exclusion. The
   * loop re-reads tracked sets so sets appearing mid-check are also verified before we store.
   *
   * The attempt record goes down before the first await, so a concurrent read already treats the
   * candidate as an observer. A removal or a later attempt rotates the nonce, and the check after
   * every await refuses rather than reinstating an observer nothing tracks. A crash leaves the
   * attempt behind, which fails closed: the candidate stays excluded until it retries -- and the
   * next admission sweeps attempts past their lifetime, so a stranded one cannot hold a slot for
   * good.
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

  /**
   * Reserve a withheld read: see `ObserverStrategy.prepareWithheld`. `commit` latches the binding
   * closed for good; `discard` leaves it as it was, since a refused read discloses nothing.
   * Nonce-named markers, so one read being refused cannot release another's fence.
   */
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
      discard: () => kv.delete(markerKey),
    };
  }

  /** True while any withheld read awaits the overseer, a crashed activation's included. */
  #withholdInFlight(): boolean {
    for (const _ of this.#options.kv.list({ prefix: OBSERVER_WITHHOLD_PREFIX })) return true;
    return false;
  }

  /** Idempotently stop tracking an observer, cancelling any admission still in flight for it. */
  removeObserver(id: string): void {
    const { kv } = this.#options;
    // The nonce deletion is the cancellation, and it reaches an admission parked anywhere.
    kv.delete(`${OBSERVER_NONCE_PREFIX}${id}`);
    kv.delete(`${OBSERVER_ATTEMPT_PREFIX}${id}`);
    kv.delete(`${OBSERVER_PREFIX}${id}`);
  }

  /**
   * Delete attempts past their lifetime. The overseer mints a fresh id per admission and never
   * retries one, so an attempt a crash stranded holds its `maxObservers` slot until swept.
   */
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

  /** Refuse an admission whose attempt has been superseded by a removal or a later attempt. */
  #requireCurrentAttempt(id: string, nonceKey: string, nonce: string): void {
    if (this.#options.kv.get<string>(nonceKey) !== nonce) {
      throw new Error(`Observer ${id} was removed while being admitted.`);
    }
  }

  /**
   * Every observer this binding must answer for, for a read that must be withheld from all of them
   * at once — an empty result set discloses as much as a populated one, and no set id describes it.
   * Consumed by `ObservationGate`; a facet reaches it through the `withholdFromObservers` scope.
   *
   * Candidates mid-admission included, so a read cannot disclose to one that landed while it was
   * awaiting the overseer.
   */
  observerIds(): string[] {
    return [...this.#observers()].map(([id]) => id);
  }

  /**
   * Mark newly-revealed sets pending (before any await, so a concurrent addObserver sees them) and
   * return the observers who cannot see this observation's sets. Sets are promoted to "observed"
   * only via commit(), after the overseer authorizes the observation; a refusal leaves them
   * pending, to be re-verified and promoted by a later read that succeeds.
   *
   * Every set in the read is re-verified, not just the newly revealed ones: a verdict recorded at
   * first disclosure must not outlive a provider-side ACL revocation. It stays one oracle call per
   * admitted observer, so a binding with no observers still makes none.
   *
   * Throws when recording would take the binding past `maxTrackedSets`: revealing the set anyway
   * would disclose data no observer is ever verified against, and silently not recording it would
   * do the same. The check precedes the writes, so a refusal leaves nothing to release.
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
        for (const setId of promote) kv.put<SetState>(this.#setKey(setId), "observed");
      },
    };
  }

  /** The brand is the precondition: a raw set id will not type-check here. */
  #setKey(setId: CanonicalSetId): string {
    return `${this.#setPrefix}${setId}`;
  }

  #state(setId: CanonicalSetId): SetState | undefined {
    // `true` is the legacy encoding of "observed" some gatekeepers already have in storage. The kit
    // never writes it, and normalizing it here keeps the two spellings out of every other line.
    const stored = this.#options.kv.get<SetState | true>(this.#setKey(setId));
    return stored === true ? "observed" : stored;
  }

  /** Canonical by construction: every key under this prefix was written through `#setKey`. */
  #trackedSets(): CanonicalSetId[] {
    return [...this.#options.kv.list<unknown>({ prefix: this.#setPrefix })].map(([key]) =>
      key.slice(this.#setPrefix.length) as CanonicalSetId,
    );
  }

  /**
   * Admitted observers, then the candidates still verifying. Admitted first, so a re-admission of a
   * live observer is answered for once, by the verifier already stored for it.
   */
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
