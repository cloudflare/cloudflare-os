// Auto-approval drain core: applies the gatekeeper's eligible pending actions (read off the sparse
// pendingByGatekeeper index) in id order, with a per-gatekeeper single-flight guard so two
// concurrent drains (the DO's input gate is open across the apply await) can't double-apply the
// same action. The apply is injected, keeping this constructible over a mock storage in tests.

import type { Collection, NonUniqueIndex } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>
      & { pendingByGatekeeper: NonUniqueIndex<ActionRecord, number> };
  autoApproveTags: Collection<AutoApproveTagRecord>;
}

/**
 * Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist. The
 * caller has already validated that the record is still pending.
 */
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state. Key present => a drain is running for that gatekeeper; the
  // value is a "rerun" flag, set when another drain is requested while one is in flight, so work
  // submitted during a drain isn't lost.
  #draining = new Map<number, boolean>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyPendingAction: ApplyPendingActionFn) {}

  async drain(gatekeeperId: number): Promise<void> {
    if (this.#draining.has(gatekeeperId)) {
      this.#draining.set(gatekeeperId, true);  // ask the running drain to loop again
      return;
    }
    this.#draining.set(gatekeeperId, false);
    try {
      do {
        this.#draining.set(gatekeeperId, false);
        await this.#drainOnce(gatekeeperId);
      } while (this.#draining.get(gatekeeperId));
    } finally {
      this.#draining.delete(gatekeeperId);
    }
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops
  // at the first pending action that is NOT auto-eligible (a manual gate) or that throws while
  // applying -- it is never skipped ahead of. This preserves in-order application and the
  // invariant that nothing is silently applied past a human gate.
  //
  // Eligibility requires BOTH signals: the author's `autoApprovable` verdict on the action AND a
  // user-enabled rule for the action's type on this gatekeeper.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Materialize before applying: the index yields lazily in ascending id order, and applying
    // mutates it mid-iteration. Actions created after this snapshot trigger their own drain(),
    // which drain()'s rerun flag folds into this run if it's still in flight.
    let pending = [...this.storage.actions.pendingByGatekeeper.get(gatekeeperId)];

    for (let record of pending) {
      if (record.type !== "action") continue;

      let tag = record.description.actionKind?.tag;
      let rule = tag !== undefined
          ? this.storage.autoApproveTags.get(`${gatekeeperId}:${tag}`)
          : undefined;
      if (record.description.autoApprovable !== true || rule === undefined) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        return;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority.
        await this.applyPendingAction(fresh, rule.enabledBy, true);
      } catch (err) {
        // Leave the action pending for manual handling and stop the drain (never skip ahead).
        logger.error("auto-approval failed", {
          event: "auto.approval.failed", actionId: fresh.id, error: err,
        });
        return;
      }
    }
  }
}
