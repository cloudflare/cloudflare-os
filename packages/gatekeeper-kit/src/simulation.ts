/** Pending-action indexing, pure replay, and provisional-ID mapping. */

import type { KvReadWrite } from "./kv";

/** One action journal entry visible to simulation. */
export type SimulationRecord<Action> = {
  readonly id: number;
  readonly action: Action;
};

/** Immutable, ordered simulation records, optionally indexed by target. */
export type SimulationView<R extends SimulationRecord<unknown>, Target> = {
  /** @returns Every visible record in action ID order. */
  readonly all: () => readonly R[];
  /**
   * Finds records affecting a target.
   * @param target Target to find.
   * @returns Matching records in action ID order.
   */
  readonly forTarget: (target: Target) => readonly R[];
};

/**
 * Sorts a journal snapshot and indexes its targets. Returned arrays are frozen, but records remain
 * caller-owned and must not be mutated afterwards.
 * @param records Journal snapshot.
 * @param targets Extracts targets from an action.
 * @returns A frozen, indexed simulation view.
 *
 * @example
 * ```ts
 * const pending = createSimulationView(
 *   journal.listPending(),
 *   action => [action.projectId],
 * ).forTarget(project.id);
 * return replaySimulation(project, pending, applyPendingAction);
 * ```
 */
export function createSimulationView<R extends SimulationRecord<unknown>, Target>(
  records: readonly R[],
  targets: (action: R["action"]) => readonly Target[],
): SimulationView<R, Target> {
  const all = Object.freeze(records.toSorted((a, b) => a.id - b.id));
  const byTarget = new Map<Target, R[]>();

  for (const record of all) {
    const seen = new Set<Target>();
    for (const target of targets(record.action)) {
      if (seen.has(target)) continue;
      seen.add(target);
      const indexed = byTarget.get(target);
      if (indexed) indexed.push(record);
      else byTarget.set(target, [record]);
    }
  }

  for (const recordsForTarget of byTarget.values()) Object.freeze(recordsForTarget);
  const empty: readonly R[] = Object.freeze([]);
  return Object.freeze({
    all: () => all,
    forTarget: (target: Target) => byTarget.get(target) ?? empty,
  });
}

/** The outcome of projecting one relevant action onto a simulated value. */
export type SimulationStep<State> =
  | { kind: "applied"; value: State }
  | { kind: "known-no-effect" }
  | { kind: "unsupported"; reason: string };

/** Partial replay result, discriminated so callers must handle unsupported effects. */
export type SimulationResult<State, R> =
  | { kind: "complete"; value: State; appliedCount: number }
  | {
      kind: "incomplete";
      partial: State;
      appliedCount: number;
      unsupported: R;
      reason: string;
    };

/**
 * Replays actions until an effect is unsupported. `apply` must return the next value rather than
 * mutate its input, so partial results remain honest.
 * @param base Initial simulated value.
 * @param records Ordered action records.
 * @param apply Projects one action onto the current value.
 * @returns Complete or partial replay state.
 */
export function replaySimulation<State, R>(
  base: State,
  records: readonly R[],
  apply: (state: State, record: R) => SimulationStep<State>,
): SimulationResult<State, R> {
  let value = base;
  let appliedCount = 0;
  for (const record of records) {
    const step = apply(value, record);
    if (step.kind === "unsupported") {
      return {
        kind: "incomplete",
        partial: value,
        appliedCount,
        unsupported: record,
        reason: step.reason,
      };
    }
    if (step.kind === "applied") {
      value = step.value;
      appliedCount += 1;
    }
  }
  return { kind: "complete", value, appliedCount };
}

/** The synchronous Durable Object KV surface used by provisional IDs. */
export type SimulationKv = KvReadWrite;

/**
 * Allocates durable provisional IDs and retains their provider-ID bindings.
 *
 * Namespaces sharing one KV object must be disjoint; this convention is not checked at runtime.
 */
export class ProvisionalIds<Id extends string> {
  readonly #kv: SimulationKv;
  readonly #namespace: string;
  readonly #isProvisional?: (id: Id) => boolean;

  /**
   * Creates a provisional-ID store.
   * @param kv Durable Object storage for sequences and bindings.
   * @param options Namespace and optional provisional-ID classifier.
   */
  constructor(
    kv: SimulationKv,
    options: {
      namespace: string;
      /**
       * Classifies provisional IDs.
       * @param id ID to inspect.
       * @returns Whether the ID is provisional.
       */
      isProvisional?(id: Id): boolean;
    },
  ) {
    this.#kv = kv;
    this.#namespace = options.namespace;
    this.#isProvisional = options.isProvisional;
  }

  /**
   * Allocates a monotonic provisional ID. When a classifier is supplied, the formatted ID must satisfy
   * it before the ID is stored.
   * @param format Converts the sequence into a provider-shaped ID.
   * @param options Optional logical entity kind.
   * @returns The allocated provisional ID.
   */
  allocate(format: (sequence: number) => Id, options?: { kind?: string }): Id {
    const key = `${this.#namespace}seq:provisional`;
    const sequence = this.#kv.get<number>(key) ?? 1;
    const id = format(sequence);
    if (this.#isProvisional?.(id) === false) {
      throw new Error(
        `Formatter produced ${id}, which isProvisional does not classify as provisional.`);
    }
    this.#kv.put(key, sequence + 1);
    if (options?.kind !== undefined) {
      this.#kv.put(this.#kindKey(id), options.kind);
    }
    return id;
  }

  /**
   * Binds a provisional ID to its provider ID.
   * @param provisional Provisional ID to bind.
   * @param real Provider-assigned ID.
   */
  bind(provisional: Id, real: Id): void {
    if (this.#isProvisional !== undefined) {
      if (!this.#isProvisional(provisional)) {
        throw new Error(`Cannot bind ${provisional}: it is not a provisional ID.`);
      }
      if (this.#isProvisional(real)) {
        throw new Error(`Cannot bind ${provisional} to ${real}: the target is also provisional.`);
      }
    }
    const bound = this.#bound(provisional);
    if (bound !== undefined) {
      if (bound === real) return;
      throw new Error(`${provisional} is already bound to ${bound}, not ${real}.`);
    }
    this.#kv.put(`${this.#namespace}prov:${provisional}`, real);
  }

  /**
   * Resolves a bound provisional ID.
   * @param id Provisional or provider ID.
   * @returns The bound provider ID, or the input when unbound.
   */
  resolve(id: Id): Id {
    if (this.#isProvisional?.(id) === false) return id;
    return this.#bound(id) ?? id;
  }

  /**
   * Checks whether an ID has a durable binding.
   * @param id ID to check.
   * @returns Whether a binding exists.
   */
  isResolved(id: Id): boolean {
    return this.#bound(id) !== undefined;
  }

  /**
   * Reads an ID's logical entity kind.
   * @param id ID to inspect.
   * @returns The stored kind, or `undefined`.
   */
  kindOf(id: Id): string | undefined {
    return this.#kv.get<string>(this.#kindKey(id));
  }

  /**
   * Resolves an ID for provider use.
   * @param id Provisional or provider ID.
   * @param options Optional expected logical entity kind.
   * @returns A provider ID.
   */
  requireResolved(id: Id, options?: { expectedKind?: string }): Id {
    const isProvisional = this.#isProvisional;
    if (isProvisional === undefined) {
      throw new Error("requireResolved needs an isProvisional predicate to classify IDs.");
    }
    if (options?.expectedKind !== undefined) {
      const actual = this.kindOf(id);
      if (actual !== undefined && actual !== options.expectedKind) {
        throw new Error(`${id} is a ${actual}, not a ${options.expectedKind}.`);
      }
    }
    // A provider ID is already final, so no binding may redirect it: a pair an instance with no
    // classifier wrote would otherwise aim this at a different resource.
    if (!isProvisional(id)) return id;

    const bound = this.#bound(id);
    if (bound === undefined) {
      throw new Error(`${id} has not been created yet, so it cannot be used against the provider.`);
    }
    // Classified on the way out as well as at `bind`, for the same reason.
    if (isProvisional(bound)) {
      throw new Error(`${id} is bound to ${bound}, which has not been created yet.`);
    }
    return bound;
  }

  /**
   * Reads a provisional ID's binding.
   * @param id Provisional ID.
   * @returns The provider ID, or `undefined`.
   */
  #bound(id: Id): Id | undefined {
    return this.#kv.get<Id>(`${this.#namespace}prov:${id}`);
  }

  /**
   * Builds a logical-kind storage key.
   * @param id ID whose kind is stored.
   * @returns Storage key for the kind.
   */
  #kindKey(id: Id): string {
    return `${this.#namespace}kind:${id}`;
  }
}
