/** When a commit became a branch head, for telling CI that has not started yet from no CI. */

import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** How long after a commit became a head CI is still expected to report on it. */
export const CI_START_WINDOW_MS = 10 * 60 * 1000;

/** The Durable Object KV surface used by `AppliedPushLog`. */
export type AppliedPushLogKv = KvScannable;

/** Keys, lifetime, and cap for an `AppliedPushLog`. */
export type AppliedPushLogOptions = {
  /** Prefix for every key the log writes, followed by the commit id. Defaults to `ciPushApplied:`. */
  prefix?: string;
  /** How long a record matters, in milliseconds. Defaults to `CI_START_WINDOW_MS`. */
  windowMs?: number;
  /** Most records kept at once; the oldest are dropped past it. Defaults to 100. */
  max?: number;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * When this gatekeeper applied a push that made a commit a branch head: the best "became the head"
 * time for a commit nothing has reported CI on, since a provider's own push records may be missing
 * or late. Only `windowMs` of history matters, so each new record first prunes those older than
 * that (a pruned commit falls back to the caller's other sources), and the family is capped.
 *
 * @example
 * ```ts
 * #pushes = new AppliedPushLog(this.ctx.storage.kv);
 *
 * // After a push is applied:
 * this.#pushes.record(action.newSha);
 * // When a commit has no CI yet:
 * const becameHeadAt = this.#pushes.get(sha) ?? committedAt;
 * ```
 */
export class AppliedPushLog {
  readonly #kv: AppliedPushLogKv;
  readonly #prefix: string;
  readonly #windowMs: number;
  readonly #max: number;
  readonly #now: () => number;

  /**
   * Creates a push log over Durable Object KV.
   * @param kv Durable Object storage.
   * @param options Keys, lifetime, and cap; numeric bounds must be positive safe integers.
   */
  constructor(kv: AppliedPushLogKv, options: AppliedPushLogOptions = {}) {
    this.#kv = kv;
    this.#prefix = options.prefix ?? "ciPushApplied:";
    if (this.#prefix === "") throw new Error("AppliedPushLog prefix must not be empty.");
    this.#windowMs = requirePositiveInt("windowMs", options.windowMs ?? CI_START_WINDOW_MS);
    this.#max = requirePositiveInt("max", options.max ?? 100);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records that `commitId` became a head now. A retried apply keeps the first record.
   * @param commitId The pushed head.
   */
  record(commitId: string): void {
    const now = this.#now();
    const key = `${this.#prefix}${commitId}`;
    const live: [string, number][] = [];
    for (const [stored, at] of this.#kv.list<number>({ prefix: this.#prefix })) {
      if (now - at >= this.#windowMs) this.#kv.delete(stored);
      else live.push([stored, at]);
    }
    if (live.some(([stored]) => stored === key)) return;
    const excess = Math.max(0, live.length - this.#max + 1);
    for (const [stale] of live.toSorted((a, b) => a[1] - b[1]).slice(0, excess)) this.#kv.delete(stale);
    this.#kv.put(key, now);
  }

  /**
   * When this gatekeeper made `commitId` a head, if that was within the window; an older record
   * says nothing the caller's other sources would not.
   * @param commitId A commit id.
   * @returns Epoch milliseconds, or `undefined`.
   */
  get(commitId: string): number | undefined {
    const at = this.#kv.get<number>(`${this.#prefix}${commitId}`);
    return at !== undefined && this.#now() - at < this.#windowMs ? at : undefined;
  }
}
