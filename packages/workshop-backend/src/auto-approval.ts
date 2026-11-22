// Auto-approval's drain core, which hands the pending actions a selector picks on a gatekeeper to
// the routine that applies a list, with a per-gatekeeper single-flight guard so that work
// submitted during a drain (the DO's input gate is open across the apply await) is drained too.
// Both the selector and the apply are injected, keeping this constructible in tests.

import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord } from "./storage-schema/overseer-storage.js";

const logger = createWorkshopLogger("workshop.auto.approval");

/**
 * A pending action to apply, and the user it is applied as. `eligible`, when present, says whether
 * it may still be applied so, and is asked again before each call to the gatekeeper: the apply
 * stops before the first action that may not.
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
      private applyActionList: ApplyActionListFn,
      // What a drain applies on the gatekeeper, as it stands just before the apply claims it: the
      // staged actions, which apply at once (see OverseerImpl.drainAutoApprovals).
      private select: (gatekeeperId: number) => ApplyItem[]) {}

  /** Settles once no drain runs on the gatekeeper: at once, if none does. Never rejects. */
  async settled(gatekeeperId: number): Promise<void> {
    await this.#draining.get(gatekeeperId);
  }

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

  // Applies what `select` picks on the gatekeeper as one list, which stops at the first action
  // that fails: nothing is ever skipped ahead of.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Actions created after the list is picked trigger their own drain(), which drain()'s rerun
    // flag folds into this run if it's still in flight. Nothing to apply: no apply to start.
    let select = () => this.select(gatekeeperId);
    if (select().length === 0) return;
    try {
      await this.applyActionList(gatekeeperId, select);
    } catch (err) {
      // Leave the action pending for manual handling and stop the drain (never skip ahead).
      logger.error("auto-approval failed", {
        event: "auto.approval.failed", gatekeeperId, error: err,
      });
    }
  }
}
