/**
 * Strategy C observer tracking: record which units of data a binding has actually read, and admit a
 * collaborator as an observer only if their own credentials reach every one of them.
 *
 * Two directions, both required:
 *
 *  - **Backward.** {@link ObserverTracker.addObserver} verifies a joining observer against every
 *    already-tracked set. The overseer re-runs it on every open, so losing access to source data
 *    promptly locks the collaborator out.
 *  - **Forward.** {@link ObserverTracker.prepareObservation} marks newly-read sets pending and
 *    reports which *existing* observers cannot reach them, so the caller can exclude them before
 *    the data is disclosed. Sets are promoted to observed only once the read is authorized, so a
 *    failed attempt is re-checked on retry rather than being trusted.
 *
 * The tracker deliberately does not cache verifier answers. Re-checking on every open is what makes
 * revocation take effect, and the sets tracked by today's callers are few. A caller that tracks
 * high-cardinality units (one entry per file, say) needs a different answer, not a longer TTL.
 */

const OBSERVER_PREFIX = "observer:";
const OBSERVER_ATTEMPT_PREFIX = "observer-attempt:";
const OBSERVER_NONCE_PREFIX = "observer-nonce:";

/** Persisted state of one tracked set. `true` is the pre-"pending" legacy encoding of observed. */
export type ObservedSetState = true | "pending" | "observed";

/**
 * The outcome of preparing to observe some sets: who must be excluded from the disclosure, and a
 * `commit` the caller invokes once the read is actually authorized.
 */
export type ObserverCheck<T> = {
  /** Observers who cannot reach at least one pending set. Absent when none must be excluded. */
  excludeObservers?: string[];
  /** The sets newly marked pending by this call. */
  pendingSets: T[];
  /** Promotes the pending sets to observed. Call only after the read is authorized. */
  commit(): void;
};

/** The storage surface the tracker needs, satisfied by a Durable Object's `ctx.storage.kv`. */
export interface ObserverKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}

/** Baseline and per-set verdicts returned by one bulk observer verification. */
export type ObserverBatchResult = { baselineAllowed: boolean; allowed: boolean[] };

function assertBatchResultLength(result: ObserverBatchResult, expectedLength: number): void {
  if (result.allowed.length !== expectedLength) {
    throw new Error("Bulk observer verification must return one result per set");
  }
}

export type ObserverTrackerOptions<T, V> = {
  /** Key prefix for tracked sets. Must not be `observer:`, which holds the observers themselves. */
  setPrefix: string;
  /** Reversible encoding of one set's identity. Must round-trip through {@link decode}. */
  encode(value: T): string;
  decode(encoded: string): T;
  /** Whether the observer's own credentials reach one set. Mutually exclusive with `verifyBatch`. */
  hasAccess?(verifier: V, value: T): Promise<boolean>;
  /** Verifies the observer's baseline grant and every supplied set in one RPC. */
  verifyBatch?(verifier: V, values: readonly T[]): Promise<ObserverBatchResult>;
  /** The error thrown when bulk verification finds that the baseline grant is absent. */
  baselineDeniedMessage?: string;
  /** The error thrown when a joining observer cannot reach `value`. */
  deniedMessage(value: T): string;
  /**
   * Whether to remember verified observers so the forward check can consult them later. Callers
   * that can never read a set beyond the one they are bound to have nobody to forward-exclude.
   */
  recordObservers?: boolean;
  /**
   * Distinct sets this binding may track before {@link ObserverTracker.prepareObservation} starts
   * refusing reads.
   *
   * Verification cost grows with the number of tracked sets. The cap is enforced when a set is
   * recorded rather than when an observer joins, because the alternative is worse: a binding that
   * has already read past the cap can never be verified against, which locks out the collaborators
   * already using it as well as new ones, with no way back.
   */
  maxTrackedSets?: number;
  /** Concurrent verifier round trips. Bounded to stay inside the Workers subrequest limits. */
  concurrency?: number;
};

const DEFAULT_MAX_TRACKED_SETS = 1000;
const DEFAULT_CONCURRENCY = 6;

/** Runs `fn` over `items` with at most `limit` in flight, preserving input order in the result. */
async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  limit: number,
  fn: (item: In) => Promise<Out>,
): Promise<Out[]> {
  let results: Out[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      let index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

/**
 * Tracks the sets a binding has observed and gates observers against them.
 *
 * `T` is the unit of tracking (a dataset, a calendar, a file); `V` is the verifier capability the
 * overseer hands to `addObserver`.
 */
export class ObserverTracker<T, V> {
  #kv: ObserverKv;
  #options: ObserverTrackerOptions<T, V>;

  constructor(kv: ObserverKv, options: ObserverTrackerOptions<T, V>) {
    let reserved = [OBSERVER_PREFIX, OBSERVER_ATTEMPT_PREFIX, OBSERVER_NONCE_PREFIX];
    if (reserved.includes(options.setPrefix)) {
      throw new Error(`setPrefix must not collide with a reserved prefix (${reserved.join(", ")})`);
    }
    if ((options.hasAccess === undefined) === (options.verifyBatch === undefined)) {
      throw new Error("Configure exactly one observer access verifier");
    }
    if (options.verifyBatch && !options.baselineDeniedMessage) {
      throw new Error("A bulk verifier requires baselineDeniedMessage");
    }
    // Staging first closes the admission race only while the observer is actually recorded. A bulk
    // verifier with recordObservers: false would leave a concurrent disclosure unable to see the
    // joining observer, which is the leak the staging exists to close.
    if (options.verifyBatch && options.recordObservers === false) {
      throw new Error("A bulk verifier must record observers");
    }
    this.#kv = kv;
    this.#options = options;
  }

  get #maxTrackedSets(): number {
    return this.#options.maxTrackedSets ?? DEFAULT_MAX_TRACKED_SETS;
  }

  get #concurrency(): number {
    return this.#options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  #setKey(value: T): string {
    return `${this.#options.setPrefix}${this.#options.encode(value)}`;
  }

  #isObserved(value: T): boolean {
    let state = this.#kv.get<ObservedSetState>(this.#setKey(value));
    return state === true || state === "observed";
  }

  /** Every set this binding has read or is attempting to read, in storage order. */
  listTracked(): T[] {
    let prefix = this.#options.setPrefix;
    return [...this.#kv.list<ObservedSetState>({ prefix })]
        .map(([key]) => this.#options.decode(key.slice(prefix.length)));
  }

  /** Canonical and currently-staged observers, paired with their verifiers. */
  *observers(): IterableIterator<[string, V]> {
    for (let [key, verifier] of this.#kv.list<V>({ prefix: OBSERVER_PREFIX })) {
      yield [key.slice(OBSERVER_PREFIX.length), verifier];
    }
    for (let [key, verifier] of this.#kv.list<V>({ prefix: OBSERVER_ATTEMPT_PREFIX })) {
      yield [key.slice(OBSERVER_ATTEMPT_PREFIX.length), verifier];
    }
  }

  /**
   * Marks any not-yet-observed set among `values` pending, and reports the current observers who
   * cannot reach at least one of them.
   *
   * Pending rather than observed, because the read may still be denied: promoting eagerly would
   * permanently narrow who may observe this binding on the strength of a read that never happened.
   *
   * Throws if recording these sets would take the binding past {@link
   * ObserverTrackerOptions.maxTrackedSets}. Recording anyway would disclose data no observer is
   * ever verified against; not recording it would do the same silently.
   */
  async prepareObservation(values: readonly T[]): Promise<ObserverCheck<T>> {
    let seen = new Set<string>();
    let pendingSets = values.filter(value => {
      let encoded = this.#options.encode(value);
      if (seen.has(encoded)) return false;
      seen.add(encoded);
      return !this.#isObserved(value);
    });
    if (pendingSets.length === 0) return { pendingSets, commit() {} };

    let untracked = pendingSets.filter(
      value => this.#kv.get<ObservedSetState>(this.#setKey(value)) === undefined);
    let tracked = this.listTracked().length;
    if (tracked + untracked.length > this.#maxTrackedSets) {
      throw new Error(
        `This binding has read ${tracked} distinct items, the most it can track while remaining ` +
        "shareable. Bind a narrower scope.");
    }
    for (let value of untracked) this.#kv.put(this.#setKey(value), "pending");

    let observers = [...this.observers()];
    let denied = new Set<string>();
    if (this.#options.verifyBatch) {
      let verifyBatch = this.#options.verifyBatch;
      let results = await mapWithConcurrency(
        observers, this.#concurrency, ([, verifier]) => verifyBatch(verifier, pendingSets));
      for (let [index, [id]] of observers.entries()) {
        let result = results[index];
        assertBatchResultLength(result, pendingSets.length);
        if (!result.baselineAllowed || result.allowed.includes(false)) denied.add(id);
      }
    } else {
      let hasAccess = this.#options.hasAccess!;
      // One flat queue over (observer, set) pairs: nesting two Promise.alls would multiply out to an
      // unbounded number of concurrent round trips.
      let pairs = observers.flatMap(
        ([id, verifier]) => pendingSets.map(value => ({ id, verifier, value })));
      let access = await mapWithConcurrency(
        pairs, this.#concurrency, pair => hasAccess(pair.verifier, pair.value));
      for (let [index, pair] of pairs.entries()) {
        if (!access[index]) denied.add(pair.id);
      }
    }

    return {
      excludeObservers: denied.size > 0 ? [...denied] : undefined,
      pendingSets,
      commit: () => {
        for (let value of pendingSets) this.#kv.put(this.#setKey(value), "observed");
      },
    };
  }

  /**
   * Admits `id` as an observer, or throws naming the first set they cannot reach. Bulk verification
   * stages the candidate, then re-lists until every set has been checked before promotion.
   */
  async addObserver(id: string, verifier: V): Promise<void> {
    let verifyBatch = this.#options.verifyBatch;
    if (verifyBatch !== undefined) return this.#addBulkObserver(id, verifier, verifyBatch);

    let hasAccess = this.#options.hasAccess;
    if (hasAccess === undefined) throw new Error("Configure exactly one observer access verifier");
    return this.#addPerSetObserver(id, verifier, hasAccess);
  }

  #assertCurrentAdmission(nonceKey: string, nonce: string): void {
    if (this.#kv.get<string>(nonceKey) !== nonce) {
      throw new Error("Observer admission was superseded by a newer attempt");
    }
  }

  async #addBulkObserver(
    id: string,
    verifier: V,
    verifyBatch: (verifier: V, values: readonly T[]) => Promise<ObserverBatchResult>,
  ): Promise<void> {
    let observerKey = `${OBSERVER_PREFIX}${id}`;
    let attemptKey = `${OBSERVER_ATTEMPT_PREFIX}${id}`;
    let nonceKey = `${OBSERVER_NONCE_PREFIX}${id}`;
    let nonce = crypto.randomUUID();
    let checked = new Set<string>();
    let needsBaselineCheck = true;
    this.#kv.put(attemptKey, verifier);
    this.#kv.put(nonceKey, nonce);

    try {
      for (;;) {
        let pending = this.listTracked().filter(
          value => !checked.has(this.#options.encode(value)));
        if (!needsBaselineCheck && pending.length === 0) {
          this.#assertCurrentAdmission(nonceKey, nonce);
          this.#kv.put(observerKey, verifier);
          this.#kv.delete(attemptKey);
          this.#kv.delete(nonceKey);
          return;
        }
        needsBaselineCheck = false;

        let result = await verifyBatch(verifier, pending);
        this.#assertCurrentAdmission(nonceKey, nonce);
        assertBatchResultLength(result, pending.length);
        if (!result.baselineAllowed) throw new Error(this.#options.baselineDeniedMessage);
        let deniedIndex = result.allowed.indexOf(false);
        if (deniedIndex >= 0) throw new Error(this.#options.deniedMessage(pending[deniedIndex]));
        for (let value of pending) checked.add(this.#options.encode(value));
      }
    } catch (error) {
      if (this.#kv.get<string>(nonceKey) === nonce) {
        this.#kv.delete(attemptKey);
        this.#kv.delete(nonceKey);
      }
      throw error;
    }
  }

  async #addPerSetObserver(
    id: string,
    verifier: V,
    hasAccess: (verifier: V, value: T) => Promise<boolean>,
  ): Promise<void> {
    let recordObservers = this.#options.recordObservers ?? true;
    let observerKey = `${OBSERVER_PREFIX}${id}`;
    let checked = new Set<string>();
    for (;;) {
      let tracked = this.listTracked();
      let pending = tracked.filter(value => !checked.has(this.#options.encode(value)));
      if (pending.length === 0) {
        if (recordObservers) this.#kv.put(observerKey, verifier);
        return;
      }
      let access = await mapWithConcurrency(
        pending, this.#concurrency, value => hasAccess(verifier, value));
      let deniedIndex = access.indexOf(false);
      if (deniedIndex >= 0) throw new Error(this.#options.deniedMessage(pending[deniedIndex]));
      for (let value of pending) checked.add(this.#options.encode(value));
    }
  }

  removeObserver(id: string): void {
    this.#kv.delete(`${OBSERVER_PREFIX}${id}`);
    this.#kv.delete(`${OBSERVER_ATTEMPT_PREFIX}${id}`);
    this.#kv.delete(`${OBSERVER_NONCE_PREFIX}${id}`);
  }
}
