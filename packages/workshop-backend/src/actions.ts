// Serializes gatekeeper decisions. Explicit batches durably stage vetoes; immediate rejections
// become terminal only after acknowledgement, and only authorized actions are applied.

import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type {
  ActionDescription,
  ApplyActionsThroughResult,
  Gatekeeper,
  GitCache,
  GitPackBuilder,
} from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type {
  ActionRecord, AutoApproveTagRecord, GatekeeperActionRecord, OverseerStorage,
} from "./overseer.js";

const logger = createWorkshopLogger("workshop.action.sync");

export type ActionSyncStorage = Pick<OverseerStorage,
    "actions" | "autoApproveTags" | "containsRestrictedData" | "transaction">;

/**
 * The slice of the gatekeeper stub surface the driver drives, derived from the RPC contract.
 * `applyActionsThrough` is optional during the migration; on a live stub the property is always a
 * callable proxy and an un-migrated gatekeeper throws when it is invoked (see isMethodMissing).
 */
export type GatekeeperActionTarget = Pick<Fetcher<Gatekeeper<unknown>>,
    "applyActionsThrough" | "applyAction" | "rejectAction">;

// The stub type widens the optional method with a `Promise<undefined>` property read; this is the
// callable half.
type LiveApplyActionsThrough = Extract<GatekeeperActionTarget["applyActionsThrough"],
    (...args: never[]) => unknown>;

type ActionSyncHooks = {
  /** Scoped to the gatekeeper, and to one action for the legacy per-action apply. */
  createGitCache: (gatekeeperId: number, actionId?: number) => GitCache;
  createGitPackBuilder: (
    gatekeeperId: number,
    pendingPlan: readonly GatekeeperActionRecord[],
  ) => GitPackBuilder & Disposable;
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
   * Set when a click sat above an earlier undecided action that held the frontier below it.
   * Transient queue state, so it is reported rather than recorded on the action.
   */
  blocked?: true;

  /**
   * Set when application stopped; the reason is recorded on the stopped action itself. Also set
   * when the request was already queued when that stop was recorded, so its authority predates
   * the failure and cannot retry it.
   */
  stopped?: true;

  /**
   * Set when the gatekeeper refused a veto because it had already applied that action. The
   * record now reads approved, which is the opposite of what the user asked for, so the pass
   * says so rather than letting the card flip unexplained.
   */
  vetoRefused?: true;
};

// A queued manual approval, stamped with the connection's stop count when it was admitted. A
// stop recorded after that revokes this request's authority over the action that failed.
type QueuedManualApproval = ManualApproval & {stopGeneration: number};

// One run of the loop's scheduling state, discarded when the connection's queues drain.
// `stopGeneration` counts the structured stops this run has recorded (from 1); `stoppedActions`
// maps the gatekeeper-local action each was recorded on to that count.
type RunState = {stopGeneration: number, stoppedActions?: Map<number, number>};

type StagedPass = PromiseWithResolvers<PassResult> & {
  manualApprovals: QueuedManualApproval[];
};

/**
 * Returns whether `error` is workerd's code-less missing-`applyActionsThrough` RPC error.
 *
 * Production workerd includes `the method` in this error; Miniflare's real DO stub omits it.
 * Neither runtime attaches a code, so these two migration-only message forms are the probe.
 */
export function isMethodMissing(error: unknown): boolean {
  return error instanceof Error && (
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

/**
 * The rule that lets an action apply without a human, if any: set only when the author marked the
 * action `autoApprovable`, the user enabled a rule for its `actionKind` on this gatekeeper, and the
 * workspace has not latched restricted mode. The one eligibility check for both submitAction and
 * the driver, which additionally holds back an action whose last attempt stopped.
 */
export function autoApprovalRule(
    storage: Pick<ActionSyncStorage, "autoApproveTags" | "containsRestrictedData">,
    gatekeeperId: number, description: ActionDescription): AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (storage.containsRestrictedData.get()) return undefined;
  return storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
}

export class ActionSyncDriver {
  // Per-gatekeeper intent for the NEXT pass. A key is present while a request waits to be picked
  // up; requests arriving mid-pass merge here, so work submitted during a pass isn't lost.
  #staged = new Map<number, StagedPass>();

  // Per-gatekeeper single-flight guard. Key present => a run loop is active for that gatekeeper.
  #running = new Map<number, RunState>();

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
    // Stamped by value at admission: the run this lands in may record further stops before the
    // request is planned, and those are exactly the ones its author cannot have seen. 0 when no
    // run is active, which is also where a fresh one starts.
    if (manualApproval) {
      let stopGeneration = this.#running.get(gatekeeperId)?.stopGeneration ?? 0;
      slot.manualApprovals.push({...manualApproval, stopGeneration});
    }
    this.#start(gatekeeperId);
    return slot.promise;
  }
  /**
   * Process the selected connection through an explicit boundary after durably staging its vetoes.
   * The sole batch-validation authority: every record is read and checked inside the queue, so
   * deleted or regrouped actions cannot be resurrected. Only the queue key is resolved up front.
   */
  applyThrough(
      boundaryId: number, vetoIds: readonly number[],
      resolvedBy: AiChatAuthorInfo): Promise<PassResult> {
    let boundary = this.storage.actions.get(boundaryId);
    if (!boundary) throw new Error(`No such action: ${boundaryId}`);
    let queuedGeneration = this.#running.get(boundary.gatekeeperId)?.stopGeneration ?? 0;
    return this.#enqueueDecision<PassResult>(boundary.gatekeeperId, async () => {
      let freshBoundary = this.storage.actions.get(boundaryId);
      if (!freshBoundary) throw new Error(`No such action: ${boundaryId}`);
      if (freshBoundary.type !== "action") throw new Error(`Not an action: ${boundaryId}`);

      // A selection is a set: staging one record twice is work with nothing to say.
      let selected = [...new Set(vetoIds)].map(id => {
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

      // A stop recorded since this batch was selected revokes its authority over the action that
      // failed: the selection was made against state the failure has changed. Vetoing that action
      // is the way through it, so a batch already selecting it proceeds untouched.
      let run = this.#running.get(freshBoundary.gatekeeperId)!;  // owned by the running loop
      if (run.stopGeneration > queuedGeneration) {
        let vetoed = new Set(selected.map(record => record.id));
        for (let record of this.storage.actions.pendingByGatekeeper
            .get(freshBoundary.gatekeeperId)) {
          if (record.type !== "action" || record.action > freshBoundary.action) continue;
          if ((run.stoppedActions?.get(record.action) ?? 0) > queuedGeneration &&
              !vetoed.has(record.id)) {
            return {decided: [], stopped: true};
          }
        }
      }

      // One transaction: an unstaged veto is indistinguishable from an undecided action, and the
      // pass below authorizes every pending action under the boundary -- so half a staged batch
      // would apply what the user vetoed.
      this.storage.transaction(() => {
        for (let record of selected) {
          if (record.state !== "pending") continue;
          record.state = "rejected";
          record.vetoPending = true;
          record.resolvedBy = resolvedBy;
          record.appliedAt = new Date();
          this.storage.actions.put(record);
        }
      });

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

      fresh.state = "rejected";
      fresh.resolvedBy = resolvedBy;
      fresh.appliedAt = new Date();
      this.hooks.persistRejected(fresh);
    });
  }

  #start(gatekeeperId: number): void {
    if (this.#running.has(gatekeeperId)) return;
    this.#running.set(gatekeeperId, {stopGeneration: 0});
    void this.#run(gatekeeperId);
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
    this.#start(gatekeeperId);
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
      gatekeeperId: number, manualApprovals: QueuedManualApproval[],
      batch?: {frontier: number; resolvedBy: AiChatAuthorInfo}): Promise<PassResult> {
    // Snapshot both indexes before reconciling (see actionsAscending). The pending index was
    // backfilled by the action-index migration; vetoPending only exists on records written after
    // its index was introduced, so it needs no legacy backfill.
    let pending = actionsAscending(this.storage.actions.pendingByGatekeeper.get(gatekeeperId));
    let stagedVetoes =
        actionsAscending(this.storage.actions.vetoPendingByGatekeeper.get(gatekeeperId));
    let byAction = new Map([...pending, ...stagedVetoes].map(record => [record.action, record]));

    // Explicit batches authorize every non-vetoed pending action through their fixed boundary.
    // Existing callers retain exact-click and rule authority, including their blocked result.
    let frontier = batch?.frontier ?? Math.max(-1, ...manualApprovals.map(({action}) => action));
    let attribution = new Map<number, {resolvedBy: AiChatAuthorInfo, autoApproved: boolean}>();
    let blocked: true | undefined;
    let stopped: true | undefined;
    if (batch) {
      for (let record of pending) {
        if (record.action > frontier) break;
        attribution.set(record.action, {resolvedBy: batch.resolvedBy, autoApproved: false});
      }
    } else {
      // Two authorities extend the old frontier and nothing else: the user's click on that exact
      // action, or an auto-approval rule they enabled for its kind.
      let clicked = new Map(manualApprovals.map(manual => [manual.action, manual]));
      let stops = this.#running.get(gatekeeperId)?.stoppedActions;
      for (let record of pending) {
        // 0 while this run has not stopped on this action. A click stamped before a newer stop
        // was made against state that stop invalidated, so it authorizes nothing.
        let stopGeneration = stops?.get(record.action) ?? 0;
        let manual = clicked.get(record.action);
        if (manual && manual.stopGeneration >= stopGeneration) {
          attribution.set(record.action, {resolvedBy: manual.resolvedBy, autoApproved: false});
          continue;
        }
        // A prior stop requires a click: unattended replay could repeat a side effect that landed.
        let rule = record.failure === undefined
            ? autoApprovalRule(this.storage, gatekeeperId, record.description)
            : undefined;
        if (!rule) {
          if (record.action <= frontier) {
            frontier = record.action - 1;
            // A stop no queued request could have seen reports the failure itself; otherwise
            // this is an ordinary undecided gate the clicker is told to go and resolve.
            if (stopGeneration > 0 && !manualApprovals.some(
                request => request.action >= record.action &&
                    request.stopGeneration >= stopGeneration)) {
              stopped = true;
            } else {
              blocked = true;
            }
          }
          break;
        }
        attribution.set(record.action, {resolvedBy: rule.enabledBy, autoApproved: true});
        if (record.action > frontier) frontier = record.action;
      }
    }

    let sendVetoes = stagedVetoes.filter(veto => veto.action <= frontier);
    if (attribution.size === 0 && sendVetoes.length === 0) return {decided: [], blocked, stopped};

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
    let sentVetoes = new Map(sendVetoes.map(veto => [veto.action, veto]));
    // A veto the gatekeeper refused because it had already applied that action. Acknowledging it
    // would enter an executed action as rejected. The pass that applied it lost its response
    // before recording an approver, and this one only knows the vetoer, so it records no one and
    // marks the record instead: the state says applied, which nobody chose.
    let vetoRefused: true | undefined;
    for (let action of result.alreadyApplied ?? []) {
      if (!sentVetoes.has(action)) continue;
      let fresh = this.#freshAction(byAction, action);
      if (fresh?.state !== "rejected") continue;
      fresh.state = "approved";
      fresh.appliedAt = new Date();
      fresh.vetoRefused = true;
      delete fresh.vetoPending;
      delete fresh.resolvedBy;
      delete fresh.failure;
      this.hooks.persistApproved(fresh);
      decided.push(fresh.id);
      vetoRefused = true;
    }
    for (let veto of sendVetoes) acknowledgeVeto(veto.action);
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
        // Barrier for every request already queued behind it. Run state only: after a restart
        // the persisted `failure` above is what holds the automatic path back. Always inside
        // #run, which owns this entry for the duration.
        let run = this.#running.get(gatekeeperId)!;
        (run.stoppedActions ??= new Map()).set(stoppedAt, ++run.stopGeneration);
        logger.warn("apply stopped", {
          event: "action.sync.stopped", gatekeeperId, actionId: fresh.id,
        });
      }
    }
    return {
      decided, blocked, vetoRefused, stopped: stoppedAt === undefined ? stopped : true,
    };
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
      await gatekeeper.rejectAction(veto);
      acknowledgeVeto(veto);
    }
    // Each approval is persisted as it lands: unlike a replayed frontier, a replayed per-action
    // call throws on an already-applied action, so an unrecorded apply would wedge the record as
    // pending forever.
    for (let record of pendingPlan) {
      try {
        await gatekeeper.applyAction(
            record.action, this.hooks.createGitCache(gatekeeperId, record.id));
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
