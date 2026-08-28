// The observer-verification contract (getVerifier/addObserver/removeObserver), as four
// interchangeable strategies, plus the gate that authorizes a read against the approval queue.

import type { RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  GatekeeperUserVerifier,
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
 * How a gatekeeper admits collaborators, and which of them a given observation must be hidden from.
 * A strategy without `prepare` reveals nothing an admitted observer cannot already see.
 */
export interface ObserverStrategy {
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  removeObserver(id: string): Promise<void>;
  prepare?(setIds: readonly string[]): Promise<ObservationCheck>;
  /**
   * Every observer retained by this binding; absent where none are. For inspection -- naming them
   * in a description, reporting them to an admin. A read that must be withheld from all of them
   * takes `prepareWithheld()` instead, which enumerates and fences in one step; a list taken from
   * here fences nothing, so an admission landing before the read reaches the overseer would be
   * absent from it.
   */
  observerIds?(): string[];
  /**
   * Reserves a read withheld from every observer. Required, so a strategy that cannot honour
   * owner-only disclosure refuses loudly instead of inheriting a silent no-exclusions default --
   * a misclassified strategy must not void the caller's per-read declaration.
   *
   * The returned check must name every observer the binding may yet owe an exclusion to,
   * candidates mid-admission included, and must fence admission durably until it settles: the gate
   * calls this and then awaits the overseer, whose record of the description is durable before the
   * reply -- a fence that dies with the activation reopens admission on a read that stands
   * recorded. Such a read registers no set, so nothing can later prove a candidate was entitled to
   * it -- on `commit` a gatekeeper is unshareable for good, which the kernel sanctions, and on
   * `discard` nothing was disclosed and nothing is owed.
   */
  prepareWithheld(): ObservationCheck;
}

/** B and D share every read with their admitted observers by their own premise, so an owner-only
 *  read contradicts the strategy choice rather than needing an empty exclusion list. */
function cannotWithhold(): never {
  throw new Error(
    "This binding's strategy shares every read with admitted observers; use a baseline scope, " +
    "or track observed sets to withhold a read.");
}

/** A: nothing this resource exposes may be shared. Admission always fails with `message`. */
export function privateObservers(message: string): ObserverStrategy {
  return {
    addObserver: async () => { throw new Error(message); },
    removeObserver: async () => {},
    // Vacuously owner-only: no observer is ever admitted, so there is nobody to exclude.
    prepareWithheld: () => NOTHING_TO_RESOLVE,
  };
}

/**
 * B: the resource is one ACL unit — an observer who can read it can read everything read here.
 *
 * The oracle answers rather than throws, which is the shape every verifier API in the corpus
 * already has; the denial text belongs to the binding, not to the check.
 */
export function aclObservers<V>(options: {
  hasAccess(verifier: V): Promise<boolean>;
  denyMessage?: string;
}): ObserverStrategy {
  return {
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

/** C: the binding spans sub-resources with distinct ACLs, so observed sets are tracked. */
export function trackedSetObservers<V>(options: ObserverTrackerOptions<V>): ObserverStrategy {
  const tracker = new ObserverTracker<V>(options);
  return {
    addObserver: (id, user) => tracker.addObserver(id, asVerifier<V>(user)),
    removeObserver: async id => tracker.removeObserver(id),
    prepare: setIds => tracker.prepareObservation(setIds),
    observerIds: () => tracker.observerIds(),
    prepareWithheld: () => tracker.prepareWithheld(),
  };
}

/** D: the data is public to anyone with the workspace, so every observer is admitted. */
export function openObservers(): ObserverStrategy {
  return {
    addObserver: async () => {},
    removeObserver: async () => {},
    prepareWithheld: cannotWithhold,
  };
}

/**
 * Flattens newlines and escapes Markdown control characters, for interpolating provider-controlled
 * text into an ObservationDescription. Whole-description escaping is consumer policy:
 * `description` is Markdown by contract, and this must not destroy deliberate structure.
 */
export function escapeObservationValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

/**
 * What a read is disclosing, so the gate can decide who must not see it.
 *
 * - `baseline`: the caller asserts the admission baseline already covers the disclosure. No oracle
 *   call, no exclusions.
 * - `sets`: per-set verification against every admitted observer.
 * - `withholdFromObservers`: disclose to nobody but the owner — for a read no set id describes,
 *   such as a search whose empty result is itself the disclosure.
 */
export type ObservationScope =
  | { kind: "baseline" }
  | { kind: "sets"; ids: readonly string[] }
  | { kind: "withholdFromObservers" };

/**
 * A description the gate completes: it owns `excludeObservers`, derived from the scope.
 *
 * `prohibitAllSharing` stays the caller's, and is passed through untouched: it puts the gadget into
 * lockdown for good rather than withholding one read, so no scope can imply it.
 */
export type ObservationInput = Omit<ObservationDescription, "excludeObservers">;

/**
 * Authorizes observations against the approval queue, folding in the strategy's exclusions and
 * promoting its newly-revealed sets only once the overseer has agreed to hide them.
 */
export class ObservationGate implements Disposable {
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #strategy: ObserverStrategy;

  /**
   * Takes ownership of `queue`, which must be a `.dup()`: the gate outlives `startSession`, and
   * whoever made the dup needs a way to release it.
   */
  constructor(queue: RpcStub<ApprovalQueue>, strategy: ObserverStrategy) {
    this.#queue = queue;
    this.#strategy = strategy;
  }

  /** Releases the duplicated queue stub. */
  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  /**
   * Authorize a read, naming what it discloses.
   *
   * A refusal discards the preparation: the read returns nothing, so it stands for no disclosure,
   * and no reservation it made may outlive it.
   */
  async authorize(input: ObservationInput, scope: ObservationScope): Promise<void> {
    const check = await this.#prepare(scope);
    const exclude = check.excludeObservers;
    try {
      await this.#queue.authorizeObservation(
        exclude?.length ? { ...input, excludeObservers: exclude } : input);
    } catch (error) {
      check.discard?.();
      throw error;
    }
    check.commit();
  }

  /**
   * A strategy without `prepare` retains no per-set verdicts, which is then no exclusions: B and D
   * admit only observers who see everything read here. `prepareWithheld` has no such default --
   * each strategy answers the owner-only question itself.
   */
  async #prepare(scope: ObservationScope): Promise<ObservationCheck> {
    switch (scope.kind) {
      case "baseline":
        return NOTHING_TO_RESOLVE;
      case "withholdFromObservers":
        return this.#strategy.prepareWithheld();
      case "sets":
        if (scope.ids.length === 0) {
          throw new Error(
            'An observation scope of kind "sets" needs at least one set id; use ' +
            '{ kind: "baseline" } for a read the admission baseline covers.');
        }
        return (await this.#strategy.prepare?.(scope.ids)) ?? NOTHING_TO_RESOLVE;
    }
  }
}
