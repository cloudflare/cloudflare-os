// Auto-approval drain core: applies the gatekeeper's eligible pending actions (read off the sparse
// pendingByGatekeeper index) in id order, with a per-gatekeeper single-flight guard so two
// concurrent drains (the DO's input gate is open across the apply await) can't double-apply the
// same action. The apply is injected, keeping this constructible over a mock storage in tests.

import type { Collection, NonUniqueIndex, Singleton } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>
      & { pendingByGatekeeper: NonUniqueIndex<ActionRecord, number> };
  autoApproveTags: Collection<AutoApproveTagRecord>;

  /**
   * The restricted-data latch (see makeOverseerStorage; the key predates the flag's rename to
   * `containsRestrictedData`). While set, no action is ever auto-approved: a latched workspace's
   * only permissible actions are writes back to a restricted producer (submitAction's
   * writes-to-self carve-out), and each of those must pend for a human.
   */
  prohibitAllSharing: Singleton<boolean>;
}

/**
 * The single authority on whether an action may be applied without a human. Returns the enabling
 * rule iff ALL of:
 *  - the gatekeeper author marked this specific action `autoApprovable`,
 *  - the action carries an `actionKind` for which the user enabled a rule on this gatekeeper,
 *  - the action carries no `operatorWarnings` (a warning exists precisely to be read by the
 *    human approver, so it forces manual approval),
 *  - the workspace has not latched restricted mode (`prohibitAllSharing` above).
 * Returns undefined otherwise: manual approval required.
 */
export function autoApprovalRule(
    storage: AutoApprovalStorage, gatekeeperId: number, description: ActionDescription)
    : AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (description.operatorWarnings !== undefined && description.operatorWarnings.length > 0) {
    return undefined;
  }
  if (storage.prohibitAllSharing.get()) return undefined;
  return storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
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
  // Eligibility is `autoApprovalRule()`: the author's `autoApprovable` verdict, a user-enabled
  // rule for the action's kind, no operator warnings, and no restricted-data latch.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Materialize before applying: the index yields lazily in ascending id order, and applying
    // mutates it mid-iteration. Actions created after this snapshot trigger their own drain(),
    // which drain()'s rerun flag folds into this run if it's still in flight.
    let pending = [...this.storage.actions.pendingByGatekeeper.get(gatekeeperId)];

    for (let record of pending) {
      if (record.type !== "action") continue;

      let rule = autoApprovalRule(this.storage, gatekeeperId, record.description);
      if (rule === undefined) {
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
