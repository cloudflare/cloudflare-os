// Action-sync core: reconciles this workspace's pending action records with a gatekeeper through
// one batch `applyActionsThrough(actionId, vetoes)` call per pass. A pass computes the decision
// frontier (manual approvals staged by the caller, then auto-approval rules, then deliverable
// vetoes), makes the call, and translates the result back onto the records: everything at or below
// the applied frontier becomes "approved" with the right attribution, a `stopped` action keeps its
// pending state plus a display-safe `failure`, and veto-cascade invalidations become "rejected"
// with `cascadedFrom` attribution.
//
// A per-gatekeeper single-flight guard (the DO's input gate is open across the RPC await)
// coalesces concurrent requests into the next pass, so two approvals arriving together produce one
// call at the higher frontier. The gatekeeper accessor is injected, keeping the driver
// constructible over a mock storage in tests.

import type { Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ApplyActionsThroughResult, Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.action.sync");

export interface ActionSyncStorage {
  actions: Collection<ActionRecord, number>;
  autoApproveTags: Collection<AutoApproveTagRecord>;
}

/**
 * The slice of the gatekeeper stub surface the driver drives, derived from the RPC contract.
 * `applyActionsThrough` is optional during the migration; on a live stub the property is always a
 * callable proxy and an un-migrated gatekeeper throws when it is invoked (see isMethodMissing).
 */
export type GatekeeperActionTarget =
    Pick<Fetcher<Gatekeeper<unknown>>, "applyActionsThrough" | "applyAction" | "rejectAction">;

export type GetGatekeeperFn = (gatekeeperId: number) => GatekeeperActionTarget;

/**
 * A staged manual approval: apply every undecided action through `frontier` (a gatekeeper-local
 * action ID) under `resolvedBy`'s authority.
 */
export type ManualApproval = { frontier: number, resolvedBy: AiChatAuthorInfo };

type StagedSync = {
  manualApprovals: ManualApproval[];
  resolve: (decided: number[]) => void;
  reject: (error: unknown) => void;
  promise: Promise<number[]>;
};

// workerd raises `TypeError: The RPC receiver does not implement the method
// "applyActionsThrough".` for an un-migrated gatekeeper. The error is untyped after the RPC hop
// (only the message survives), so this matches the message text.
function isMethodMissing(error: unknown): boolean {
  return error instanceof Error &&
      error.message.includes('does not implement the method "applyActionsThrough"');
}

export class ActionSyncDriver {
  // Per-gatekeeper intent for the NEXT pass. A key is present while a request waits to be picked
  // up; requests arriving mid-pass merge here, so work submitted during a pass isn't lost.
  #staged = new Map<number, StagedSync>();

  // Per-gatekeeper single-flight guard. Key present => a run loop is active for that gatekeeper.
  #running = new Map<number, Promise<void>>();

  // Gatekeepers observed to lack applyActionsThrough. In-memory only: a fresh isolate re-probes,
  // which is what lets a migrated deploy shed the fallback without bookkeeping.
  #legacy = new Set<number>();

  constructor(
      private storage: ActionSyncStorage,
      private getGatekeeper: GetGatekeeperFn) {}

  /**
   * Reconcile the gatekeeper's queue, optionally staging a manual approval. Resolves with the
   * workspace record IDs decided (approved or cascade-rejected) by the pass that carried this
   * request's intent. Concurrent calls for the same gatekeeper coalesce into one pass.
   */
  sync(gatekeeperId: number, manualApproval?: ManualApproval): Promise<number[]> {
    let slot = this.#staged.get(gatekeeperId);
    if (!slot) {
      slot = { manualApprovals: [], ...Promise.withResolvers<number[]>() };
      this.#staged.set(gatekeeperId, slot);
    }
    if (manualApproval) slot.manualApprovals.push(manualApproval);

    if (!this.#running.has(gatekeeperId)) {
      this.#running.set(gatekeeperId, this.#run(gatekeeperId));
    }
    return slot.promise;
  }

  /**
   * Resolves once no sync pass is in flight for the gatekeeper. Used by rejection: a veto must
   * never be staged while a pass that might apply the same action is mid-RPC.
   */
  async settled(gatekeeperId: number): Promise<void> {
    for (;;) {
      let running = this.#running.get(gatekeeperId);
      if (!running) return;
      await running.catch(() => {});
    }
  }

  async #run(gatekeeperId: number): Promise<void> {
    try {
      for (;;) {
        let slot = this.#staged.get(gatekeeperId);
        if (!slot) break;
        this.#staged.delete(gatekeeperId);
        try {
          slot.resolve(await this.#syncOnce(gatekeeperId, slot.manualApprovals));
        } catch (error) {
          slot.reject(error);
        }
      }
    } finally {
      // Synchronous with the loop's empty-staged check above, so a request staged mid-pass either
      // was picked up by the loop or sees #running empty and starts a fresh one.
      this.#running.delete(gatekeeperId);
    }
  }

  async #syncOnce(gatekeeperId: number, manualApprovals: ManualApproval[]): Promise<number[]> {
    // Materialize a snapshot first: list() is a lazy generator over storage, and we mutate the
    // actions collection as we reconcile. Keyed and ordered by `record.action` (the
    // gatekeeper-local ID space) -- `record.id` shares a counter with observations and hooks.
    let records = [...this.storage.actions.list()].filter(
        (rec): rec is ActionRecord & {type: "action"} =>
            rec.gatekeeperId === gatekeeperId && rec.type === "action");
    let byAction = new Map(records.map(record => [record.action, record]));
    let pending = records.filter(record => record.state === "pending")
        .toSorted((a, b) => a.action - b.action);
    let stagedVetoes = records.filter(record => record.state === "rejected" && record.vetoPending)
        .toSorted((a, b) => a.action - b.action);

    // Decide the frontier and, for every pending action it covers, the attribution to record if
    // the gatekeeper applies it. Attribution is captured now, before the RPC, so a rule removed
    // mid-call can't leave an applied action unattributed: this is the single pending->approved
    // chokepoint, and every transition must record the resolving user and whether it was
    // automatic.
    let manualAscending = manualApprovals.toSorted((a, b) => a.frontier - b.frontier);
    let frontier = manualAscending.at(-1)?.frontier ?? 0;
    let attribution = new Map<number, {resolvedBy: AiChatAuthorInfo, autoApproved: boolean}>();
    for (let record of pending) {
      // Covered by a manual approval; the smallest covering frontier's user takes responsibility
      // for this earlier action riding along.
      let covering = manualAscending.find(manual => manual.frontier >= record.action);
      if (covering) {
        attribution.set(record.action, {resolvedBy: covering.resolvedBy, autoApproved: false});
        continue;
      }
      // Above every manual frontier: extend while auto-eligible, exactly like the old drain.
      // Eligibility requires BOTH signals: the author's `autoApprovable` verdict on the action AND
      // a user-enabled rule for the action's kind. Stop at the first manual gate -- nothing is
      // ever applied past one.
      let tag = record.description.actionKind?.tag;
      let rule = tag !== undefined
          ? this.storage.autoApproveTags.get(`${gatekeeperId}:${tag}`)
          : undefined;
      if (record.description.autoApprovable !== true || rule === undefined) break;
      attribution.set(record.action, {resolvedBy: rule.enabledBy, autoApproved: true});
      frontier = record.action;
    }

    // Vetoes ride along up to the frontier. Beyond it, a staged veto is deliverable only when
    // every action below it is already decided (the frontier may equal the current one for
    // veto-only delivery) -- a veto must never drag undecided actions into application.
    let firstUndecided = pending.find(record => record.action > frontier)?.action ?? Infinity;
    for (let veto of stagedVetoes) {
      if (veto.action < firstUndecided && veto.action > frontier) frontier = veto.action;
    }
    let sendVetoes = stagedVetoes.filter(veto => veto.action <= frontier);

    if (attribution.size === 0 && sendVetoes.length === 0) return [];

    let result = await this.#applyThrough(
        gatekeeperId, frontier, sendVetoes.map(veto => veto.action), [...attribution.keys()]);

    // Reconcile. The contract makes `appliedThrough` sound despite ID holes: a gatekeeper never
    // silently skips a pending in-range action -- it applies it or reports it via `stopped`.
    let appliedThrough = result.stopped ? result.stopped.at - 1 : frontier;
    let decided: number[] = [];

    // Cascade invalidations first: an action inside the frontier can also be cascade-invalidated
    // by a veto delivered in this same pass, and then it was deleted, not applied -- marking it
    // rejected here keeps the approval loop below (which only touches pending records) from
    // mislabeling it approved. Display-attributed to the veto that caused it, resolved by the user
    // whose rejection it was.
    for (let entry of result.invalidatedByVeto ?? []) {
      let fresh = this.#freshAction(byAction, entry.action);
      if (!fresh || fresh.state !== "pending") continue;
      let vetoer = byAction.get(entry.invalidatedBy);
      fresh.state = "rejected";
      fresh.appliedAt = new Date();
      if (vetoer?.resolvedBy) fresh.resolvedBy = vetoer.resolvedBy;
      fresh.cascadedFrom = vetoer?.id;
      delete fresh.failure;
      this.storage.actions.put(fresh);
      decided.push(fresh.id);
    }

    for (let [actionId, attr] of attribution) {
      if (actionId > appliedThrough) continue;
      let fresh = this.#freshAction(byAction, actionId);
      if (!fresh || fresh.state !== "pending") continue;
      fresh.state = "approved";
      fresh.appliedAt = new Date();
      fresh.resolvedBy = attr.resolvedBy;
      fresh.autoApproved = attr.autoApproved;
      delete fresh.failure;
      this.storage.actions.put(fresh);
      decided.push(fresh.id);
    }

    // The stopping action stays pending, carrying a display-safe reason the user can act on.
    if (result.stopped) {
      let fresh = this.#freshAction(byAction, result.stopped.at);
      if (fresh?.state === "pending") {
        fresh.failure =
            result.stopped.reason?.message || "The gatekeeper could not apply this action.";
        this.storage.actions.put(fresh);
        logger.warn("apply stopped", {
          event: "action.sync.stopped", actionId: fresh.id, error: result.stopped.reason,
        });
      }
    }

    // Sent vetoes are delivered even on a `stopped` result (gatekeepers process vetoes before
    // applying), so clear their staging flag.
    for (let veto of sendVetoes) {
      let fresh = this.#freshAction(byAction, veto.action);
      if (fresh?.vetoPending) {
        delete fresh.vetoPending;
        this.storage.actions.put(fresh);
      }
    }

    return decided;
  }

  // Re-read a record immediately before mutating it, guarding against concurrent decisions made
  // while the pass's RPC await held the input gate open.
  #freshAction(byAction: Map<number, ActionRecord & {type: "action"}>, actionId: number)
      : (ActionRecord & {type: "action"}) | undefined {
    let record = byAction.get(actionId);
    if (!record) return undefined;
    let fresh = this.storage.actions.get(record.id);
    return fresh?.type === "action" ? fresh : undefined;
  }

  // Batch call with a legacy fallback for gatekeepers that predate applyActionsThrough
  // (gadgets-internal). Delete this whole method body's fallback half -- and the #legacy cache --
  // once the fallback warning stops appearing in logs and the method becomes required.
  async #applyThrough(gatekeeperId: number, actionId: number, vetoes: number[],
                      pendingPlan: number[]): Promise<ApplyActionsThroughResult> {
    let gatekeeper = this.getGatekeeper(gatekeeperId);

    if (!this.#legacy.has(gatekeeperId)) {
      try {
        if (typeof gatekeeper.applyActionsThrough === "function") {
          return await gatekeeper.applyActionsThrough(actionId, vetoes);
        }
      } catch (error) {
        if (!isMethodMissing(error)) throw error;
      }
      this.#legacy.add(gatekeeperId);
      logger.warn("gatekeeper does not implement applyActionsThrough; using per-action fallback", {
        event: "action.sync.legacy", gatekeeperId,
      });
    }

    // Legacy path: per-action calls in the same order the batch would use -- vetoes first, then
    // pending actions ascending. Rejects are individually best-effort (some gatekeepers throw on
    // already-settled actions, and a veto can arrive long after the fact); `{restart}` returns
    // are discarded, as the overseer always has. Never reports `invalidatedByVeto` (display-only,
    // so an un-migrated gatekeeper's cascades simply go unattributed).
    for (let veto of vetoes) {
      try {
        await gatekeeper.rejectAction(veto);
      } catch (error) {
        logger.warn("legacy rejectAction failed", {
          event: "action.sync.legacy.reject.failed", gatekeeperId, error,
        });
      }
    }
    for (let action of pendingPlan) {
      try {
        await gatekeeper.applyAction(action);
      } catch (error) {
        return {stopped: {
          at: action,
          reason: error instanceof Error ? error : new Error(String(error)),
        }};
      }
    }
    return {};
  }
}
