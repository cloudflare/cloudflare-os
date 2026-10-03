/** Observer-policy strategies and per-read authorization. */

import type { RpcStub } from "cloudflare:workers";
import type {
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  asVerifier,
  NOTHING_TO_RESOLVE,
  OBSERVER_DENIED,
  ObserverTracker,
  type ObservationCheck,
  type ObserverTrackerOptions,
} from "./observer-tracker";

export {
  asVerifier,
  OBSERVER_ATTEMPT_LIFETIME_MS,
  OBSERVER_DENIED,
  OBSERVER_WITHHELD,
  ObserverTracker,
  type ObservationCheck,
  type ObserverKv,
  type ObserverTrackerOptions,
} from "./observer-tracker";

/**
 * The mark an overseer refusal of an observation carries, on `name` or a transport-stable `code`.
 * A failure carrying it proves the observation was refused by policy *before* it was recorded, so
 * prepared observer state may be reclaimed; any other failure leaves the outcome unknown, and
 * durable fences must be retained.
 */
export const OBSERVATION_REFUSED_CODE = "ObservationRefusedError";

/**
 * Matches an overseer observation refusal by `name` or `code`: capnweb rebuilds errors, keeping
 * enumerable own props but not the name. Until the overseer marks its refusals nothing matches, so
 * every failure takes the unknown-outcome path.
 * @param error Caught error.
 * @returns Whether the overseer refused the observation before recording it.
 */
export function isObservationRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === OBSERVATION_REFUSED_CODE
    || ("code" in error && error.code === OBSERVATION_REFUSED_CODE);
}

/**
 * How thoroughly a strategy checks observer access to the provider groupings a read discloses.
 *
 * - `"per-read"` — an ACL oracle runs for every observer on every scoped read.
 * - `"no-observers"` — nobody is ever admitted, so there is no observer to check.
 * - `"unsupported"` — observers exist and nothing checks them per grouping. A scoped read is
 *   refused, since ids that are silently discarded describe a check nothing performed.
 */
export type AclChecks = "per-read" | "no-observers" | "unsupported";

type ObserverStrategyBase = {
  /**
   * Attempts to admit an observer.
   * @param id Observer ID.
   * @param user Overseer verifier capability.
   */
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  /**
   * Removes an observer.
   * @param id Observer ID.
   */
  removeObserver(id: string): Promise<void>;
  /** @returns Retained observer IDs without fencing concurrent admission. */
  observerIds?(): string[];
  /**
   * Reserves a read hidden from every observer.
   * @returns A check that fences admission until settled.
   */
  prepareWithheld(): ObservationCheck;
};

/**
 * Defines collaborator admission and per-observation exclusion. Baseline access is verified at
 * admission only -- losing Workshop membership is the revocation path -- and only
 * `trackedCollectionObservers` re-runs its ACL oracle for every observer on every scoped read.
 *
 * `aclChecks` is part of the contract, not a hint: only the `"per-read"` arm may carry `prepare`,
 * so a strategy cannot claim a check it does not implement.
 */
export type ObserverStrategy =
  | (ObserverStrategyBase & {
    aclChecks: "per-read";
    /**
     * Prepares exclusions for the groupings a read disclosed.
     * @param collectionIds Provider grouping IDs disclosed by the read.
     * @returns Prepared observer state.
     */
    prepare(collectionIds: readonly string[]): Promise<ObservationCheck>;
  })
  | (ObserverStrategyBase & {
    aclChecks: "no-observers" | "unsupported";
    prepare?: never;
  });

// Baseline and public strategies cannot support owner-only reads.
function cannotWithhold(): never {
  throw new Error(
    "This binding's strategy shares every read with admitted observers; use a baseline scope, " +
    "or track observed collections to withhold a read.");
}

/**
 * Creates a strategy that rejects every observer.
 * @param message Admission-denial message.
 * @returns A private observer strategy.
 */
export function privateObservers(message: string): ObserverStrategy {
  return {
    // Nobody is ever admitted, so a collection scope has no observer to exclude.
    aclChecks: "no-observers",
    addObserver: async () => { throw new Error(message); },
    removeObserver: async () => {},
    // Owner-only by construction: no observer is ever admitted, so there is nobody to exclude.
    prepareWithheld: () => NOTHING_TO_RESOLVE,
  };
}

/**
 * Creates a resource-level ACL strategy. `hasAccess` runs only at admission; an observer who loses
 * access afterwards is caught at their next open, when the overseer re-admits them.
 * @param options ACL oracle and denial message.
 * @returns An ACL observer strategy.
 */
export function aclObservers<V>(options: {
  /**
   * Checks resource-level access. An error thrown here may be shown to the denied collaborator:
   * keep its message display-safe and free of resource identifiers.
   * @param verifier Vendor-specific verifier capability.
   * @returns Whether the observer may access the resource.
   */
  hasAccess(verifier: V): Promise<boolean>;
  denyMessage?: string;
}): ObserverStrategy {
  return {
    // Admission is resource-level, so child collection ids would be accepted and discarded.
    aclChecks: "unsupported",
    addObserver: async (_id, user) => {
      // Only `true` admits, as in C: a malformed answer from a hand-written oracle denies rather
      // than admits, and the two strategies must not disagree on what counts as access.
      if (await options.hasAccess(asVerifier<V>(user)) !== true) {
        throw new Error(options.denyMessage ?? OBSERVER_DENIED);
      }
    },
    removeObserver: async () => {},
    prepareWithheld: cannotWithhold,
  };
}

/**
 * Creates a strategy that tracks observed collection ACLs.
 * @param options Observer-tracker storage and ACL policy.
 * @returns A tracked-collection observer strategy.
 */
export function trackedCollectionObservers<V>(options: ObserverTrackerOptions<V>): ObserverStrategy {
  const tracker = new ObserverTracker<V>(options);
  return {
    aclChecks: "per-read",
    addObserver: (id, user) => tracker.addObserver(id, asVerifier<V>(user)),
    removeObserver: async id => tracker.removeObserver(id),
    prepare: collectionIds => tracker.prepareObservation(collectionIds),
    observerIds: () => tracker.observerIds(),
    prepareWithheld: () => tracker.prepareWithheld(),
  };
}

/**
 * Creates a strategy that admits every observer without consulting the provider. Appropriate only
 * where the data carries no provider-side access distinction: a collaborator the provider itself
 * would refuse still observes everything the binding reads.
 * @returns An open observer strategy.
 */
export function openObservers(): ObserverStrategy {
  return {
    // Every observer sees every read, so collection ids would describe a distinction that is
    // not being made. Declare such a read `baseline`.
    aclChecks: "unsupported",
    addObserver: async () => {},
    removeObserver: async () => {},
    prepareWithheld: cannotWithhold,
  };
}

/**
 * Escapes provider text for a Markdown description.
 * @param value Provider text.
 * @returns Escaped single-line Markdown text.
 */
export function escapeObservationValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

/**
 * Describes what a read discloses: the admission baseline, the provider groupings whose ACLs
 * govern it, or nothing shareable at all.
 *
 * A `collections` scope names provider-side access-controlled groupings — a space, a project, a
 * repo — not the individual rows returned. The gate refuses one under a strategy whose
 * `aclChecks` is `"unsupported"`, since ids nothing verifies would describe a check that never
 * ran; pick `trackedCollectionObservers` for a resource whose children carry their own ACLs, and
 * `baseline` where admission already covers the read. It also refuses a `collections` scope
 * naming none, so a read that returned nothing describes itself as `baseline`.
 */
export type ObservationScope =
  | { kind: "baseline" }
  | { kind: "collections"; ids: readonly string[] }
  | { kind: "withholdFromObservers" };

/** Observation text completed by the gate with derived exclusions. */
export type ObservationInput = Omit<ObservationDescription, "excludeObservers">;

/**
 * Authorizes observations after applying the selected observer strategy.
 *
 * @example
 * ```ts
 * #observations = new ObservationGate(queue.dup(), observerStrategy);
 *
 * async listProjects() {
 *   const projects = await this.#api.listProjects();
 *   await this.#observations.authorize(
 *     describeProjects(projects),
 *     { kind: "collections", ids: projects.map(project => project.id) },
 *   );
 *   return projects;
 * }
 * ```
 */
export class ObservationGate implements Disposable {
  readonly #authorizer: RpcStub<ObservationAuthorizer>;
  readonly #strategy: ObserverStrategy;

  /**
   * Creates an observation gate.
   * @param authorizer Duplicated authorizer stub owned by the gate. A session that also stages
   * actions keeps its own approval-queue stub; this one is the read-only surface.
   * @param strategy Observer strategy for this binding.
   */
  constructor(authorizer: RpcStub<ObservationAuthorizer>, strategy: ObserverStrategy) {
    this.#authorizer = authorizer;
    this.#strategy = strategy;
  }

  /**
   * Reaches the workspace git cache through the gate, so a gatekeeper whose API returns commit ids
   * can advertise them without holding a stub of its own. Observations still go only
   * through `authorize()`.
   *
   * The returned stub is **caller-owned**: dispose it when the read is done, or take it with
   * `using`. The gate keeps its own authorizer stub either way. The promise pipelines, so a call
   * on it need not be awaited first. The return type is the authorizer's own, so the stub stays
   * `Disposable` rather than being flattened to a bare `GitCache` that `using` would reject.
   * @returns The gatekeeper-scoped git cache.
   */
  getGitCache(): ReturnType<RpcStub<ObservationAuthorizer>["getGitCache"]> {
    return this.#authorizer.getGitCache();
  }

  /**
   * Opens a second gate over its own duplicate of the authorizer, for a capability that outlives
   * the session that made it — a cursor handed to the gadget and walked later, most often.
   *
   * Both gates share this binding's strategy, so exclusions and fences stay one decision; only the
   * stub is duplicated. The lease is **caller-owned**: release it when the capability it
   * serves is released, typically from a cursor's `dispose`. Disposing the session gate does not
   * disturb a lease, and disposing a lease does not disturb the session.
   *
   * Needs a real `RpcStub`: this calls `dup()`, which the overseer's stub has and a plain object
   * does not. A gate built from a service binding cannot lease either, `dup` being reserved
   * over RPC.
   * @returns A gate the caller disposes independently.
   */
  lease(): ObservationGate {
    return new ObservationGate(this.#authorizer.dup(), this.#strategy);
  }

  /**
   * Releases the duplicated authorizer stub. Disposing during isolate shutdown trips a fatal
   * workerd assertion; shipped gatekeepers leave the release to RPC connection teardown.
   */
  [Symbol.dispose](): void {
    this.#authorizer[Symbol.dispose]();
  }

  /**
   * Authorizes a read and commits its prepared observer state.
   * @param input Observation description without derived exclusions.
   * @param scope Data scope disclosed by the read.
   * @returns A promise that resolves after authorization commits.
   */
  async authorize(input: ObservationInput, scope: ObservationScope): Promise<void> {
    const check = await this.#prepare(scope);
    const exclude = check.excludeObservers;
    try {
      await this.#authorizer.authorizeObservation(
        exclude?.length ? { ...input, excludeObservers: exclude } : input);
    } catch (error) {
      // A marked refusal proves nothing was recorded, so prepared state is reclaimed; any other
      // failure leaves the outcome unknown, and durable fences stay.
      if (isObservationRefused(error)) check.discard?.();
      else check.abandon?.();
      throw error;
    }
    check.commit();
  }

  /**
   * Prepares observer exclusions for a scope.
   * @param scope Data scope disclosed by the read.
   * @returns Prepared observer state.
   */
  async #prepare(scope: ObservationScope): Promise<ObservationCheck> {
    switch (scope.kind) {
      case "baseline":
        return NOTHING_TO_RESOLVE;
      case "withholdFromObservers":
        return this.#strategy.prepareWithheld();
      case "collections":
        if (scope.ids.length === 0) {
          throw new Error(
            'An observation scope of kind "collections" needs at least one collection id; use ' +
            '{ kind: "baseline" } for a read the admission baseline covers.');
        }
        // Fail closed, as `prepareWithheld` already does for the mirror-image mismatch. Accepting
        // ids this strategy cannot check would report a per-collection decision nothing made.
        if (this.#strategy.aclChecks === "unsupported") {
          throw new Error(
            "This binding's strategy cannot enforce collection ACLs, so it must not be handed collection ids. " +
            'Track observed collections to enforce them, or declare the read { kind: "baseline" }.');
        }
        return (await this.#strategy.prepare?.(scope.ids)) ?? NOTHING_TO_RESOLVE;
    }
  }
}
