// Auto-approval drain core: picks the gatekeeper's eligible pending actions (read off the sparse
// pendingByGatekeeper index) in id order and hands them to the routine that applies a list, with a
// per-gatekeeper single-flight guard so that work submitted during a drain (the DO's input gate is
// open across the apply await) is drained too. The apply is injected, keeping this constructible
// over a mock storage in tests.

import type { Collection, NonUniqueIndex, Singleton } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import type {
  ActionRecord, AutoApproveTagRecord, StoredActionDescription,
} from "./storage-schema/overseer-storage.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>
      & { pendingByGatekeeper: NonUniqueIndex<ActionRecord, number> };
  autoApproveTags: Collection<AutoApproveTagRecord>;

  /** The restricted-data latch (see makeOverseerStorage). While set, nothing auto-approves. */
  containsRestrictedData: Singleton<boolean>;
}

/**
 * The single authority on whether an action may be applied without a human: the enabling rule if
 * the author marked the action `autoApprovable`, the user enabled a rule for its `actionKind` on
 * this gatekeeper, and the workspace has not latched restricted mode; else undefined. A stored
 * description may lack the verdict, which counts as no.
 */
export function autoApprovalRule(
    storage: AutoApprovalStorage, gatekeeperId: number, description: StoredActionDescription)
    : AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (storage.containsRestrictedData.get()) return undefined;
  return storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
}

/**
 * A pending action to apply, and the user it is applied as. `eligible`, when present, says whether
 * it may still be applied so, and is asked again before each call to the gatekeeper: the apply
 * stops before the first action that may not, as the auto-approval drain stops at a manual gate.
 */
export type ApplyItem = {
  record: ActionRecord & {type: "action"},
  resolvedBy: AiChatAuthorInfo,
  eligible?: () => boolean,
};

/**
 * Applies, automatically, the pending actions of a gatekeeper that `select` picks, in order, and
 * marks them approved (OverseerImpl.applyActionList). `select` runs synchronously just before they
 * are claimed. Throws at the first that fails, leaving it and those after it pending.
 */
export type ApplyActionListFn =
    (gatekeeperId: number, select: () => ApplyItem[]) => Promise<void>;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state: the running drain, and whether another was requested while
  // it ran, so work submitted during a drain isn't lost. Coalesced callers share the running
  // drain's promise, so it settles only after the rerun they requested.
  #draining = new Map<number, Promise<void>>();
  #rerun = new Set<number>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyActionList: ApplyActionListFn,
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

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order, as one
  // list. It ends before the first pending action that is NOT auto-eligible (a manual gate), and
  // the apply stops at the first that fails -- neither is ever skipped ahead of. This preserves
  // in-order application and the invariant that nothing is silently applied past a human gate.
  //
  // Eligibility is `autoApprovalRule()`: the author's `autoApprovable` verdict, a user-enabled
  // rule for the action's kind, and no restricted-data latch.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Actions created after the list is picked trigger their own drain(), which drain()'s rerun
    // flag folds into this run if it's still in flight. Nothing eligible: no apply to start.
    if (this.#eligible(gatekeeperId).length === 0) return;
    try {
      await this.applyActionList(gatekeeperId, () => this.#eligible(gatekeeperId));
    } catch (err) {
      // Leave the action pending for manual handling and stop the drain (never skip ahead).
      logger.error("auto-approval failed", {
        event: "auto.approval.failed", gatekeeperId, error: err,
      });
    }
  }

  // The leading run of the gatekeeper's pending actions that may apply automatically, each
  // attributed to the user who enabled its rule -- it runs under their authority.
  #eligible(gatekeeperId: number): ApplyItem[] {
    let eligible: ApplyItem[] = [];
    for (let record of this.storage.actions.pendingByGatekeeper.get(gatekeeperId)) {
      if (record.type !== "action") continue;
      let rule = autoApprovalRule(this.storage, gatekeeperId, record.description);
      // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
      if (rule === undefined) break;
      // Someone is already deciding this one by hand. Stop rather than skip ahead, as at a manual
      // gate. A decision that lands drains again; one that fails does not, and leaves the action
      // for a person, as a failed apply here does -- draining after a failed rejection would
      // apply what someone just tried to reject.
      if (this.isDeciding(record.id)) break;
      // A rule withdrawn, or the restricted-data latch set, while earlier actions apply stops the
      // rest.
      eligible.push({record, resolvedBy: rule.enabledBy, eligible: () =>
          autoApprovalRule(this.storage, gatekeeperId, record.description) !== undefined});
    }
    return eligible;
  }
}
