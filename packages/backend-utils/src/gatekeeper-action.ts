// Shared helpers for gatekeepers implementing the `Gatekeeper` action contract. They cover the
// obligations every action-queueing gatekeeper repeats: serializing resolution methods, argument
// validation, durable attribution of veto-cascade invalidations (so repeated requests can
// re-report them), and the display-safe `stopped.reason` error.

type Kv = DurableObjectStorage["kv"];

/** Runs asynchronous operations sequentially in submission order. */
export class SerialTaskQueue {
  #tail: Promise<void> = Promise.resolve();

  /** Enqueues an operation without allowing a rejection to block later operations. */
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** One `ApplyActionsThroughResult.invalidatedByVeto` entry. */
export type VetoInvalidation = { action: number, invalidatedBy: number };

/**
 * Validate an `applyActionsThrough(actionId, vetoes)` request before touching any state: the
 * frontier must be a positive integer and every veto must be a positive integer at or below it.
 * Returns the deduplicated veto set.
 */
export function validateApplyThroughArgs(actionId: number, vetoes: number[]): Set<number> {
  if (!Number.isSafeInteger(actionId) || actionId < 1) throw new TypeError("Invalid action ID.");
  const result = new Set<number>();
  for (const veto of vetoes) {
    if (!Number.isSafeInteger(veto) || veto < 1 || veto > actionId) {
      throw new TypeError("Invalid veto action ID.");
    }
    result.add(veto);
  }
  return result;
}

/**
 * Durable record of which veto invalidated which cascade-deleted action, kept in its own KV
 * keyspace so a gatekeeper that deletes rejected records can still satisfy the contract's
 * requirement that a repeated request re-report invalidations attributable to its vetoes.
 */
export class InvalidationLog {
  #kv: Kv;

  constructor(kv: Kv) {
    this.#kv = kv;
  }

  /** Record that the veto of `vetoedBy` invalidated `invalidatedId`, for later re-reporting. */
  record(invalidatedId: number, vetoedBy: number): void {
    this.#kv.put(`invalidation:${invalidatedId}`, vetoedBy);
  }

  /** Persisted invalidations attributed to any of the given vetoed action IDs, ascending. */
  attributedTo(vetoes: Set<number>): VetoInvalidation[] {
    return [...this.#kv.list<number>({ prefix: "invalidation:" })]
      .map(([key, invalidatedBy]) => ({ action: Number(key.slice("invalidation:".length)), invalidatedBy }))
      .filter(entry => vetoes.has(entry.invalidatedBy))
      .toSorted((a, b) => a.action - b.action);
  }

  /**
   * Drop entries no future request can attribute: a veto is only ever re-sent while some action at
   * or below it is still undecided, so entries whose veto precedes every remaining undecided
   * action (`pendingFloor`, `Infinity` when none remain) are unreachable. `keep` protects the
   * current request's vetoes.
   */
  prune(keep: Set<number>, pendingFloor: number): void {
    for (const [key, vetoedBy] of this.#kv.list<number>({ prefix: "invalidation:" })) {
      if (vetoedBy < pendingFloor && !keep.has(vetoedBy)) this.#kv.delete(key);
    }
  }
}

/**
 * The error a gatekeeper should report in `stopped.reason`. Only its `message` survives the RPC
 * hop to the overseer, so it must stand alone as text the user can act on; apply errors already
 * carry a specific, display-safe message, exactly as the legacy single-action path surfaced them.
 * `fallback` describes the failure generically for non-Error throws with no message of their own.
 */
export function displayReason(error: unknown, fallback: string): Error {
  return error instanceof Error && error.message
    ? error
    : new Error(`${fallback}: ${String(error)}`);
}
