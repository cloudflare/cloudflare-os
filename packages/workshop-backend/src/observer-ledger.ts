// Kernel-owned observer tracking for connections that advertise
// ResourceDescription.supportsObserverTracking. docs/observers.md §10 describes the behavior and
// plans/kernel-observer-tracking.md the reasons for it; this comment covers only what the code
// here must keep true:
//
// - Requirements live only in the action log: an observation that kept `subresources` is one,
//   attributed to a context by its caller (observerContextOf). A read must never commit without
//   its record, nor a record land without its check.
// - Every check fails closed, and no permission is cached between operations.
// - Each decision is confirmed synchronously before its caller publishes it: an observation's
//   audience before the audit record is written (authorizeTrackedObservation), and an admission's
//   scope before the observer record is (OverseerImpl.ensureObserver, via observerScope()).
// - Legacy connections never reach these checks: their addObserver()/removeObserver()/
//   excludeObservers protocol is untouched, and a workspace may mix both.
// - A connection switches to tracking before its legacy history is imported, so no read through
//   it goes unchecked; until that import commits (observerHistoryPending), admission waits for it
//   rather than verify anyone against an incomplete history. Reads never wait for it.

import type { CollaboratorRole, WorkpieceId } from "@gadgets/workshop-shared/api";
import type {
  Gatekeeper, GatekeeperUserVerifier, ObservationDescription, ResourceDescription,
  TrackedObservationDescription,
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
 * Most subresource IDs one observation or one `verifyObserverAccess()` call may carry; accumulated
 * history has no count cap, so admission checks it in batches of this size.
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

// The gatekeeper as an opted-in connection promises it (see
// ResourceDescription.supportsObserverTracking). RPC stubs can't report method presence, and
// their typing makes an optional method uncallable, hence this narrowed view.
type TrackingGatekeeper = Fetcher<Gatekeeper<any> &
    Required<Pick<Gatekeeper<any>, "getHistoricalSubresources" | "verifyObserverAccess">>>;

/** The observer identity and selected account reached by one observation. */
type ObservationRecipient = Pick<ObserverRecord, "profileId" | "observerId"> & {
  accountId: number;

  /** Identifies this recipient's check: a changed account choice must be checked again. */
  key: string;
};

/** One observer to check, with the account they chose for the connection being checked. */
type ObserverAccount = {
  observerId: string;
  user: DurableObjectStub<UserDurableObject>;
  accountId: number;
};

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

// A connection's observer protocol as admission verifies it: legacy, tracked while its history is
// still being imported, or tracked.
function observerProtocol(gk: GatekeeperRecord): string {
  if (!gk.observerTracking) return "legacy";
  return gk.observerHistoryPending ? "importing" : "tracked";
}

// Whether two scopes hold the same connections, each on the same observer protocol.
function sameObserverConnections(a: GatekeeperRecord[], b: GatekeeperRecord[]): boolean {
  let protocols = new Map(a.map(gk => [gk.id, observerProtocol(gk)]));
  return b.length === protocols.size && b.every(gk => protocols.get(gk.id) === observerProtocol(gk));
}

/**
 * Whether a verification pass over `verified` also covers `current`: the same connections, each
 * on the same observer protocol, and no tracked requirement the pass did not check.
 */
export function observerScopeCovers(verified: ObserverScope, current: ObserverScope): boolean {
  if (!sameObserverConnections(verified.gatekeepers, current.gatekeepers)) return false;
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
  ctx: DurableObjectState;
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

  /** Best-effort removal of every legacy observer registration on `gatekeeperId`. */
  retireLegacyObserverRegistrations(gatekeeperId: WorkpieceId): Promise<void>;
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
 * Validates one observation's, or a historical export's, reported subresource IDs (the RPC layer
 * has checked an observation's are strings, but not an export's), at most `max` of them, and
 * deduplicates them without interpreting them. Each must be well-formed Unicode: requirement keys
 * hold them, and storage would replace a lone surrogate, merging distinct IDs and checking a
 * different one at admission.
 */
export function normalizeSubresources(ids: unknown, max = Infinity): string[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
    throw new Error("Subresources must be a list of strings.");
  }
  if (ids.length > max) {
    throw new Error(`An observation may report at most ${max} subresources.`);
  }
  for (let id of ids) {
    if (id.length === 0 || id.length > MAX_SUBRESOURCE_LENGTH) {
      throw new Error(
          `Subresource IDs must be 1 to ${MAX_SUBRESOURCE_LENGTH} characters long.`);
    }
    if (!id.isWellFormed()) throw new Error("Subresource IDs must be well-formed Unicode.");
  }
  return [...new Set<string>(ids)];
}

/** The observer ledger of one workspace. See the module comment. */
export class ObserverLedger {
  // In-flight switches to tracking, one per connection (see switchToTracking()).
  #switching = new Map<WorkpieceId, Promise<boolean>>();

  // In-flight historical imports, one per connection (see importHistory()).
  #importing = new Map<WorkpieceId, Promise<void>>();

  constructor(private host: ObserverLedgerHost) {}

  get #storage() { return this.host.storage; }

  /** Whether the Workshop tracks this existing connection's observations itself. */
  isTracked(gatekeeperId: WorkpieceId): boolean {
    return this.#storage.gatekeepers.get(gatekeeperId)?.observerTracking === true;
  }

  // ---------------------------------------------------------------------------------------
  // Connection lifecycle

  /**
   * Called by addGatekeeper() with a connection's first description, before its record is
   * published: a connection advertising support from creation has read nothing yet, so it starts
   * tracked with no history. Mutates `record`; the caller puts it.
   */
  adoptCreatedConnection(record: GatekeeperRecord, description: ResourceDescription): void {
    if (!description.supportsObserverTracking) return;
    if (!connectionVendorId(record)) {
      throw new Error("Only a vendor's connections can opt into observer tracking.");
    }
    record.observerTracking = true;
  }

  /**
   * Describe a legacy connection and, if it now advertises support, switch it to tracking at once,
   * with its history pending (see importHistory(), started here in the background). Called when a
   * read through it calls authorizeTrackedObservation() and when its addObserver() refuses a
   * collaborator (see OverseerImpl.ensureObserver), both of which an upgraded gatekeeper does.
   * Single-flight per connection. Returns whether the connection is tracked afterwards: false for
   * a vendorless one, a pending creation (simulated, so nothing to track until it is approved), or
   * one still legacy. Throws if it can't be described or has been removed, so a failed discovery
   * never leaves it to the legacy protocol it has upgraded from.
   */
  switchToTracking(gatekeeperId: WorkpieceId): Promise<boolean> {
    if (this.isTracked(gatekeeperId)) return Promise.resolve(true);
    let pending = this.#switching.get(gatekeeperId);
    if (pending === undefined) {
      pending = this.#switch(gatekeeperId).finally(() => this.#switching.delete(gatekeeperId));
      this.#switching.set(gatekeeperId, pending);
    }
    return pending;
  }

  async #switch(gatekeeperId: WorkpieceId): Promise<boolean> {
    let record = this.#storage.gatekeepers.get(gatekeeperId);
    if (!connectionVendorId(record) || this.host.creationPending(gatekeeperId)) return false;

    let description: ResourceDescription;
    try {
      description = await (await this.host.getGatekeeperFacet(gatekeeperId)).describe();
    } catch (error) {
      throw new Error(
          "This connection could not confirm its observer tracking protocol, so it can't be " +
          "used right now. Please retry.", {cause: error});
    }
    if (!description.supportsObserverTracking) return false;

    record = this.#storage.gatekeepers.get(gatekeeperId);
    if (!record) throw new Error("This connection has been removed from the workspace.");
    // From here every observation through it is checked and recorded here, and the legacy
    // protocol refuses it; the history import covers everything read before.
    this.#storage.gatekeepers.put({...record, observerTracking: true, observerHistoryPending: true});
    this.host.logger.info("switched connection to observer tracking", {
      event: "observer.ledger.switch.completed", gatekeeperId,
    });
    this.host.ctx.waitUntil(this.importHistory(gatekeeperId).catch(error => {
      this.host.logger.warn("failed to import connection history", {
        event: "observer.ledger.import.failed", gatekeeperId, error,
      });
    }));
    return true;
  }

  /**
   * Import the history of a connection that switched to tracking after creation: the
   * requirements its gatekeeper recorded under the legacy protocol. Single-flight per connection;
   * resolves at once when none is pending. Observations through the connection carry on
   * meanwhile, recording their own requirements, so the import only adds records. A failure
   * commits nothing and leaves the history pending, so the next admission that needs it exports
   * again; after the commit, the export is never asked for again.
   */
  importHistory(gatekeeperId: WorkpieceId): Promise<void> {
    if (!this.#storage.gatekeepers.get(gatekeeperId)?.observerHistoryPending) {
      return Promise.resolve();
    }
    let pending = this.#importing.get(gatekeeperId);
    if (pending === undefined) {
      pending = this.#import(gatekeeperId).finally(() => this.#importing.delete(gatekeeperId));
      this.#importing.set(gatekeeperId, pending);
    }
    return pending;
  }

  async #import(gatekeeperId: WorkpieceId): Promise<void> {
    let facet = await this.host.getGatekeeperFacet(gatekeeperId) as TrackingGatekeeper;
    // Unlike an observation, the export has no count cap: one RPC result bounds it.
    let subresources = normalizeSubresources(await facet.getHistoricalSubresources());

    let record = this.#storage.gatekeepers.get(gatekeeperId);
    if (!record) throw new Error("This connection has been removed from the workspace.");
    let {observerHistoryPending: _, ...imported} = record;
    this.#storage.transaction(() => {
      this.#storage.gatekeepers.put(imported);
      if (subresources.length > 0) this.#recordImportedHistory(record, subresources);
    });
    this.host.logger.info("imported connection history into the observer ledger", {
      event: "observer.ledger.import.completed", gatekeeperId, size: subresources.length,
    });

    // Admission no longer registers anyone with this connection; retire the registrations the
    // legacy protocol made, best-effort.
    this.host.ctx.waitUntil(this.host.retireLegacyObserverRegistrations(gatekeeperId));
  }

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

  // No session read the imported history, so its records belong to the workspace, not a chat.
  #recordImportedHistory(record: GatekeeperRecord, subresources: string[]): void {
    this.recordObservation({
      gatekeeperId: record.id,
      caller: {from: "user"},
      resourceTitle: record.resourceTitle,
      resourceUrl: record.resourceUrl,
      createdAt: new Date(),
      state: "approved",
      type: "observation",
      description: {
        title: "Imported earlier reads",
        description: "The Workshop took over observer tracking for this connection and recorded " +
            "what it had read before.",
        subresources,
      },
    });
  }

  // ---------------------------------------------------------------------------------------
  // Observation

  /**
   * The ledger half of Overseer.authorizeObservation(), for the legacy protocol: calls `commit`
   * synchronously, recording no requirement. Each observation is held to the connection's
   * protocol when it arrives, whichever protocol its session was minted under: once tracked, every
   * observation through this method is refused. So is one carrying `subresources`, which only
   * authorizeTrackedObservation() enforces.
   */
  authorizeObservation(gatekeeperId: WorkpieceId, description: ObservationDescription,
                       commit: () => undefined): void {
    this.#assertUsable(gatekeeperId);
    // RPC validation forwards properties the method doesn't declare, and recording these
    // unchecked would let the read through without checking anyone.
    if ("subresources" in description) {
      throw new Error(
          "This observation was blocked: subresources must be reported through " +
          "authorizeTrackedObservation().");
    }
    if (this.isTracked(gatekeeperId)) {
      throw new Error(
          "This observation was blocked: the connection must report its subresources through " +
          "authorizeTrackedObservation().");
    }
    return commit();
  }

  /**
   * The ledger half of Overseer.authorizeTrackedObservation(). Through a legacy connection, the
   * call shows that its gatekeeper upgraded, so this first switches the connection to tracking
   * (see switchToTracking()), whose history import doesn't hold up the read. Then attributes the
   * read to its caller's context and checks the reported IDs for everyone that context reaches,
   * then recomputes that audience after the awaits and checks whoever it gained: sharing changes,
   * newly published observers, and changed account choices. Calls `commit` synchronously with the
   * validated IDs at the final decision, so no admission can publish between the audience check
   * and the audit write; resolving a promise first would let one publish before the caller writes
   * the requirement. The callback must not await. A pending creation commits with undefined,
   * recording no requirement.
   */
  async authorizeTrackedObservation(
      gatekeeperId: WorkpieceId, description: TrackedObservationDescription,
      caller: GatekeeperCaller, executionId: string | undefined,
      commit: (subresources: string[] | undefined) => undefined): Promise<void> {
    this.#assertUsable(gatekeeperId);
    if (this.host.creationPending(gatekeeperId)) return commit(undefined);
    // Only an upgraded gatekeeper calls this, so switch a legacy connection to tracking, then
    // check this read like any other; the switch imports the connection's history meanwhile.
    if (!this.isTracked(gatekeeperId) && !await this.switchToTracking(gatekeeperId)) {
      throw new Error(
          "This observation was blocked: the connection does not advertise observer tracking.");
    }

    // RPC validation forwards properties the method doesn't declare.
    if ("excludeObservers" in description && description.excludeObservers !== undefined) {
      throw new Error(
          "This observation was blocked: a connection tracked by the Workshop cannot exclude " +
          "observers.");
    }
    // Attributed to the trusted binding authorizer's caller, not its holder or a gatekeeper-
    // supplied ID: passing that capability elsewhere does not change its context. A hook firing
    // is attributed to the gadget its record says it wakes.
    let context = observerContextOf(caller);
    if (context === undefined) {
      throw new Error("This observation has no attributable chat or gadget.");
    }
    let subresources = normalizeSubresources(description.subresources, MAX_SUBRESOURCES);
    if (subresources.length === 0) {
      this.#assertLive(gatekeeperId, caller, executionId);
      return commit(subresources);
    }

    let connection = this.#storage.gatekeepers.get(gatekeeperId)!;
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
        denied = await this.#deniedObservers(connection, unverified.map(observer => ({
          observerId: observer.observerId, accountId: observer.accountId,
          user: this.host.users.get(this.host.users.idFromName(observer.profileId)),
        })), subresources);
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
   * tracked connection in `connections`, the role's verification scope: a "build" collaborator
   * reaches every context, a "use" collaborator the workspace and every gadget. Reads only the
   * distinct requirement keys, never the observations recorded under them. `connections` are live
   * records, so nothing through a connection since removed is read.
   */
  requiredSubresources(role: CollaboratorRole,
                       connections: GatekeeperRecord[]): Map<WorkpieceId, string[]> {
    let index = this.#storage.actions.byObserverRequirement;
    let contexts: ObserverContext["type"][] =
        role === "build" ? ["workspace", "chat", "gadget"] : ["workspace", "gadget"];
    let required = new Map<WorkpieceId, string[]>();
    for (let connection of connections) {
      if (connection.observerTracking !== true) continue;
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
   * verification scope, and the requirements recorded through the tracked ones that the role
   * reaches (see requiredSubresources()). Reuses `previous`'s requirements while neither its
   * connections nor `nextActionId` have changed, so an admission nothing disturbs reads them once.
   */
  observerScope(role: CollaboratorRole, gatekeepers: GatekeeperRecord[],
                previous?: ObserverScope): ObserverScope {
    let nextActionId = this.#storage.nextActionId.get();
    let requirements = previous?.nextActionId === nextActionId &&
        sameObserverConnections(previous.gatekeepers, gatekeepers)
        ? previous.requirements
        : this.requiredSubresources(role, gatekeepers);
    return {gatekeepers, requirements, nextActionId};
  }

  /**
   * Check that `accountId` (in `user`'s own User DO) can read `subresources` through
   * `connection`, asking the connection about observer `observerId`. Throws, with a reason for
   * the user, on any refusal: account gone, wrong vendor, missing method, failed call, malformed
   * result, or denial.
   */
  async checkAccess(user: DurableObjectStub<UserDurableObject>, accountId: number,
                    observerId: string, connection: GatekeeperRecord,
                    subresources: string[]): Promise<void> {
    let denied = await this.#deniedObservers(
        connection, [{observerId, user, accountId}], subresources);
    if (denied.length > 0) {
      throw new Error(
          "This account can't access some of the data this workspace read through this " +
          "service.");
    }
  }

  // Looks up each observer's verifier for their chosen account (always, so a disconnected account
  // is refused even with nothing to check), then asks the connection's verifyObserverAccess()
  // about `subresources` in bounded batches. Returns the IDs of the observers denied by the first
  // batch that denies anyone. Throws if a verifier can't be found (getVerifier's own reason), or
  // if the gatekeeper fails to answer or answers malformed.
  async #deniedObservers(connection: GatekeeperRecord, observers: ObserverAccount[],
                         subresources: string[]): Promise<string[]> {
    let vendorId = connectionVendorId(connection)!;
    let verifiers = new Map<string, Fetcher<GatekeeperUserVerifier>>();
    await boundedAll(observers, async ({observerId, user, accountId}) => {
      verifiers.set(observerId, await requireVerifier(user, accountId, vendorId));
    });
    if (subresources.length === 0) return [];

    let chunks: {id: string, verifier: Fetcher<GatekeeperUserVerifier>}[][] = [];
    for (let i = 0; i < observers.length; i += CHECK_OBSERVER_BATCH_SIZE) {
      chunks.push(observers.slice(i, i + CHECK_OBSERVER_BATCH_SIZE).map(({observerId}) => ({
        id: observerId, verifier: verifiers.get(observerId)!,
      })));
    }
    let facet = await this.host.getGatekeeperFacet(connection.id) as TrackingGatekeeper;
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
async function askGatekeeper(facet: TrackingGatekeeper,
                             observers: {id: string, verifier: Fetcher<GatekeeperUserVerifier>}[],
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
