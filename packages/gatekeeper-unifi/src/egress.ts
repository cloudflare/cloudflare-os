/**
 * Keeps one connection's requests inside what a console tolerates. Site Manager's Cloud Connector
 * allows each console 100 requests a minute, shared by everything using it, so the account that
 * sends every request for its bindings paces them per console and reuses a GET's answer for a few
 * seconds instead of asking again. Direct connections get a looser budget, since only the console
 * itself is protected.
 *
 * Pure: imported by the Node tests, which control the clock.
 */

/** Waits `ms`; replaceable in tests. */
export type Sleep = (ms: number) => Promise<void>;

/** A request budget: `capacity` requests at once, refilled one per `refillMs`. */
export type Budget = { capacity: number; refillMs: number };

/** 80 requests a minute per console, leaving headroom under the connector's 100. */
export const CLOUD_CONSOLE_BUDGET: Budget = { capacity: 10, refillMs: 750 };
/** Site Manager's own limit is 10,000 a minute; the account never comes close. */
export const SITE_MANAGER_BUDGET: Budget = { capacity: 20, refillMs: 100 };
/** 300 requests a minute to a console reached directly. */
export const DIRECT_CONSOLE_BUDGET: Budget = { capacity: 20, refillMs: 200 };

/** How long a request may wait for its turn before failing as rate-limited. */
export const MAX_QUEUE_WAIT_MS = 5_000;

/** A token bucket that callers wait on, and that a 429 can pause. */
export class TokenBucket {
  readonly #budget: Budget;
  readonly #now: () => number;
  #tokens: number;
  #updatedAt: number;
  #blockedUntil = 0;

  constructor(budget: Budget, now: () => number = Date.now) {
    this.#budget = budget;
    this.#now = now;
    this.#tokens = budget.capacity;
    this.#updatedAt = now();
  }

  /**
   * Takes one token, waiting for it if need be.
   * @param maxWaitMs How long to wait at most.
   * @param sleep How to wait.
   * @returns 0 once a token is taken, or how long the caller would have had to wait.
   */
  async take(maxWaitMs: number, sleep: Sleep): Promise<number> {
    for (;;) {
      const wait = this.#tryTake();
      if (wait === 0) return 0;
      if (wait > maxWaitMs) return wait;
      maxWaitMs -= wait;
      await sleep(wait);
    }
  }

  /** Refuses tokens until `until`, after the console said to back off. */
  block(until: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, until);
    this.#tokens = 0;
    this.#updatedAt = Math.max(this.#updatedAt, until);
  }

  #tryTake(): number {
    const now = this.#now();
    if (now < this.#blockedUntil) return this.#blockedUntil - now;
    const refilled = Math.floor((now - this.#updatedAt) / this.#budget.refillMs);
    if (refilled > 0) {
      this.#tokens = Math.min(this.#budget.capacity, this.#tokens + refilled);
      this.#updatedAt = this.#tokens === this.#budget.capacity
        ? now : this.#updatedAt + refilled * this.#budget.refillMs;
    }
    if (this.#tokens > 0) {
      this.#tokens--;
      return 0;
    }
    return Math.max(1, this.#updatedAt + this.#budget.refillMs - now);
  }
}

/** A cached answer and when it stops being fresh. */
type Entry<V> = { value: V; expiresAt: number; group: string };

/**
 * A small in-memory cache of recent answers, grouped so a write can drop every answer from the
 * console it changed. Concurrent misses for one key share a single load.
 */
export class ResponseCache<V> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #loads = new Map<string, Promise<V>>();
  readonly #now: () => number;
  readonly #maxEntries: number;
  #generation = 0;

  constructor(now: () => number = Date.now, maxEntries = 500) {
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  /**
   * Returns a fresh cached answer, or loads one.
   * @param group The console the answer came from, for `invalidate`.
   * @param key The request's identity.
   * @param ttlMs How long an answer stays fresh; `keep(value)` decides whether it's stored at all.
   * @param load Fetches the answer.
   * @param keep Whether to cache a loaded answer, e.g. only successes.
   */
  async get(group: string, key: string, ttlMs: number, load: () => Promise<V>, keep: (value: V) => boolean): Promise<V> {
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt > this.#now()) return entry.value;
    const pending = this.#loads.get(key);
    if (pending) return pending;

    const generation = this.#generation;
    const flight = load().then(value => {
      // A write that landed while this was loading may have changed the answer.
      if (keep(value) && generation === this.#generation) this.#store(key, { value, group, expiresAt: this.#now() + ttlMs });
      return value;
    }).finally(() => {
      if (this.#loads.get(key) === flight) this.#loads.delete(key);
    });
    this.#loads.set(key, flight);
    return flight;
  }

  /** Drops every answer from `group`, and fences out loads still in flight. */
  invalidate(group: string): void {
    this.#generation++;
    for (const [key, entry] of this.#entries) {
      if (entry.group === group) this.#entries.delete(key);
    }
    this.#loads.clear();
  }

  /** Drops everything, e.g. after the credentials change. */
  clear(): void {
    this.#generation++;
    this.#entries.clear();
    this.#loads.clear();
  }

  #store(key: string, entry: Entry<V>): void {
    if (this.#entries.size >= this.#maxEntries) {
      const now = this.#now();
      for (const [k, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(k);
      if (this.#entries.size >= this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    }
    this.#entries.set(key, entry);
  }
}
