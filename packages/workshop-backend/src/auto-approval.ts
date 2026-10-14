// Auto-approval drain core: applies the gatekeeper's eligible pending actions (read off the sparse
// pendingByGatekeeper index) in id order, with a per-gatekeeper single-flight guard so two
// concurrent drains (the DO's input gate is open across the apply await) can't double-apply the
// same action. The apply is injected, keeping this constructible over a mock storage in tests.

import type { Collection, NonUniqueIndex, Singleton } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionApplication, ActionRecord, AutoApproveTagRecord } from "./storage-schema/overseer-storage.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>
      & { pendingByGatekeeper: NonUniqueIndex<ActionRecord, number> };
  autoApproveTags: Collection<AutoApproveTagRecord>;
  /** Durable approval intent, not an unapproved request or an in-memory running flag. */
  actionApplications: Pick<Collection<ActionApplication, number>, "get">;

  /** The restricted-data latch (see makeOverseerStorage). While set, nothing auto-approves. */
  containsRestrictedData: Singleton<boolean>;
}

/**
 * The single authority on whether an action may be applied without a human: the enabling rule if
 * the author marked the action `autoApprovable`, the user enabled a rule for its `actionKind` on
 * this gatekeeper, and the workspace has not latched restricted mode; else undefined.
 */
export function autoApprovalRule(
    storage: AutoApprovalStorage, gatekeeperId: number, description: ActionDescription)
    : AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (storage.containsRestrictedData.get()) return undefined;
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
  // Per-gatekeeper single-flight state: the running drain, and whether another was requested while
  // it ran, so work submitted during a drain isn't lost. Coalesced callers await the running
  // drain's promise, so it settles only after the rerun they requested.
  #draining = new Map<number, Promise<void>>();
  #rerun = new Set<number>();
  // Follow-up passes may overlap the ordinary drain waiting for their parent. Coalesce effects
  // by action as well, so those passes cannot dispatch an earlier sibling twice.
  #applying = new Map<number, Promise<void>>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyPendingAction: ApplyPendingActionFn) {}

  drain(gatekeeperId: number): Promise<void> {
    // An already-authorized handler may be awaiting a child while the ordinary drain awaits
    // that handler. Also revisit these children when a user enables a rule or clears a gate.
    const followups: Promise<void>[] = [];
    // kv.list permits only one live iterator; child passes read this same index again.
    const pending = [...this.storage.actions.pendingByGatekeeper.get(gatekeeperId)];
    for (const record of pending) {
      if (record.type === "action" && this.storage.actionApplications.get(record.id)?.phase === "apply") {
        for (const id of record.followupActionIds ?? []) followups.push(this.#drainOnce(gatekeeperId, id));
      }
    }
    let running = this.#draining.get(gatekeeperId);
    if (running) {
      this.#rerun.add(gatekeeperId);
    } else {
      running = this.#drainWhileRequested(gatekeeperId);
      this.#draining.set(gatekeeperId, running);
    }
    return followups.length ? Promise.all([running, ...followups]).then(() => {}) : running;
  }

  async #drainWhileRequested(gatekeeperId: number): Promise<void> {
    try {
      do {
        this.#rerun.delete(gatekeeperId);
        await this.#drainOnce(gatekeeperId);
      } while (this.#rerun.has(gatekeeperId));
    } finally {
      this.#draining.delete(gatekeeperId);
    }
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops
  // at the first pending action that is NOT auto-eligible (a manual gate) or that throws while
  // applying. A child-scoped pass skips only already-authorized ancestors and ends at that child;
  // it never applies unrelated later actions past the parent's still-pending record.
  //
  // Eligibility is `autoApprovalRule()`: the author's `autoApprovable` verdict, a user-enabled
  // rule for the action's kind, and no restricted-data latch.
  async #drainOnce(gatekeeperId: number, followupId?: number): Promise<void> {
    // Materialize before applying: the index yields lazily in ascending id order, and applying
    // mutates it mid-iteration. Actions created after this snapshot trigger their own drain(),
    // which drain()'s rerun flag folds into this run if it's still in flight.
    let pending = [...this.storage.actions.pendingByGatekeeper.get(gatekeeperId)];

    const ancestors = new Set<number>();
    if (followupId !== undefined) {
      // Child IDs are allocated after their parents. Walk backwards to find exactly this child's
      // ancestry, including nested follow-ups; never skip another command's approval journal.
      const descendants = new Set([followupId]);
      for (const record of pending.toReversed()) {
        if (record.type === "action" && record.followupActionIds?.some(id => descendants.has(id))) {
          ancestors.add(record.id);
          descendants.add(record.id);
        }
      }
    }

    for (let record of pending) {
      if (followupId !== undefined && record.id > followupId) return;
      if (record.type !== "action") continue;

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }
      if (ancestors.has(fresh.id) && this.storage.actionApplications.get(fresh.id)?.phase === "apply") continue;

      let rule = autoApprovalRule(this.storage, gatekeeperId, fresh.description);
      if (rule === undefined) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        return;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority.
        let applying = this.#applying.get(fresh.id);
        if (!applying) {
          applying = this.applyPendingAction(fresh, rule.enabledBy, true)
            .finally(() => { this.#applying.delete(fresh.id); });
          this.#applying.set(fresh.id, applying);
        }
        await applying;
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
