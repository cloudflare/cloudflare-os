// Serializes gatekeeper decisions. Explicit batches durably stage vetoes; immediate rejections
// become terminal only after acknowledgement, and only authorized actions are applied.

import type { Collection, NonUniqueIndex } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type {
  ApplyActionsThroughResult,
  Gatekeeper,
  GitCache,
  GitPackBuilder,
} from "@gadgets/workshop-shared/gatekeeper";
import { getGitPackErrorCode } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord, GatekeeperActionRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.action.sync");

export interface ActionSyncStorage {
  actions: Collection<ActionRecord, number> & {
    pendingByGatekeeper: NonUniqueIndex<ActionRecord, number>;
    vetoPendingByGatekeeper: NonUniqueIndex<ActionRecord, number>;
  };
  autoApproveTags: Collection<AutoApproveTagRecord>;
}

/**
 * The slice of the gatekeeper stub surface the driver drives, derived from the RPC contract.
 * `applyActionsThrough` is optional during the migration; on a live stub the property is always a
 * callable proxy and an un-migrated gatekeeper throws when it is invoked (see isMethodMissing).
 */
export type GatekeeperActionTarget = Pick<Fetcher<Gatekeeper<unknown>>,
    "applyActionsThrough" | "applyAction" | "rejectAction">;

type LiveApplyActionsThrough = Extract<GatekeeperActionTarget["applyActionsThrough"],
    (...args: never[]) => unknown>;

type ActionSyncHooks = {
  createGitCache: (gatekeeperId: number) => GitCache;
  createGitPackBuilder: (
    gatekeeperId: number,
    pendingPlan: readonly GatekeeperActionRecord[],
  ) => GitPackBuilder & Disposable;
  applyLegacyAction: (
      gatekeeper: GatekeeperActionTarget, record: GatekeeperActionRecord) => Promise<void>;
  persistApproved: (record: GatekeeperActionRecord) => void;
  persistRejected: (record: GatekeeperActionRecord) => void;
};

/**
 * A staged manual approval: the user clicked Approve on `action` (a gatekeeper-local action ID),
 * under `resolvedBy`'s authority. Earlier undecided actions go out with it only where an
 * auto-approval rule already authorizes them.
 */
export type ManualApproval = { action: number, resolvedBy: AiChatAuthorInfo };

/** The reconciled outcome of one action-processing pass. */
export type PassResult = {
  /** Workspace record IDs decided (approved or cascade-rejected) by the pass. */
  decided: number[];

  /**
   * Title of the earlier undecided action that stopped the frontier, set when a click sat above
   * it. Transient queue state, so it is reported rather than recorded on the action.
   */
  blockedBy?: string;

  /** Gatekeeper-local action ID where application stopped; zero is a valid ID. */
  stoppedAt?: number;
};

type StagedPass = {
  manualApprovals: ManualApproval[];
  resolve: (result: PassResult) => void;
  reject: (error: unknown) => void;
  promise: Promise<PassResult>;
};

/**
 * Returns whether `error` is workerd's code-less missing-`applyActionsThrough` RPC error.
 *
 * Production workerd includes `the method` in this error; Miniflare's real DO stub omits it.
 * Neither runtime attaches a code, so these two migration-only message forms remain the narrow
 * compatibility probe. Recognized application codes are authoritative and never trigger replay.
 */
export function isMethodMissing(error: unknown): boolean {
  return getGitPackErrorCode(error) === undefined && error instanceof Error && (
    error.message.includes('does not implement the method "applyActionsThrough"') ||
    error.message.includes('does not implement "applyActionsThrough"'));
}

// Materializes a lazy index read as action records ordered by `record.action` (the
// gatekeeper-local ID, which is the contract's apply order). Copying up front matters: index reads
// are lazy and a pass mutates the indexes it read from.
function actionsAscending(records: Iterable<ActionRecord>): GatekeeperActionRecord[] {
  return [...records]
      .filter((record): record is GatekeeperActionRecord => record.type === "action")
      .toSorted((a, b) => a.action - b.action);
}

// Longest gatekeeper-authored failure text kept on a record. Long enough for a real explanation,
// short enough that a hostile message can't bloat storage or the actions subscription.
const MAX_FAILURE_CHARS = 500;

function boundFailure(message: string | undefined): string | undefined {
  let text = message?.trim();
  return text ? text.slice(0, MAX_FAILURE_CHARS) : undefined;
}

export class ActionSyncDriver {
  // Per-gatekeeper intent for the NEXT pass. A key is present while a request waits to be picked
  // up; requests arriving mid-pass merge here, so work submitted during a pass isn't lost.
  #staged = new Map<number, StagedPass>();

  // Per-gatekeeper single-flight guard. Key present => a run loop is active for that gatekeeper.
  #running = new Map<number, Promise<void>>();

  // Gatekeepers observed to lack applyActionsThrough. In-memory only: a fresh isolate re-probes,
  // which is what lets a migrated deploy shed the fallback without bookkeeping.
  #legacy = new Set<number>();

  // Explicit batches and immediate rejections run between apply passes under the same guard.
  #decisions = new Map<number, Array<() => Promise<void>>>();

  constructor(
      private storage: ActionSyncStorage,
      private getGatekeeper: (gatekeeperId: number) => GatekeeperActionTarget,
      private hooks: ActionSyncHooks) {}

  /**
   * Reconcile the gatekeeper's queue, optionally staging a manual approval. Resolves with what the
   * pass carrying this request's intent decided. Concurrent calls for the same gatekeeper coalesce
   * into one pass.
   */
  apply(gatekeeperId: number, manualApproval?: ManualApproval): Promise<PassResult> {
    let slot = this.#staged.get(gatekeeperId);
    if (!slot) {
      slot = { manualApprovals: [], ...Promise.withResolvers<PassResult>() };
      this.#staged.set(gatekeeperId, slot);
    }
    if (manualApproval) slot.manualApprovals.push(manualApproval);

    if (!this.#running.has(gatekeeperId)) {
      this.#running.set(gatekeeperId, this.#run(gatekeeperId));
    }
    return slot.promise;
  }
  /**
   * Process the selected connection through an explicit boundary after durably staging its vetoes.
   * The records are re-read inside the queue so deleted or regrouped actions cannot be resurrected.
   */
  applyThrough(
      boundary: GatekeeperActionRecord, vetoes: readonly GatekeeperActionRecord[],
      resolvedBy: AiChatAuthorInfo): Promise<PassResult> {
    return this.#enqueueDecision(boundary.gatekeeperId, async () => {
      let freshBoundary = this.storage.actions.get(boundary.id);
      if (!freshBoundary) throw new Error(`No such action: ${boundary.id}`);
      if (freshBoundary.type !== "action") throw new Error(`Not an action: ${boundary.id}`);
      if (freshBoundary.gatekeeperId !== boundary.gatekeeperId) {
        throw new Error("Action batch contains a different connection.");
      }

      let selected = vetoes.map(({id}) => {
        let fresh = this.storage.actions.get(id);
        if (!fresh) throw new Error(`No such action: ${id}`);
        if (fresh.type !== "action") throw new Error(`Not an action: ${id}`);
        if (fresh.gatekeeperId !== freshBoundary.gatekeeperId) {
          throw new Error("Action batch contains a different connection.");
        }
        if (fresh.action > freshBoundary.action) {
          throw new Error("Veto is beyond the action batch boundary.");
        }
        return fresh;
      });

      for (let record of selected) {
        if (record.state !== "pending") continue;
        record.state = "rejected";
        record.vetoPending = true;
        record.resolvedBy = resolvedBy;
        record.appliedAt = new Date();
        this.storage.actions.put(record);
      }

      return await this.#applyOnce(freshBoundary.gatekeeperId, [], {
        frontier: freshBoundary.action,
        resolvedBy,
      });
    });
  }

  /** Delivers one immediate rejection through the legacy endpoint before recording it. */
  reject(record: GatekeeperActionRecord, resolvedBy: AiChatAuthorInfo): Promise<void> {
    return this.#enqueueDecision(record.gatekeeperId, async () => {
      let fresh = this.storage.actions.get(record.id);
      if (fresh?.type !== "action" || fresh.state !== "pending") {
        throw new Error(`Action is not pending: ${record.id}`);
      }

      await this.getGatekeeper(record.gatekeeperId).rejectAction(fresh.action);

      fresh = this.storage.actions.get(record.id);
      if (fresh?.type !== "action" || fresh.state !== "pending") return;
      fresh.state = "rejected";
      fresh.resolvedBy = resolvedBy;
      fresh.appliedAt = new Date();
      this.hooks.persistRejected(fresh);
    });
  }

  #enqueueDecision<T>(gatekeeperId: number, operation: () => Promise<T>): Promise<T> {
    let {promise, resolve, reject} = Promise.withResolvers<T>();
    let queue = this.#decisions.get(gatekeeperId);
    if (!queue) this.#decisions.set(gatekeeperId, queue = []);
    queue.push(async () => {
      try {
        resolve(await operation());
      } catch (error) {
        reject(error);
      }
    });
    if (!this.#running.has(gatekeeperId)) {
      this.#running.set(gatekeeperId, this.#run(gatekeeperId));
    }
    return promise;
  }

  async #run(gatekeeperId: number): Promise<void> {
    try {
      for (;;) {
        let queue = this.#decisions.get(gatekeeperId);
        let decision = queue?.shift();
        if (queue?.length === 0) this.#decisions.delete(gatekeeperId);
        if (decision) {
          await decision();
          continue;
        }
        let slot = this.#staged.get(gatekeeperId);
        if (!slot) break;
        this.#staged.delete(gatekeeperId);
        try {
          slot.resolve(await this.#applyOnce(gatekeeperId, slot.manualApprovals));
        } catch (error) {
          // Auto-approval callers run in waitUntil and do not observe the rejection.
          logger.warn("action sync pass failed", {
            event: "action.sync.failed", gatekeeperId, error,
          });
          slot.reject(error);
        }
      }
    } finally {
      // Synchronous with the loop's empty-staged check above, so a request staged mid-pass either
      // was picked up by the loop or sees #running empty and starts a fresh one.
      this.#running.delete(gatekeeperId);
    }
  }

  async #applyOnce(
      gatekeeperId: number, manualApprovals: ManualApproval[],
      batch?: {frontier: number; resolvedBy: AiChatAuthorInfo}): Promise<PassResult> {
    // Snapshot both indexes before reconciling (see actionsAscending). The pending index was
    // backfilled by the action-index migration; vetoPending only exists on records written after
    // its index was introduced, so it needs no legacy backfill.
    let pending = actionsAscending(this.storage.actions.pendingByGatekeeper.get(gatekeeperId));
    let stagedVetoes =
        actionsAscending(this.storage.actions.vetoPendingByGatekeeper.get(gatekeeperId))
            .filter(record => record.state === "rejected" && record.vetoPending === true);
    let byAction = new Map([...pending, ...stagedVetoes].map(record => [record.action, record]));

    // Explicit batches authorize every non-vetoed pending action through their fixed boundary.
    // Existing callers retain exact-click and rule authority, including their blocked result.
    let frontier = batch?.frontier ?? Math.max(-1, ...manualApprovals.map(({action}) => action));
    let attribution = new Map<number, {resolvedBy: AiChatAuthorInfo, autoApproved: boolean}>();
    let blockedBy: string | undefined;
    if (batch) {
      for (let record of pending) {
        if (record.action > frontier) break;
        attribution.set(record.action, {resolvedBy: batch.resolvedBy, autoApproved: false});
      }
    } else {
      // Two authorities extend the old frontier and nothing else: the user's click on that exact
      // action, or an auto-approval rule they enabled for its kind.
      let clicked = new Map(manualApprovals.map(manual => [manual.action, manual.resolvedBy]));
      let gate: GatekeeperActionRecord | undefined;
      for (let record of pending) {
        let resolvedBy = clicked.get(record.action);
        if (resolvedBy) {
          attribution.set(record.action, {resolvedBy, autoApproved: false});
          continue;
        }
        // A prior stop requires a click: unattended replay could repeat a side effect that landed.
        let tag = record.failure === undefined && record.description.autoApprovable === true
            ? record.description.actionKind?.tag
            : undefined;
        let rule = tag === undefined
            ? undefined
            : this.storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
        if (!rule) {
          gate = record;
          break;
        }
        attribution.set(record.action, {resolvedBy: rule.enabledBy, autoApproved: true});
        if (record.action > frontier) frontier = record.action;
      }

      if (gate && gate.action <= frontier) {
        frontier = gate.action - 1;
        blockedBy = gate.description.title;
      }
    }

    let sendVetoes = stagedVetoes.filter(veto => veto.action <= frontier);
    if (attribution.size === 0 && sendVetoes.length === 0) return {decided: [], blockedBy};

    let decided: number[] = [];

    // The single pending->approved chokepoint. Idempotent, so the legacy path can persist an
    // approval the moment it lands and the reconcile loop below can replay it harmlessly.
    let approve = (action: number) => {
      let attr = attribution.get(action);
      let fresh = this.#freshAction(byAction, action);
      if (!attr || fresh?.state !== "pending") return;
      fresh.state = "approved";
      fresh.appliedAt = new Date();
      fresh.resolvedBy = attr.resolvedBy;
      fresh.autoApproved = attr.autoApproved;
      delete fresh.failure;
      this.hooks.persistApproved(fresh);
      decided.push(fresh.id);
    };

    // Acknowledge each legacy veto as soon as its RPC returns, before another call can fail. The
    // batch path invokes this only after its all-vetoes-durable call returns successfully.
    let acknowledgeVeto = (action: number) => {
      let fresh = this.#freshAction(byAction, action);
      if (!fresh?.vetoPending) return;
      delete fresh.vetoPending;
      this.hooks.persistRejected(fresh);
    };

    let result = await this.#applyThrough(
        gatekeeperId, frontier, sendVetoes.map(veto => veto.action),
        pending.filter(record => attribution.has(record.action)), approve, acknowledgeVeto);
    let stoppedAt = result.stopped?.at;
    let stoppedFailure = result.stopped?.reason?.message;
    // A stop outside the authorized set breaks the contract (no shipped gatekeeper can: the
    // legacy path synthesizes `at` from this plan). Clamp to the lowest authorized action rather
    // than trust it -- nothing is then recorded applied -- and drop the gatekeeper's text, which
    // describes an action this pass never sent.
    if (stoppedAt !== undefined && !attribution.has(stoppedAt)) {
      stoppedAt = pending.find(record => attribution.has(record.action))?.action;
      if (stoppedAt === undefined) {
        throw new Error("Gatekeeper returned an invalid stopping action.");
      }
      stoppedFailure = undefined;
    }
    for (let veto of sendVetoes) acknowledgeVeto(veto.action);
    let sentVetoes = new Map(sendVetoes.map(veto => [veto.action, veto]));
    // Cascade invalidations first: an action inside the frontier can also be cascade-invalidated
    // by a veto delivered in this same pass, and then it was deleted, not applied -- marking it
    // rejected here keeps the approval loop below (which only touches pending records) from
    // mislabeling it approved. Display-attributed to the veto that caused it, resolved by the user
    // whose rejection it was.
    if (result.invalidatedByVeto?.length) {
      // A cascade may name an action submitted during the RPC await, which the pre-call snapshot
      // can't contain; left pending it would later be recorded approved though the gatekeeper had
      // deleted it.
      for (let record of this.storage.actions.pendingByGatekeeper.get(gatekeeperId)) {
        if (record.type === "action") byAction.set(record.action, record);
      }
    }
    for (let entry of result.invalidatedByVeto ?? []) {
      let vetoer = sentVetoes.get(entry.invalidatedBy);
      if (!vetoer) continue;
      let fresh = this.#freshAction(byAction, entry.action);
      if (!fresh || fresh.state !== "pending") continue;
      fresh.state = "rejected";
      fresh.appliedAt = new Date();
      if (vetoer.resolvedBy) fresh.resolvedBy = vetoer.resolvedBy;
      fresh.cascadedFrom = vetoer.id;
      delete fresh.failure;
      this.hooks.persistRejected(fresh);
      decided.push(fresh.id);
    }

    // The contract makes `appliedThrough` sound despite ID holes: a gatekeeper never silently
    // skips a pending in-range action -- it applies it or reports it via `stopped`.
    let appliedThrough = stoppedAt !== undefined ? stoppedAt - 1 : frontier;
    for (let action of attribution.keys()) {
      if (action <= appliedThrough) approve(action);
    }

    // The stopping action stays pending, carrying a display-safe reason the user can act on. The
    // gatekeeper writes that text, so it is clamped before storage and kept out of the log.
    // Stamped like every other mutation, or byLastChanged would leave it out of a resume replay.
    if (stoppedAt !== undefined) {
      let fresh = this.#freshAction(byAction, stoppedAt);
      if (fresh?.state === "pending") {
        fresh.failure = boundFailure(stoppedFailure) ??
            "The gatekeeper could not apply this action.";
        fresh.appliedAt = new Date();
        this.storage.actions.put(fresh);
        logger.warn("apply stopped", {
          event: "action.sync.stopped", gatekeeperId, actionId: fresh.id,
        });
      }
    }
    return {decided, blockedBy, stoppedAt};
  }

  // Re-read before each mutation; earlier checkpoints and cascade refreshes may replace snapshots.
  #freshAction(byAction: Map<number, GatekeeperActionRecord>, actionId: number)
      : GatekeeperActionRecord | undefined {
    let record = byAction.get(actionId);
    if (!record) return undefined;
    let fresh = this.storage.actions.get(record.id);
    return fresh?.type === "action" ? fresh : undefined;
  }

  // Batch call with a legacy fallback for gatekeepers that predate applyActionsThrough -- which
  // is still all of them. The fallback checkpoints each veto before attempting the next call and
  // aborts before any apply when a rejection fails. Delete the fallback half -- and the #legacy
  // cache -- once the fallback warning stops appearing in logs and the method becomes required.
  async #applyThrough(gatekeeperId: number, actionId: number, vetoes: number[],
                      pendingPlan: readonly GatekeeperActionRecord[],
                      approve: (action: number) => void,
                      acknowledgeVeto: (action: number) => void)
      : Promise<ApplyActionsThroughResult> {
    let gatekeeper = this.getGatekeeper(gatekeeperId);

    if (!this.#legacy.has(gatekeeperId)) {
      try {
        using gitPacks = this.hooks.createGitPackBuilder(gatekeeperId, pendingPlan);
        let applyActionsThrough = gatekeeper.applyActionsThrough as LiveApplyActionsThrough;
        return await applyActionsThrough(actionId, vetoes, {
          gitCache: this.hooks.createGitCache(gatekeeperId), gitPackBuilder: gitPacks,
        });
      } catch (error) {
        if (!isMethodMissing(error)) throw error;
      }
      this.#legacy.add(gatekeeperId);
      logger.warn("gatekeeper does not implement applyActionsThrough; using per-action fallback", {
        event: "action.sync.legacy", gatekeeperId,
      });
    }

    // Legacy path: per-action calls in the same order the batch would use -- vetoes first, then
    // pending actions ascending. Each confirmed veto is checkpointed immediately; a failed veto
    // aborts the pass before any action can be applied. `{restart}` returns are discarded, as the
    // overseer always has, and this path never reports `invalidatedByVeto`, so an un-migrated
    // gatekeeper's cascades leave their dependants pending until they too are decided.
    for (let veto of vetoes) {
      try {
        await gatekeeper.rejectAction(veto);
      } catch (error) {
        logger.warn("legacy rejectAction failed", {
          event: "action.sync.legacy.reject.failed", gatekeeperId, error,
        });
        throw error;
      }
      acknowledgeVeto(veto);
    }
    // Each approval is persisted as it lands: unlike a replayed frontier, a replayed per-action
    // call throws on an already-applied action, so an unrecorded apply would wedge the record as
    // pending forever.
    for (let record of pendingPlan) {
      try {
        await this.hooks.applyLegacyAction(gatekeeper, record);
      } catch (error) {
        return {stopped: {
          at: record.action,
          reason: error instanceof Error ? error : new Error(String(error)),
        }};
      }
      approve(record.action);
    }
    return {};
  }
}
