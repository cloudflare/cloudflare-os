/** Observer-policy strategies and per-read authorization. */

import type { RpcStub } from "cloudflare:workers";
import type {
  Gatekeeper,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  asVerifier,
  DEFAULT_CONCURRENCY,
  mapLimit,
  NOTHING_TO_RESOLVE,
  OBSERVER_DENIED,
  ObserverTracker,
  type ObservationCheck,
  type ObserverTrackerOptions,
} from "./observer-tracker";
import { requirePositiveInt } from "./positive-int";

export {
  asVerifier,
  mapLimit,
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
 * Describes what a read discloses: the subresources the Workshop checks for it, or, for a binding
 * still on a legacy strategy, the admission baseline, the provider groupings whose ACLs govern it,
 * or nothing shareable at all. New gatekeepers use only `subresources`.
 *
 * A `collections` scope names provider-side access-controlled groupings — a space, a project, a
 * repo — not the individual rows returned. The gate refuses one under a strategy whose
 * `aclChecks` is `"unsupported"`, since ids nothing verifies would describe a check that never
 * ran; pick `trackedCollectionObservers` for a resource whose children carry their own ACLs, and
 * `baseline` where admission already covers the read. It also refuses a `collections` scope
 * naming none, so a read that returned nothing describes itself as `baseline`.
 *
 * A `subresources` scope reports the read's access dependencies as
 * `ObservationDescription.subresources`, and the Workshop checks collaborators against them
 * itself, through the gatekeeper's `verifyObserverAccess()` (see {@link observerAccessVerifier}).
 * The strategy takes no part, so the read adds nothing to the binding's tracked collections,
 * exclusions or fences, while the strategy's `addObserver()` keeps enforcing what earlier reads
 * recorded and every read still on another scope. Name every dependency the read has, including
 * any the admission baseline enforced (the bound resource's ACL, tenant membership), not only
 * those new to the binding, since the Workshop records them per chat or gadget; `[]` says nothing
 * restricts the read. An owner-only read stays on `withholdFromObservers` until the binding
 * reports an id its oracle grants only to the owner.
 */
export type ObservationScope =
  | { kind: "baseline" }
  | { kind: "collections"; ids: readonly string[] }
  | { kind: "withholdFromObservers" }
  | { kind: "subresources"; ids: readonly string[] };

/** Observation text, which the gate completes with derived exclusions or the scope's subresources. */
export type ObservationInput = Omit<ObservationDescription, "excludeObservers" | "subresources">;

/**
 * Authorizes observations for an existing binding: through its legacy observer strategy, or for a
 * `subresources` scope with the Workshop alone. New gatekeepers report subresources directly.
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
   * Releases the duplicated authorizer stub. Call it from the `[Symbol.dispose]` of the capability
   * or cursor that owns this gate, or when the call that took it fails before handing it over: the
   * Workshop counts the session's collaborator as live until every duplicate is released.
   */
  [Symbol.dispose](): void {
    this.#authorizer[Symbol.dispose]();
  }

  /**
   * Authorizes a read: through the strategy, committing its prepared observer state, or for a
   * `subresources` scope with the Workshop alone.
   * @param input Observation description without derived exclusions or subresources.
   * @param scope Data scope disclosed by the read.
   * @returns A promise that resolves after authorization commits.
   */
  async authorize(input: ObservationInput, scope: ObservationScope): Promise<void> {
    if (scope.kind === "subresources") {
      // The Workshop checks and records these itself, so there is no observer state to prepare or
      // settle, and a failure propagates as it came. Deduplicated here because the Workshop's
      // limits count ids before it deduplicates them.
      await this.#authorizer.authorizeObservation({ ...input, subresources: [...new Set(scope.ids)] });
      return;
    }
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
  async #prepare(scope: Exclude<ObservationScope, { kind: "subresources" }>): Promise<ObservationCheck> {
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

/** `Gatekeeper.verifyObserverAccess()`, as {@link observerAccessVerifier} implements it. */
export type VerifyObserverAccess = NonNullable<Gatekeeper<unknown>["verifyObserverAccess"]>;

/**
 * Implements `Gatekeeper.verifyObserverAccess()` over a batched ACL oracle, for a binding whose
 * reads report `subresources`, directly or through a `subresources` scope. Each observer is judged
 * by the verifier the Workshop passed with it, against every subresource, on every call. Nothing is
 * stored or cached, since the same observer id may come back with another account's verifier, and
 * nothing here waits on a read, which may itself be awaiting the authorization that asked.
 *
 * Each oracle call receives every subresource in the Workshop's call, up to 10,000 IDs. Split them
 * to fit the provider's per-request caps while staying within the Worker's subrequest limit. An
 * existing binding converting read by read can share its `trackedCollectionObservers` oracle, but
 * must not size this helper's batches from `maxTrackedCollections`; lowering that limit does not
 * shrink the tracker's persisted history either. IDs arrive exactly as reads reported them, so
 * report canonical spellings. Only a literal `true` grants, and an answer of the wrong length
 * throws, since index alignment is all that ties a verdict to an ID. Unlike the tracker, which
 * excludes an observer whose oracle throws, a throw here fails the whole call: no further verifier
 * is asked, and the call rejects with the first error once those already asked have settled. The
 * Workshop denies everyone in that call when access cannot be determined. The oracle must throw,
 * rather than answer `false`, when it cannot tell — expired credentials, a provider outage.
 * @param options ACL oracle and verifier concurrency (default 6).
 * @returns A `verifyObserverAccess()` implementation.
 */
export function observerAccessVerifier<V>(
  options: Pick<ObserverTrackerOptions<V>, "hasCollectionAccess" | "concurrency">,
): VerifyObserverAccess {
  const { hasCollectionAccess } = options;
  const concurrency = requirePositiveInt("concurrency", options.concurrency ?? DEFAULT_CONCURRENCY);
  return async (observers, subresources) => {
    // The Workshop never asks about none. Were it to, "every one of none" would admit everyone
    // without consulting anything, so refuse rather than answer vacuously.
    if (subresources.length === 0) throw new Error("There are no subresources to check access to.");
    const granted = await mapLimit(observers, concurrency, async ({ verifier }) => {
      // Copied per verifier: an oracle that chunks destructively would otherwise hand the next one
      // an emptied question, which every answer, and the length check below, would satisfy.
      const verdicts = await hasCollectionAccess(asVerifier<V>(verifier), subresources.slice());
      if (verdicts.length !== subresources.length) {
        throw new Error("An access check answered for a different number of subresources than it was asked about.");
      }
      return subresources.every((_, index) => verdicts[index] === true);
    });
    return { allowedObserverIds: observers.filter((_, index) => granted[index]).map(({ id }) => id) };
  };
}
