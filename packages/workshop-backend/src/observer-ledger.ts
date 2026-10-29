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

import type { CollaboratorRole, WorkpieceId } from "@gadgets/workshop-shared/api";
import type {
  Gatekeeper, GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectionVendorId, observerContextOf, observerRequirementPrefix, observerRequirementSubresource,
  type ActionRecord, type GatekeeperCaller, type GatekeeperRecord, type ObserverContext,
  type ObserverRecord, type OverseerStorage,
} from "./storage-schema/overseer-storage";
import type { SharingManager } from "./sharing";
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

// Budget only the ID array: two bytes per UTF-16 code unit plus serialization overhead per
// element. Leave ample room for the action's metadata below SQLite's 8 MiB row limit.
const SUBRESOURCE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Most observers sent to `verifyObserverAccess()` in one call, bounding the verifier fan-out each
 * call asks of the gatekeeper (gatekeeper-kit caps a binding's per-read fan-out the same way).
 */
const CHECK_OBSERVER_BATCH_SIZE = 10;

/** Most verifier lookups, or `verifyObserverAccess()` calls, in flight at once for one check. */
const CHECK_CONCURRENCY = 4;

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

/** What a collaborator holding some role is verified against (see ObserverLedger.observerScope). */
export type ObserverScope = {
  gatekeepers: GatekeeperRecord[];
  requirements: Map<WorkpieceId, string[]>;
  /**
   * `nextActionId` when `requirements` was read. The append-only action log is the only
   * requirement store and only a new record adds one, so while this is unchanged, so are the
   * requirements of unchanged connections.
   */
  nextActionId: number;
};

// Whether two scopes hold the same connections.
function sameConnections(a: GatekeeperRecord[], b: GatekeeperRecord[]): boolean {
  let ids = new Set(a.map(gk => gk.id));
  return b.length === ids.size && b.every(gk => ids.has(gk.id));
}

/**
 * Whether a verification pass over `verified` also covers `current`: the same connections, and no
 * requirement the pass did not check.
 */
export function observerScopeCovers(verified: ObserverScope, current: ObserverScope): boolean {
  if (!sameConnections(verified.gatekeepers, current.gatekeepers)) return false;
  return current.requirements === verified.requirements ||
      Array.from(current.requirements).every(([id, subresources]) => {
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
  // for...of visits a sparse array's holes as undefined, which this refuses too.
  for (let id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_SUBRESOURCE_LENGTH) {
      throw new Error(
          `Subresource IDs must be strings 1 to ${MAX_SUBRESOURCE_LENGTH} characters long.`);
    }
    if (!id.isWellFormed()) throw new Error("Subresource IDs must be well-formed Unicode.");
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

  /**
   * Persists an observation as byte-bounded requirement records, returning their action IDs.
   * The caller must include this and any policy changes in one storage transaction, and publish
   * notifications only after it commits. Verification must already cover the complete read.
   */
  recordObservation(record: Omit<Extract<ActionRecord, {type: "observation"}>, "id">): number[] {
    let subresources = record.description.subresources;
    let count = subresources?.length ?? 0;
    let actionIds: number[] = [];
    let start = 0;
    do {
      let end = start;
      let bytes = 0;
      while (end < count) {
        let size = 2 * subresources![end].length + 8;
        if (bytes + size > SUBRESOURCE_CHUNK_BYTES) break;
        bytes += size;
        end++;
      }
      let id = this.#storage.nextActionId.get();
      this.#storage.nextActionId.put(id + 1);
      this.#storage.actions.put({
        ...record, id,
        description: subresources && (start !== 0 || end !== subresources.length)
            ? {...record.description, subresources: subresources.slice(start, end)}
            : record.description,
      });
      actionIds.push(id);
      start = end;
    } while (start < count);
    return actionIds;
  }

  // ---------------------------------------------------------------------------------------
  // Observation

  /**
   * The ledger half of Overseer.authorizeObservation(). An observation omitting `subresources`,
   * or made while its resource's creation is pending (so simulated), is checked by nothing here:
   * it commits with undefined, recording no requirement. Otherwise this attributes the read to
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
        let observers: ObserverVerifier[] = [];
        await boundedAll(unverified, async ({profileId, observerId, accountId}) => {
          let user = this.host.users.get(this.host.users.idFromName(profileId));
          observers.push({id: observerId, verifier: await requireVerifier(user, accountId, vendorId)});
        });
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

  // Observers without a choice for this connection have had no session since it entered their
  // role's verification scope (every widening restarts the workspace), and their next admission
  // checks everything. A "use" collaborator outside that scope (nothing binds or hooks the
  // connection) usually has no choice and goes unchecked, as under the legacy protocol; a choice
  // left from an earlier binding is still checked, which can only refuse more.
  #audience(sharing: SharingManager, context: ObserverContext,
            gatekeeperId: WorkpieceId): ObservationRecipient[] {
    let effective = sharing.computeEffectiveRoles();
    let audience: ObservationRecipient[] = [];
    for (let observer of this.#storage.observers.list()) {
      let role = effective.get(observer.profileId);
      let accountId = observer.accountChoices[gatekeeperId];
      if (role !== undefined && (context.type !== "chat" || role === "build") &&
          accountId !== undefined) {
        let {profileId, observerId} = observer;
        audience.push({
          profileId, observerId, accountId,
          key: JSON.stringify([profileId, observerId, accountId]),
        });
      }
    }
    return audience;
  }

  // ---------------------------------------------------------------------------------------
  // Admission

  /**
   * The deduplicated subresources a collaborator holding `role` must be able to read through each
   * connection in `connections`, the role's verification scope: a "build" collaborator reaches
   * every context, a "use" collaborator the workspace and every gadget. Reads only the distinct
   * requirement keys, never the observations recorded under them. `connections` are live
   * records, so nothing through a connection since removed is read. Connections with no
   * requirements are left out.
   */
  requiredSubresources(role: CollaboratorRole,
                       connections: GatekeeperRecord[]): Map<WorkpieceId, string[]> {
    let index = this.#storage.actions.byObserverRequirement;
    let contexts: ObserverContext["type"][] =
        role === "build" ? ["workspace", "chat", "gadget"] : ["workspace", "gadget"];
    let required = new Map<WorkpieceId, string[]>();
    for (let connection of connections) {
      let ids = new Set<string>();
      for (let type of contexts) {
        for (let key of index.listKeys({prefix: observerRequirementPrefix(connection.id, type)})) {
          ids.add(observerRequirementSubresource(key));
        }
      }
      if (ids.size > 0) required.set(connection.id, [...ids]);
    }
    return required;
  }

  /**
   * Everything a collaborator holding `role` is verified against: `gatekeepers`, the role's
   * verification scope, and the requirements recorded through them that the role reaches (see
   * requiredSubresources()). Reuses `previous`'s requirements while neither its connections nor
   * `nextActionId` have changed, so an admission nothing disturbs reads them once.
   */
  observerScope(role: CollaboratorRole, gatekeepers: GatekeeperRecord[],
                previous?: ObserverScope): ObserverScope {
    let nextActionId = this.#storage.nextActionId.get();
    let requirements = previous?.nextActionId === nextActionId &&
        sameConnections(previous.gatekeepers, gatekeepers)
        ? previous.requirements
        : this.requiredSubresources(role, gatekeepers);
    return {gatekeepers, requirements, nextActionId};
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
      await boundedAll(chunks, async chunk => {
        for (let id of await askGatekeeper(facet, chunk, batch)) denied.add(id);
      });
    }
    return [...denied];
  }
}

// One verifyObserverAccess() call, returning the IDs of the observers it denied: every one its
// answer omits. A failed call or malformed answer throws, which denies every observer in it.
async function askGatekeeper(facet: VerifyingGatekeeper, observers: ObserverVerifier[],
                             subresources: string[]): Promise<string[]> {
  let result: unknown;
  try {
    result = await facet.verifyObserverAccess(observers, subresources);
  } catch (error) {
    throw new Error("This service could not confirm the account's access.", {cause: error});
  }
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

// Promise.all over `items` with at most CHECK_CONCURRENCY in flight; rejects with the first
// failure (the rest still settle, their results unused).
async function boundedAll<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: {error: unknown} | undefined;
  let worker = async () => {
    while (next < items.length && failure === undefined) {
      let item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= {error};
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(CHECK_CONCURRENCY, items.length)}, worker));
  if (failure !== undefined) throw failure.error;
}
