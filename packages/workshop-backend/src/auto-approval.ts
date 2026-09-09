// Auto-approval drain core: applies eligible pending actions in id order, with a per-gatekeeper
// single-flight guard so two concurrent drains (the DO's input gate is open across the apply await)
// can't double-apply the same action. The apply is injected, keeping this constructible over a
// mock storage in tests.

import type { Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>;
  autoApproveTags: Collection<AutoApproveTagRecord>;
  prohibitAllSharing: { get(): boolean };
}

/**
 * Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist. The
 * caller has already validated that the record is still pending.
 */
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

/** Resolves deployment-owned approval authority for a narrowly trusted action, if any. */
export type DeploymentAutoApproverFn = (
    record: ActionRecord & {type: "action"}) => AiChatAuthorInfo | undefined;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state. Key present => a drain is running for that gatekeeper; the
  // state carries both a "rerun" flag and the active promise. Concurrent callers join that promise
  // so completion means the requested rerun has actually drained, not merely been scheduled.
  #draining = new Map<number, {rerun: boolean; promise: Promise<void>}>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyPendingAction: ApplyPendingActionFn,
      private deploymentAutoApprover?: DeploymentAutoApproverFn) {}

  /** Returns the authority that permits this action to run without a prompt. */
  approverFor(record: ActionRecord & {type: "action"}): AiChatAuthorInfo | undefined {
    if (this.storage.prohibitAllSharing.get()) return undefined;
    if (record.description.autoApprovable !== true) return undefined;
    let tag = record.description.actionKind?.tag;
    let rule = tag === undefined
        ? undefined
        : this.storage.autoApproveTags.get(`${record.gatekeeperId}:${tag}`);
    return rule?.enabledBy ?? this.deploymentAutoApprover?.(record);
  }

  drain(gatekeeperId: number): Promise<void> {
    let active = this.#draining.get(gatekeeperId);
    if (active) {
      active.rerun = true;  // ask the running drain to loop again
      return active.promise;
    }
    let state = {rerun: false, promise: Promise.resolve()};
    state.promise = (async () => {
      try {
        do {
          state.rerun = false;
          await this.#drainOnce(gatekeeperId);
        } while (state.rerun);
      } finally {
        if (this.#draining.get(gatekeeperId) === state) {
          this.#draining.delete(gatekeeperId);
        }
      }
    })();
    this.#draining.set(gatekeeperId, state);
    return state.promise;
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops at
  // the first pending action that is NOT auto-eligible (a manual gate) or that throws while applying
  // -- it is never skipped ahead of. This preserves in-order application and the invariant that
  // nothing is silently applied past a human gate.
  //
  // Eligibility requires the author's `autoApprovable` verdict plus either a user-enabled rule or
  // narrowly-scoped deployment authority supplied by the Workshop.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Materialize a snapshot first: list() is a lazy generator over storage, and we mutate the
    // actions collection (via applyPendingAction) as we go.
    let pending = [...this.storage.actions.list()].filter(
        (rec): rec is ActionRecord & {type: "action"} =>
            rec.gatekeeperId === gatekeeperId && rec.type === "action" && rec.state === "pending");

    for (let record of pending) {
      let approver = this.approverFor(record);
      if (!approver) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        break;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        await this.applyPendingAction(fresh, approver, true);
      } catch (err) {
        // Leave the action pending for manual handling and stop the drain (never skip ahead).
        logger.error("auto-approval failed", {
          event: "auto.approval.failed", actionId: fresh.id, error: err,
        });
        break;
      }
    }
  }
}
