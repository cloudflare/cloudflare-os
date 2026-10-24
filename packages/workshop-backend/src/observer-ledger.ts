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
//   audience before the audit record is written (authorizeObservation), and an admission's scope
//   before the observer record is (OverseerImpl.#ensureObserver, via requiredSubresources()).
// - Legacy connections never reach these checks: their addObserver()/removeObserver()/
//   excludeObservers protocol is untouched, and a workspace may mix both.

import type { CollaboratorRole, WorkpieceId } from "@gadgets/workshop-shared/api";
import type {
  Gatekeeper, GatekeeperUserVerifier, ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  OBSERVER_GADGET_CONTEXT_PREFIX, connectionVendorId, observerContextKey, observerContextOf,
  type ActionRecord, type GatekeeperCaller, type GatekeeperRecord, type ObserverContext,
  type ObserverRecord, type OverseerStorage,
} from "./storage-schema/overseer-storage";
import type { SharingManager } from "./sharing";
import type { UserDurableObject } from "./user";
import type { WorkshopLogger } from "./observability";

/** Most subresource IDs one observation may report; accumulated history has no count cap. */
const MAX_SUBRESOURCES = 10_000;

/** Longest subresource ID accepted. */
const MAX_SUBRESOURCE_LENGTH = 512;

// Budget only the ID array: two bytes per UTF-16 code unit plus serialization overhead per
// element. Leave ample room for the action's metadata below SQLite's 8 MiB row limit.
const SUBRESOURCE_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Most IDs sent to `checkObserverAccess()` in one call. One observation's always fit; the union of
 * every requirement a role reaches, which admission checks, may not.
 */
const CHECK_BATCH_SIZE = MAX_SUBRESOURCES;

/** Most `checkObserverAccess()` round trips in flight at once for one observation. */
const CHECK_CONCURRENCY = 4;

/**
 * How many times an admission or an observation re-runs its checks because what it must verify
 * changed while they were in flight, before it gives up with a retryable error.
 */
export const MAX_VERIFICATION_PASSES = 3;

// The verifier and gatekeeper as an opted-in connection promises them (see
// ResourceDescription.supportsObserverTracking). RPC stubs can't report method presence, and
// their typing makes an optional method uncallable, hence these narrowed views.
type CheckingVerifier = Fetcher<GatekeeperUserVerifier &
    Required<Pick<GatekeeperUserVerifier, "checkObserverAccess">>>;
type ExportingGatekeeper = Fetcher<Gatekeeper<any> &
    Required<Pick<Gatekeeper<any>, "getHistoricalSubresources">>>;

/** The observer identity and selected account reached by one observation. */
type ObservationRecipient = Pick<ObserverRecord, "profileId" | "observerId"> & {
  accountId: number;

  /** Identifies this recipient's check: a changed account choice must be checked again. */
  key: string;
};

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

  /** Throws (retryably) while the connection is held back pending a restart, or importing. */
  assertGatekeeperUsable(id: number): void;

  /** Whether `executionId` is the executeCode invocation still running for `chatId`. */
  isLiveExecution(chatId: number, executionId: string): boolean;

  /**
   * A connection started kernel tracking: sever live collaborator sessions and hold the
   * connection back until they reopen and verify its requirements under the new protocol.
   */
  restartForObserverTracking(reason: string, gatekeeperId: WorkpieceId): void;

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
 * Validates reported subresource IDs (the RPC layer has checked an observation's are strings,
 * but not an export's) and deduplicates them without interpreting them.
 */
export function normalizeSubresources(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
    throw new Error("Subresources must be a list of strings.");
  }
  for (let id of ids) {
    if (id.length === 0 || id.length > MAX_SUBRESOURCE_LENGTH) {
      throw new Error(
          `Subresource IDs must be 1 to ${MAX_SUBRESOURCE_LENGTH} characters long.`);
    }
  }
  return [...new Set<string>(ids)];
}

/** The observer ledger of one workspace. See the module comment. */
export class ObserverLedger {
  // Per gatekeeper, the in-flight or settled protocol initialization for this object's lifetime.
  // A legacy result stays cached until an observation shows the gatekeeper was upgraded
  // (see authorizeObservation); a failed initialization is dropped so the next use retries.
  #initialized = new Map<WorkpieceId, Promise<void>>();

  // Connections whose historical import is in flight (see isImporting).
  #importing = new Set<WorkpieceId>();

  constructor(private host: ObserverLedgerHost) {}

  get #storage() { return this.host.storage; }

  /** Whether the Workshop tracks this existing connection's observations itself. */
  isTracked(gatekeeperId: WorkpieceId): boolean {
    return this.#storage.gatekeepers.get(gatekeeperId)?.observerTracking === true;
  }

  /**
   * Whether the connection's historical import is in flight. Nothing may reach the connection
   * until it commits; the Overseer's assertGatekeeperUsable() refuses it meanwhile.
   */
  isImporting(gatekeeperId: WorkpieceId): boolean {
    return this.#importing.has(gatekeeperId);
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
    this.#initialized.set(record.id, Promise.resolve());
  }

  /**
   * Bring the connection's observer protocol up to date before anything can authorize through
   * it: confirm a tracked one still advertises support, or import a legacy one that has started
   * advertising it. Single-flight per connection; the result is kept for this object's lifetime.
   * Throws to refuse the connection. A pending creation is simulated, so it has no account behind
   * it and nothing to track until it is approved.
   */
  initialize(gatekeeperId: WorkpieceId): Promise<void> {
    if (this.host.creationPending(gatekeeperId)) return Promise.resolve();
    let pending = this.#initialized.get(gatekeeperId);
    if (pending === undefined) {
      let attempt: Promise<void> = this.#initialize(gatekeeperId).then(cache => {
        // Drop an uncacheable or failed outcome, unless forget() already replaced it.
        if (!cache && this.#initialized.get(gatekeeperId) === attempt) {
          this.#initialized.delete(gatekeeperId);
        }
      }, error => {
        if (this.#initialized.get(gatekeeperId) === attempt) this.#initialized.delete(gatekeeperId);
        throw error;
      });
      this.#initialized.set(gatekeeperId, attempt);
      pending = attempt;
    }
    return pending;
  }

  /** Re-describe the connection on next use: its class was replaced, or it was removed. */
  forget(gatekeeperId: WorkpieceId): void {
    this.#initialized.delete(gatekeeperId);
  }

  // Resolves to whether the outcome may be cached.
  async #initialize(gatekeeperId: WorkpieceId): Promise<boolean> {
    let record = this.#storage.gatekeepers.get(gatekeeperId);
    if (!connectionVendorId(record)) return true;  // vendorless or gone: never verifies anyone

    let description: ResourceDescription;
    try {
      description = await (await this.host.getGatekeeperFacet(gatekeeperId)).describe();
    } catch (error) {
      if (this.isTracked(gatekeeperId)) {
        throw new Error(
            "This connection could not confirm the observer tracking it was migrated to, so it " +
            "can't be used right now. Please retry.", {cause: error});
      }
      // Discovery failed for a legacy connection: it keeps the legacy protocol, which is fully
      // enforced, and discovery is retried next time.
      this.host.logger.warn("failed to describe connection for observer tracking", {
        event: "observer.ledger.describe.failed", gatekeeperId, error,
      });
      return false;
    }

    if (!this.#storage.gatekeepers.get(gatekeeperId)) {
      throw new Error("This connection has been removed from the workspace.");
    }
    if (this.isTracked(gatekeeperId)) {
      if (!description.supportsObserverTracking) {
        // Tracking is never downgraded: the legacy protocol would not know what the Workshop
        // already recorded.
        throw new Error(
            "This connection stopped supporting the observer tracking it was migrated to, so it " +
            "can't be used until it does again.");
      }
      return true;
    }
    if (description.supportsObserverTracking) await this.#import(gatekeeperId);
    return true;
  }

  // The fenced historical import of a legacy connection. Aborting the facet ends the sessions
  // minted under the legacy protocol, and isImporting() refuses everything else until the commit.
  // A failure commits nothing, so the next use exports again; after the commit, the imported
  // history is authoritative and export is never asked for again.
  async #import(gatekeeperId: WorkpieceId): Promise<void> {
    this.#importing.add(gatekeeperId);
    let subresources: string[];
    try {
      this.host.ctx.facets.abort(`gatekeeper${gatekeeperId}`,
          new Error("Connection restarted to move its observer tracking into the workspace."));
      let facet = await this.host.getGatekeeperFacet(gatekeeperId) as ExportingGatekeeper;
      subresources = normalizeSubresources(await facet.getHistoricalSubresources());

      let record = this.#storage.gatekeepers.get(gatekeeperId);
      if (!record) throw new Error("This connection has been removed from the workspace.");
      this.#storage.transaction(() => {
        this.#storage.gatekeepers.put({...record, observerTracking: true});
        if (subresources.length > 0) this.#recordImportedHistory(record, subresources);
      });
    } finally {
      this.#importing.delete(gatekeeperId);
    }
    this.host.logger.info("imported connection history into the observer ledger", {
      event: "observer.ledger.import.completed", gatekeeperId, size: subresources.length,
    });

    // Live sessions were admitted under legacy registrations, not the imported requirements.
    // Re-admit them under the ledger, then retire legacy registrations best-effort.
    this.host.restartForObserverTracking(
        "Gadget restarted because a connection's observer tracking moved into the workspace.",
        gatekeeperId);
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
   * The ledger half of Overseer.authorizeObservation(). For a tracked connection, attributes the
   * read to its caller's context and checks the reported IDs for everyone that context reaches.
   * Calls `commit` synchronously with the validated IDs at the final decision, so no admission
   * can publish between the audience check and the audit write. The callback must not await.
   * Legacy connections and pending creations commit with undefined, recording no requirement.
   *
   * Each observation is held to the connection's protocol when it arrives, whichever protocol its
   * session was minted under: once tracked, an observation without subresources, or naming
   * observers to exclude, is refused.
   */
  async authorizeObservation(
      gatekeeperId: WorkpieceId, description: ObservationDescription, caller: GatekeeperCaller,
      executionId: string | undefined,
      commit: (subresources: string[] | undefined) => undefined): Promise<void> {
    this.#assertUsable(gatekeeperId);
    if (this.host.creationPending(gatekeeperId)) return commit(undefined);
    if (!this.isTracked(gatekeeperId)) {
      if (description.subresources !== undefined) {
        // An upgraded gatekeeper reporting IDs through a session minted while it was legacy:
        // re-describe it on the next session, which imports its history first.
        this.forget(gatekeeperId);
        throw new Error(
            "This connection now supports the Workshop's observer tracking, which must be set up " +
            "before it can be used. Please retry.");
      }
      return commit(undefined);
    }

    if (description.subresources === undefined) {
      throw new Error(
          "This observation was blocked: the connection must report its subresources.");
    }
    if (description.excludeObservers !== undefined) {
      throw new Error(
          "This observation was blocked: a connection tracked by the Workshop cannot exclude " +
          "observers.");
    }
    // Attributed to the trusted binding authorizer's caller, not its holder or a gatekeeper-
    // supplied ID: passing that capability elsewhere does not change its context. Hook events
    // use the workspace context because their callbacks have no trusted narrower attribution.
    let context = observerContextOf(caller);
    if (context === undefined) {
      throw new Error("This observation has no attributable chat or gadget.");
    }
    if (description.subresources.length > MAX_SUBRESOURCES) {
      throw new Error(`An observation may report at most ${MAX_SUBRESOURCES} subresources.`);
    }
    let subresources = normalizeSubresources(description.subresources);
    return this.#authorize(context, subresources, gatekeeperId, () => {
      this.#assertUsable(gatekeeperId);
      if (caller.from === "agent" &&
          (executionId === undefined || !this.host.isLiveExecution(caller.chatId, executionId))) {
        throw new Error(
            "This observation was blocked: the code execution its session belongs to has ended.");
      }
    }, () => commit(subresources));
  }

  // Refuses authorization through a removed connection, or one held back or importing.
  #assertUsable(gatekeeperId: WorkpieceId): void {
    if (!this.#storage.gatekeepers.get(gatekeeperId)) {
      throw new Error("This connection has been removed from the workspace.");
    }
    this.host.assertGatekeeperUsable(gatekeeperId);
  }

  // Checks the IDs for every observer the context reaches, then recomputes that audience after
  // the awaits and checks whoever it gained: sharing changes, newly published observers, and
  // changed account choices. Commits synchronously with the last recomputation: resolving a
  // promise first would let an admission publish before the caller writes the requirement.
  async #authorize(context: ObserverContext, subresources: string[], gatekeeperId: WorkpieceId,
                   revalidate: () => void, commit: () => undefined): Promise<void> {
    if (subresources.length === 0) {
      revalidate();
      return commit();
    }
    let connection = this.#storage.gatekeepers.get(gatekeeperId)!;
    let sharing = await this.host.getSharingManager();
    let verified = new Set<string>();
    for (let pass = 0; ; pass++) {
      revalidate();
      let unverified = this.#audience(sharing, context, gatekeeperId)
          .filter(observer => !verified.has(observer.key));
      if (unverified.length === 0) return commit();
      if (pass > MAX_VERIFICATION_PASSES) {
        throw new Error(
            "Collaborators' access kept changing while this was being checked. Please retry.");
      }
      await boundedAll(unverified, async observer => {
        let user = this.host.users.get(this.host.users.idFromName(observer.profileId));
        try {
          await this.checkAccess(user, observer.accountId, connection, subresources);
        } catch (error) {
          this.host.logger.warn("observer check refused an observation", {
            event: "observer.ledger.observation.refused", gatekeeperId,
            observerId: observer.observerId, error,
          });
          throw new Error(
              "This was blocked because it contains data that a current collaborator could not " +
              "be confirmed to have access to.", {cause: error});
        }
      });
      for (let observer of unverified) verified.add(observer.key);
    }
  }

  // Observers without a choice for this connection have had no session since it was tracked
  // (tracking a connection restarts every session), and their next admission checks everything.
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
   * The deduplicated subresources a collaborator holding `role` must be able to read, per tracked
   * connection: a "build" collaborator reaches every context, a "use" collaborator the workspace
   * and every gadget. Records through a connection since removed are skipped.
   */
  requiredSubresources(role: CollaboratorRole): Map<WorkpieceId, string[]> {
    let index = this.#storage.actions.byObserverContext;
    let records: ActionRecord[] = role === "build" ? [...index.list()] : [
      ...index.get(observerContextKey({type: "workspace"})),
      ...index.list({prefix: OBSERVER_GADGET_CONTEXT_PREFIX}),
    ];
    let byConnection = new Map<WorkpieceId, Set<string>>();
    for (let record of records) {
      if (record.type !== "observation") continue;
      let ids = byConnection.get(record.gatekeeperId);
      if (ids === undefined) byConnection.set(record.gatekeeperId, ids = new Set());
      for (let id of record.description.subresources ?? []) ids.add(id);
    }
    return new Map(Array.from(byConnection)
        .filter(([id]) => this.isTracked(id))
        .map(([id, ids]) => [id, [...ids]]));
  }

  /**
   * Check that `accountId` (in `user`'s own User DO) can read `subresources` through
   * `connection`'s vendor, with the account's own verifier. Throws, with a reason for the user,
   * on any refusal: account gone, wrong vendor, missing method, failed call, malformed result,
   * or denial.
   */
  async checkAccess(user: DurableObjectStub<UserDurableObject>, accountId: number,
                    connection: GatekeeperRecord, subresources: string[]): Promise<void> {
    let verifier =
        await requireVerifier(user, accountId, connectionVendorId(connection)!) as CheckingVerifier;
    for (let i = 0; i < subresources.length; i += CHECK_BATCH_SIZE) {
      let batch = subresources.slice(i, i + CHECK_BATCH_SIZE);
      let result: unknown;
      try {
        result = await verifier.checkObserverAccess(batch);
      } catch (error) {
        throw new Error("This service could not confirm the account's access.", {cause: error});
      }
      let granted = typeof result === "object" && result !== null && "granted" in result
          ? result.granted : undefined;
      if (!Array.isArray(granted) || granted.length !== batch.length ||
          granted.some(each => typeof each !== "boolean")) {
        throw new Error("This service returned an invalid access check.");
      }
      if (granted.some(each => each !== true)) {
        throw new Error(
            "This account can't access some of the data this workspace read through this " +
            "service.");
      }
    }
  }
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
