// Auto-approval drain core: applies eligible pending actions in id order, with a per-gatekeeper
// single-flight guard so two concurrent drains (the DO's input gate is open across the apply await)
// can't double-apply the same action. The apply is injected, keeping this constructible over a
// mock storage in tests.

import type { Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import {
  getActionDispatchStopped,
} from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>;
  autoApproveTags: Collection<AutoApproveTagRecord>;
}

/**
 * Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist. The
 * caller has already validated that the record is still pending.
 */
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<"approved" | "stopped">;

/** Removes every auto-approval rule for a gatekeeper after its approval context becomes invalid. */
export function clearAutoApprovalRules(
    storage: Pick<AutoApprovalStorage, "autoApproveTags">, gatekeeperId: number): void {
  const keys = [...storage.autoApproveTags.list()]
    .filter(rule => rule.gatekeeperId === gatekeeperId)
    .map(rule => `${gatekeeperId}:${rule.actionKind.tag}`);
  for (const key of keys) {
    storage.autoApproveTags.delete(key);
  }
}

/**
 * Recognizes a pre-dispatch action failure and returns its user-facing reason. A genuine context
 * invalidation clears every rule for the connection; a deploy-migration restage preserves them.
 */
export function handleActionApplyFailure(
    storage: Pick<AutoApprovalStorage, "autoApproveTags">,
    gatekeeperId: number,
    error: unknown): string | undefined {
  const stopped = getActionDispatchStopped(error);
  if (stopped?.kind === "invalidated") {
    clearAutoApprovalRules(storage, gatekeeperId);
  }
  return stopped?.reason;
}

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
        if (await this.#drainOnce(gatekeeperId) === "stopped") return;
      } while (this.#draining.get(gatekeeperId));
    } finally {
      this.#draining.delete(gatekeeperId);
    }
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops at
  // the first pending action that is NOT auto-eligible (a manual gate), cannot be dispatched, or
  // throws while applying -- none is skipped ahead of.
  //
  // Eligibility requires BOTH signals: the author's `autoApprovable` verdict on the action AND a
  // user-enabled rule for the action's type on this gatekeeper.
  async #drainOnce(gatekeeperId: number): Promise<"complete" | "stopped"> {
    // Materialize a snapshot first: list() is a lazy generator over storage, and we mutate the
    // actions collection (via applyPendingAction) as we go.
    let pending = [...this.storage.actions.list()].filter(
        (rec): rec is ActionRecord & {type: "action"} =>
            rec.gatekeeperId === gatekeeperId && rec.type === "action" && rec.state === "pending");

    for (let record of pending) {
      let tag = record.description.actionKind?.tag;
      let rule = tag !== undefined
          ? this.storage.autoApproveTags.get(`${gatekeeperId}:${tag}`)
          : undefined;
      if (record.description.autoApprovable !== true || rule === undefined) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        break;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (fresh?.type === "action" && fresh.state === "rejected" &&
          fresh.invalidationReason !== undefined) return "stopped";
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority.
        const outcome = await this.applyPendingAction(fresh, rule.enabledBy, true);
        if (outcome === "stopped") return "stopped";
      } catch (err) {
        // Leave the action pending for manual handling and stop the drain (never skip ahead).
        logger.error("auto-approval failed", {
          event: "auto.approval.failed", actionId: fresh.id, error: err,
        });
        break;
      }
    }
    return "complete";
  }
}
