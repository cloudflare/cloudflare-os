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

export type ObserverTrackerOptions<T, V> = {
  /** Key prefix for tracked sets. Must not be `observer:`, which holds the observers themselves. */
  setPrefix: string;
  /** Reversible encoding of one set's identity. Must round-trip through {@link decode}. */
  encode(value: T): string;
  decode(encoded: string): T;
  /** Whether the observer's own credentials reach this set. */
  hasAccess(verifier: V, value: T): Promise<boolean>;
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
   * Verifying an observer costs one round trip per tracked set, and the overseer re-runs it on
   * every open, so an unbounded set makes opening the gadget unboundedly expensive. The cap is
   * enforced when a set is *recorded* rather than when an observer joins, because the alternative
   * is worse: a binding that has already read past the cap can never be verified against, which
   * locks out the collaborators already using it as well as new ones, with no way back.
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
    if (options.setPrefix === OBSERVER_PREFIX) {
      throw new Error(`setPrefix must not collide with the observer prefix ${OBSERVER_PREFIX}`);
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

  /** The observers admitted so far, paired with the verifier each was admitted with. */
  *observers(): IterableIterator<[string, V]> {
    for (let [key, verifier] of this.#kv.list<V>({ prefix: OBSERVER_PREFIX })) {
      yield [key.slice(OBSERVER_PREFIX.length), verifier];
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

    // One flat queue over (observer, set) pairs: nesting two Promise.alls would multiply out to an
    // unbounded number of concurrent round trips.
    let observers = [...this.observers()];
    let pairs = observers.flatMap(
      ([id, verifier]) => pendingSets.map(value => ({ id, verifier, value })));
    let access = await mapWithConcurrency(
      pairs, this.#concurrency, pair => this.#options.hasAccess(pair.verifier, pair.value));

    let denied = new Set<string>();
    for (let [index, pair] of pairs.entries()) {
      if (!access[index]) denied.add(pair.id);
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
   * Admits `id` as an observer, or throws naming the first set they cannot reach.
   *
   * Re-lists after each round of checks, so a set observed while this was awaiting is covered too.
   * The tracked set is bounded by {@link ObserverTrackerOptions.maxTrackedSets} at record time, so
   * this needs no bound of its own.
   */
  async addObserver(id: string, verifier: V): Promise<void> {
    let checked = new Set<string>();
    for (;;) {
      let tracked = this.listTracked();

      let pending = tracked.filter(value => !checked.has(this.#options.encode(value)));
      if (pending.length === 0) {
        if (this.#options.recordObservers ?? true) {
          this.#kv.put(`${OBSERVER_PREFIX}${id}`, verifier);
        }
        return;
      }

      let access = await mapWithConcurrency(
        pending, this.#concurrency, value => this.#options.hasAccess(verifier, value));
      let deniedIndex = access.indexOf(false);
      if (deniedIndex >= 0) throw new Error(this.#options.deniedMessage(pending[deniedIndex]));

      for (let value of pending) checked.add(this.#options.encode(value));
    }
  }

  removeObserver(id: string): void {
    this.#kv.delete(`${OBSERVER_PREFIX}${id}`);
  }
}
