// Auto-approval drain core: applies the gatekeeper's eligible pending actions (read off the sparse
// pendingByGatekeeper index) in id order, with a per-gatekeeper single-flight guard so two
// concurrent drains (the DO's input gate is open across the apply await) can't double-apply the
// same action. The apply is injected, keeping this constructible over a mock storage in tests.

import type { Collection, NonUniqueIndex, Singleton } from "@gadgets/typed-storage";
import { ADMIN_AGENT_ACTIONS, adminAgentAction } from "@gadgets/workshop-shared/admin-agent";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import {
  isAdminGatekeeper,
  type ActionRecord, type AutoApproveTagRecord, type GatekeeperRecord,
  type StoredActionDescription,
} from "./storage-schema/overseer-storage.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>
      & { pendingByGatekeeper: NonUniqueIndex<ActionRecord, number> };
  autoApproveTags: Collection<AutoApproveTagRecord>;
  /** The connections, by id: ruleApplies() reads a connection's vendor from its record. */
  gatekeepers: Collection<GatekeeperRecord, number>;

  /** The restricted-data latch (see makeOverseerStorage). */
  containsRestrictedData: Singleton<boolean>;
  /** Whether only the admin gatekeeper's observations set the latch (see makeOverseerStorage). */
  adminRestrictedDataOnly: Singleton<boolean>;
}

/**
 * Whether a rule may apply an action tagged `tag` of connection `gatekeeperId` in the workspace
 * as it is now. Always, while the workspace holds no restricted data. Once it does, only when
 * all three hold: the connection is the admin gatekeeper's, by its stored record's vendor and
 * nothing its Worker declares; `tag` is that of a kind ADMIN_AGENT_ACTIONS marks
 * `autoApprovableWhileRestricted`; and every observation that marked the workspace came
 * through the admin gatekeeper (storage.adminRestrictedDataOnly). The exception is the
 * Workshop's own: no ActionDescription asks for it and no other vendor can have it. Read by
 * autoApprovalRule(), by OverseerImpl.lendAdminApi() where the power is handed over, and by
 * listPreApprovableActions(), which tells clients.
 */
export function ruleApplies(storage: AutoApprovalStorage, gatekeeperId: number, tag: string)
    : boolean {
  if (!storage.containsRestrictedData.get()) return true;
  let kind = adminAgentAction(tag);
  return kind !== undefined && ADMIN_AGENT_ACTIONS[kind].autoApprovableWhileRestricted &&
      storage.adminRestrictedDataOnly.get() &&
      isAdminGatekeeper(storage.gatekeepers.get(gatekeeperId));
}

/**
 * The single authority on whether an action may be applied without a human: the enabling rule if
 * the author marked the action `autoApprovable`, the user enabled a rule for its `actionKind` on
 * this gatekeeper, and ruleApplies() allows it in the workspace as it is now; else undefined. A
 * stored description may lack the verdict, which counts as no.
 */
export function autoApprovalRule(
    storage: AutoApprovalStorage, gatekeeperId: number, description: StoredActionDescription)
    : AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (!ruleApplies(storage, gatekeeperId, tag)) return undefined;
  return storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
}

/**
 * Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist.
 * Refuses an action that is no longer pending or whose decision is in flight; the drain checks
 * both first, so neither reaches it as a failure.
 */
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state: the running drain, and whether another was requested while
  // it ran, so work submitted during a drain isn't lost. Coalesced callers share the running
  // drain's promise, so it settles only after the rerun they requested.
  #draining = new Map<number, Promise<void>>();
  #rerun = new Set<number>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyPendingAction: ApplyPendingActionFn,
      // Whether an action has a decision in flight (see OverseerImpl.claimDecision). The apply
      // would refuse one anyway, and the catch below would stop there just the same; asking
      // first keeps that ordinary race out of the failure log.
      private isDeciding: (id: number) => boolean) {}

  drain(gatekeeperId: number): Promise<void> {
    let running = this.#draining.get(gatekeeperId);
    if (running) {
      this.#rerun.add(gatekeeperId);
      return running;
    }
    running = this.#drainWhileRequested(gatekeeperId);
    this.#draining.set(gatekeeperId, running);
    return running;
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
  // applying -- it is never skipped ahead of. This preserves in-order application and the
  // invariant that nothing is silently applied past a human gate.
  //
  // Eligibility is `autoApprovalRule()`: the author's `autoApprovable` verdict, a user-enabled
  // rule for the action's kind, and ruleApplies().
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
      // Someone is already deciding this one by hand. Stop rather than skip ahead, as at a manual
      // gate. A decision that lands drains again; one that fails does not, and leaves the action
      // for a person, as a failed apply here does -- draining after a failed rejection would
      // apply what someone just tried to reject.
      if (this.isDeciding(fresh.id)) return;

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
