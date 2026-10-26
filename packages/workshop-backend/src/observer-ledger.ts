// Kernel-owned observer requirements: the subresources observations report through
// ObservationDescription.subresources. docs/observers.md §10 describes the behavior and
// plans/kernel-observer-tracking.md the reasons for it; this comment covers only what the code
// here must keep true:
//
// - Requirements live only in the action log: an observation that kept `subresources` is one,
//   attributed to a context by its caller (observerContextOf). A read must never commit without
//   its record, nor a record land without its check.
// - Every check fails closed, and no permission is cached between operations.
// - Each decision is confirmed synchronously before its caller publishes it: an observation's
//   audience before the audit record is written (authorizeObservation), and an admission's
//   scope before the observer record is (OverseerImpl.ensureObserver, via observerScope()).
// - These checks add to the legacy addObserver()/removeObserver()/excludeObservers protocol and
//   never replace it: an observation omitting `subresources` is checked by nothing here, and
//   admission runs every connection's addObserver() as well as the checks here.

import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type {
  Gatekeeper, GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectionVendorId, observerContextOf, observerRequirementPrefix, observerRequirementSubresource,
  type GatekeeperCaller, type GatekeeperRecord, type ObserverContext, type ObserverRecord,
  type OverseerStorage,
} from "./storage-schema/overseer-storage";
import { accessIncludesGadget, type SharingManager } from "./sharing";
import type { UserDurableObject } from "./user";
import type { WorkshopLogger } from "./observability";

/**
 * Most subresource IDs one observation or one `verifyObserverAccess()` call may carry; a
 * connection's accumulated requirements have no count cap, so admission checks them in batches of
 * this size.
 */
const MAX_SUBRESOURCES = 10_000;

/** Longest subresource ID accepted. */
const MAX_SUBRESOURCE_LENGTH = 512;

/**
 * Most UTF-16 code units one observation's subresource IDs may total, so its audit record stays
 * well inside Durable Object storage's 2 MB value limit (at most two bytes per code unit).
 */
const MAX_SUBRESOURCES_TOTAL_LENGTH = 500_000;

/**
 * Most observers sent to `verifyObserverAccess()` in one call, bounding the verifier fan-out each
 * call asks of the gatekeeper (gatekeeper-kit caps a binding's per-read fan-out the same way).
 */
const CHECK_OBSERVER_BATCH_SIZE = 10;

/**
 * How many times an admission or an observation re-runs its checks because what it must verify
 * changed while they were in flight, before it gives up with a retryable error.
 */
export const MAX_VERIFICATION_PASSES = 3;

/** Why a read was refused when a collaborator's access to it could not be confirmed. */
const OBSERVATION_REFUSED =
    "This was blocked because it contains data that a current collaborator could not be " +
    "confirmed to have access to.";

// A gatekeeper whose observations report subresources promises it (see
// ObservationDescription.subresources). RPC stubs can't report method presence, and their typing
// makes an optional method uncallable, hence this narrowed view.
type VerifyingGatekeeper =
    Fetcher<Gatekeeper<any> & Required<Pick<Gatekeeper<any>, "verifyObserverAccess">>>;

/** The observer identity and selected account reached by one observation. */
type ObservationRecipient = Pick<ObserverRecord, "profileId" | "observerId"> & {
  accountId: number;

  /** Identifies this recipient's check: a changed account choice must be checked again. */
  key: string;
};

/** One observer to check, with the verifier for the account they chose for the connection. */
type ObserverVerifier = {id: string, verifier: Fetcher<GatekeeperUserVerifier>};

/** What a collaborator holding some grant is verified against (see ObserverLedger.observerScope). */
export type ObserverScope = {
  gatekeepers: GatekeeperRecord[];
  /**
   * The gadgets whose contexts `requirements` were read from, for a gadget grant; undefined for
   * "build", which reads every context.
   */
  gadgetIds?: ReadonlySet<WorkpieceId>;
  requirements: Map<WorkpieceId, string[]>;
};

/**
 * Whether a verification pass over `verified` also covers `current`: the same connections, and no
 * requirement the pass did not check.
 */
export function observerScopeCovers(verified: ObserverScope, current: ObserverScope): boolean {
  if (verified.gadgetIds?.size !== current.gadgetIds?.size ||
      (current.gadgetIds && [...current.gadgetIds].some(id => !verified.gadgetIds?.has(id)))) {
    return false;
  }
  let verifiedIds = new Set(verified.gatekeepers.map(gk => gk.id));
  if (current.gatekeepers.length !== verifiedIds.size ||
      !current.gatekeepers.every(gk => verifiedIds.has(gk.id))) {
    return false;
  }
  return Array.from(current.requirements).every(([id, subresources]) => {
    let checked = new Set(verified.requirements.get(id));
    return subresources.every(subresource => checked.has(subresource));
  });
}

/**
 * What the ledger needs from the Overseer, which satisfies this structurally and passes itself
 * (as with OverseerMigrationHost).
 */
export interface ObserverLedgerHost {
  storage: OverseerStorage;
  logger: WorkshopLogger;
  users: DurableObjectNamespace<UserDurableObject>;
  getSharingManager(): Promise<SharingManager>;
  getGatekeeperFacet(id: number): Promise<Fetcher<Gatekeeper<any>>>;
  creationPending(id: WorkpieceId): boolean;

  /** Throws (retryably) while the connection is held back pending a restart. */
  assertGatekeeperUsable(id: number): void;

  /** Whether `executionId` is the executeCode invocation still running for `chatId`. */
  isLiveExecution(chatId: number, executionId: string): boolean;

  /**
   * The gadgets whose holders can read what gadget `gadgetId` reads: itself, if it can be opened,
   * and any gadget that reaches it through an agent spawner.
   */
  gadgetsReaching(gadgetId: WorkpieceId): WorkpieceId[];
}

/**
 * The verifier for `accountId` in `user`'s own User DO. Throws if the account is gone, with the
 * reason the user sees, or belongs to another vendor (getVerifier's own error).
 */
export async function requireVerifier(user: DurableObjectStub<UserDurableObject>,
                                      accountId: number, vendorId: string) {
  let verifier = await user.getVerifier(accountId, vendorId);
  if (!verifier) throw new Error("This account is no longer connected.");
  return verifier;
}

/**
 * Validates one observation's reported subresource IDs (the RPC layer has checked they form a
 * string array), and deduplicates them without interpreting them. Each must be well-formed
 * Unicode: requirement keys hold them, and storage would replace a lone surrogate, merging
 * distinct IDs and checking a different one at admission.
 */
export function normalizeSubresources(ids: string[]): string[] {
  if (ids.length > MAX_SUBRESOURCES) {
    throw new Error(`An observation may report at most ${MAX_SUBRESOURCES} subresources.`);
  }
  let totalLength = 0;
  for (let id of ids) {
    if (id.length === 0 || id.length > MAX_SUBRESOURCE_LENGTH) {
      throw new Error(
          `Subresource IDs must be strings 1 to ${MAX_SUBRESOURCE_LENGTH} characters long.`);
    }
    if (!id.isWellFormed()) throw new Error("Subresource IDs must be well-formed Unicode.");
    totalLength += id.length;
  }
  if (totalLength > MAX_SUBRESOURCES_TOTAL_LENGTH) {
    throw new Error(
        `An observation's subresource IDs may total at most ${MAX_SUBRESOURCES_TOTAL_LENGTH} ` +
        "characters.");
  }
  return [...new Set<string>(ids)];
}

/**
 * The Overseer's observer requirements: the subresources observations reported, checked against
 * each read's audience before it commits and against each collaborator at admission.
 */
export class ObserverLedger {
  constructor(private host: ObserverLedgerHost) {}

  get #storage() { return this.host.storage; }

  // ---------------------------------------------------------------------------------------
  // Observation

  /**
   * The ledger half of Overseer.authorizeObservation(). Every observation through a removed
   * connection, or one held back pending a restart, is refused. One omitting `subresources`, or
   * made while its resource's creation is pending (so simulated), is otherwise checked by nothing
   * here: it commits with undefined, recording no requirement. Otherwise this attributes the read to
   * its caller's context and checks the reported IDs for everyone that context reaches, then
   * recomputes that audience after the awaits and checks whoever it gained: sharing changes,
   * newly published observers, and changed account choices. Calls `commit` synchronously with the
   * validated IDs at the final decision, so no admission can publish between the audience check
   * and the audit write; resolving a promise first would let one publish before the caller writes
   * the requirement. The callback must not await.
   */
  async authorizeObservation(
      gatekeeperId: WorkpieceId, description: ObservationDescription,
      caller: GatekeeperCaller, executionId: string | undefined,
      commit: (subresources: string[] | undefined) => undefined): Promise<void> {
    this.#assertUsable(gatekeeperId);
    if (description.subresources === undefined || this.host.creationPending(gatekeeperId)) {
      return commit(undefined);
    }

    // Attributed to the trusted binding authorizer's caller, not its holder or a gatekeeper-
    // supplied ID: passing that capability elsewhere does not change its context. A hook firing
    // is attributed to the gadget its record says it wakes.
    let context = observerContextOf(caller);
    if (context === undefined) {
      throw new Error("This observation has no attributable chat or gadget.");
    }
    let subresources = normalizeSubresources(description.subresources);
    if (subresources.length === 0) {
      this.#assertLive(gatekeeperId, caller, executionId);
      return commit(subresources);
    }

    let connection = this.#storage.gatekeepers.get(gatekeeperId)!;
    let vendorId = connectionVendorId(connection)!;
    let sharing = await this.host.getSharingManager();
    let verified = new Set<string>();
    for (let pass = 0; ; pass++) {
      this.#assertLive(gatekeeperId, caller, executionId);
      let unverified = this.#audience(sharing, context, gatekeeperId)
          .filter(observer => !verified.has(observer.key));
      if (unverified.length === 0) return commit(subresources);
      if (pass > MAX_VERIFICATION_PASSES) {
        throw new Error(
            "Collaborators' access kept changing while this was being checked. Please retry.");
      }
      let denied: string[];
      try {
        // Looked up for every observer even when one would do: a disconnected account is refused.
        let observers = await Promise.all(unverified.map(async observer => {
          let user = this.host.users.get(this.host.users.idFromName(observer.profileId));
          let verifier = await requireVerifier(user, observer.accountId, vendorId);
          return {id: observer.observerId, verifier};
        }));
        denied = await this.#deniedObservers(connection, observers, subresources);
      } catch (error) {
        this.host.logger.warn("observer check refused an observation", {
          event: "observer.ledger.observation.refused", gatekeeperId, error,
        });
        throw new Error(OBSERVATION_REFUSED, {cause: error});
      }
      if (denied.length > 0) {
        for (let observerId of denied) {
          this.host.logger.warn("observer check refused an observation", {
            event: "observer.ledger.observation.refused", gatekeeperId, observerId,
          });
        }
        throw new Error(OBSERVATION_REFUSED);
      }
      for (let observer of unverified) verified.add(observer.key);
    }
  }

  // Refuses authorization through a removed connection, or one held back.
  #assertUsable(gatekeeperId: WorkpieceId): void {
    if (!this.#storage.gatekeepers.get(gatekeeperId)) {
      throw new Error("This connection has been removed from the workspace.");
    }
    this.host.assertGatekeeperUsable(gatekeeperId);
  }

  // #assertUsable(), and refuses an agent session whose executeCode invocation has ended.
  #assertLive(gatekeeperId: WorkpieceId, caller: GatekeeperCaller,
              executionId: string | undefined): void {
    this.#assertUsable(gatekeeperId);
    if (caller.from === "agent" &&
        (executionId === undefined || !this.host.isLiveExecution(caller.chatId, executionId))) {
      throw new Error(
          "This observation was blocked: the code execution its session belongs to has ended.");
    }
  }

  // Everyone who can see what `context` reads: "build" collaborators always, anyone with access
  // for a workspace read (which every chat and gadget includes), and for a gadget's read, those
  // whose access includes a gadget that reaches it -- whether or not they have opened that gadget.
  //
  // Observers without a choice for this connection have had no session holding anything whose
  // verification scope it entered since (every widening restarts the sessions holding what
  // widened), and their next admission checks everything. A collaborator whose gadgets don't
  // reach the connection usually has no choice and goes unchecked, as under the legacy protocol;
  // a choice left from an earlier binding, or another gadget, is still checked, which can only
  // refuse more.
  #audience(sharing: SharingManager, context: ObserverContext,
            gatekeeperId: WorkpieceId): ObservationRecipient[] {
    let effective = sharing.computeEffectiveAccess();
    // Who can read a gadget's state is needed only for a "use" observer of a gadget's read, and
    // finding out walks every gadget's reach, so it is resolved at most once, on demand.
    let readers: WorkpieceId[] | undefined;
    let audience: ObservationRecipient[] = [];
    // Listed up front: resolving readers lists other collections, which would end this listing.
    for (let observer of Array.from(this.#storage.observers.list())) {
      let access = effective.get(observer.profileId);
      let accountId = observer.accountChoices[gatekeeperId];
      if (access === undefined || accountId === undefined) continue;
      if (access.role !== "build" && context.type !== "workspace") {
        if (context.type === "chat") continue;
        readers ??= this.host.gadgetsReaching(context.gadgetId);
        if (!readers.some(gadgetId => accessIncludesGadget(access, gadgetId))) continue;
      }
      let {profileId, observerId} = observer;
      audience.push({
        profileId, observerId, accountId,
        key: JSON.stringify([profileId, observerId, accountId]),
      });
    }
    return audience;
  }

  // ---------------------------------------------------------------------------------------
  // Admission

  /**
   * The deduplicated subresources a collaborator must be able to read through each connection
   * in `connections`, their verification scope: a "build" collaborator reaches every context;
   * one opening a gadget, the workspace and the gadgets `reach` names (see
   * OverseerImpl.#gadgetReach). Reads only distinct requirement keys, never the observations
   * recorded under them. `connections` are live records, so nothing through a removed connection
   * is read.
   */
  requiredSubresources(reach: "build" | Iterable<WorkpieceId>,
                       connections: GatekeeperRecord[]): Map<WorkpieceId, string[]> {
    let index = this.#storage.actions.byObserverRequirement;
    let contexts: (ObserverContext | ObserverContext["type"])[] = reach === "build"
        ? ["workspace", "chat", "gadget"]
        : ["workspace", ...Array.from(reach, gadgetId => ({type: "gadget" as const, gadgetId}))];
    let requirements = new Map<WorkpieceId, string[]>();
    for (let connection of connections) {
      let ids = new Set<string>();
      for (let context of contexts) {
        let prefix = observerRequirementPrefix(connection.id, context);
        for (let key of index.listKeys({prefix})) ids.add(observerRequirementSubresource(key));
      }
      if (ids.size > 0) requirements.set(connection.id, [...ids]);
    }
    return requirements;
  }

  /**
   * Everything a collaborator is verified against: `gatekeepers`, their verification scope,
   * and the requirements recorded through them in the contexts `reach` names (see
   * requiredSubresources()).
   */
  observerScope(reach: "build" | ReadonlySet<WorkpieceId>,
                gatekeepers: GatekeeperRecord[]): ObserverScope {
    let gadgetIds = reach === "build" ? undefined : reach;
    return {gatekeepers, gadgetIds, requirements: this.requiredSubresources(reach, gatekeepers)};
  }

  /**
   * The connections through which any of `gadgetIds` recorded requirements. A gadget's state may
   * hold what it read through one whether or not it still binds it, so whoever opens it is
   * verified against these too.
   */
  gadgetProducers(gadgetIds: Iterable<WorkpieceId>): WorkpieceId[] {
    let index = this.#storage.actions.byObserverRequirement;
    let contexts = Array.from(gadgetIds, gadgetId => ({type: "gadget" as const, gadgetId}));
    let recorded = (prefix: string) => {
      for (let _ of index.listKeys({prefix, limit: 1})) return true;
      return false;
    };
    // Listed up front: each probe lists the index, which would end this listing.
    return Array.from(this.#storage.gatekeepers.list())
        .filter(connection => contexts.some(
            context => recorded(observerRequirementPrefix(connection.id, context))))
        .map(connection => connection.id);
  }

  /**
   * Check that the account `verifier` stands for can read `subresources` through `connection`,
   * asking the connection about observer `observerId`. Throws, with a reason for the user, on any
   * refusal: missing method, failed call, malformed result, or denial.
   */
  async checkAccess(verifier: Fetcher<GatekeeperUserVerifier>, observerId: string,
                    connection: GatekeeperRecord, subresources: string[]): Promise<void> {
    let denied = await this.#deniedObservers(
        connection, [{id: observerId, verifier}], subresources);
    if (denied.length > 0) {
      throw new Error(
          "This account can't access some of the data this workspace read through this " +
          "service.");
    }
  }

  // Asks the connection's verifyObserverAccess() about `subresources` for `observers`, in bounded
  // batches. Returns the IDs of the observers denied by the first batch that denies anyone.
  // Throws if the gatekeeper fails to answer or answers malformed.
  async #deniedObservers(connection: GatekeeperRecord, observers: ObserverVerifier[],
                         subresources: string[]): Promise<string[]> {
    let chunks: ObserverVerifier[][] = [];
    for (let i = 0; i < observers.length; i += CHECK_OBSERVER_BATCH_SIZE) {
      chunks.push(observers.slice(i, i + CHECK_OBSERVER_BATCH_SIZE));
    }
    let facet = await this.host.getGatekeeperFacet(connection.id) as VerifyingGatekeeper;
    let denied = new Set<string>();
    for (let i = 0; i < subresources.length && denied.size === 0; i += MAX_SUBRESOURCES) {
      let batch = subresources.slice(i, i + MAX_SUBRESOURCES);
      await Promise.all(chunks.map(async chunk => {
        for (let id of await askGatekeeper(facet, chunk, batch)) denied.add(id);
      }));
    }
    return [...denied];
  }
}

// One verifyObserverAccess() call, returning the IDs of the observers it denied: every one its
// answer omits. A failed call or malformed answer throws, which denies every observer in it.
async function askGatekeeper(facet: VerifyingGatekeeper, observers: ObserverVerifier[],
                             subresources: string[]): Promise<string[]> {
  let result: unknown = await facet.verifyObserverAccess(observers, subresources);
  let allowed = typeof result === "object" && result !== null && "allowedObserverIds" in result
      ? result.allowedObserverIds : undefined;
  if (!Array.isArray(allowed)) throw new Error("This service returned an invalid access check.");
  let asked = new Set(observers.map(observer => observer.id));
  let granted = new Set<string>();
  // for...of visits a sparse array's holes as undefined, so they are malformed too.
  for (let id of allowed) {
    if (typeof id !== "string" || !asked.has(id)) {
      throw new Error("This service returned an invalid access check.");
    }
    granted.add(id);
  }
  return [...asked].filter(id => !granted.has(id));
}
