import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  AutoApprovalDrainer,
  AutoApprovalStorage,
  ApplyPendingActionFn,
  clearAutoApprovalRules,
  handleActionApplyFailure,
} from "../src/auto-approval.js";
import type { ActionRecord, AutoApproveTagRecord } from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import {
  createActionDispatchStoppedError,
} from "@gadgets/workshop-shared/gatekeeper";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): AutoApprovalStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      actions: collection<ActionRecord>()({ primaryKey: "id" }),
      autoApproveTags: collection<AutoApproveTagRecord>()({
        primaryKey: (r: AutoApproveTagRecord) => `${r.gatekeeperId}:${r.actionKind.tag}`,
      }),
    },
  });
}

const GK = 1;
const ENABLER: AiChatAuthorInfo = { type: "user", id: "enabler@example.com", name: "Enabler" };

function enableRule(storage: AutoApprovalStorage, actionTag = "edit", gatekeeperId = GK) {
  storage.autoApproveTags.put({
    gatekeeperId, actionKind: { tag: actionTag, label: "Edits" }, enabledBy: ENABLER });
}

function putAction(
    storage: AutoApprovalStorage, id: number,
    opts: { gatekeeperId?: number; actionTag?: string; autoApprovable?: boolean;
            state?: ActionRecord["state"] } = {}) {
  storage.actions.put({
    id,
    gatekeeperId: opts.gatekeeperId ?? GK,
    caller: { from: "agent", chatId: 1 },
    createdAt: new Date(),
    state: opts.state ?? "pending",
    type: "action",
    action: id,
    description: {
      title: `Action ${id}`,
      description: `Action ${id} description`,
      implementsRevert: true,
      actionKind: { tag: opts.actionTag ?? "edit", label: "Edits" },
      autoApprovable: opts.autoApprovable ?? true,
    },
  });
}

function getAction(storage: AutoApprovalStorage, id: number): ActionRecord & {type: "action"} {
  let record = storage.actions.get(id);
  if (!record || record.type !== "action") throw new Error(`No action ${id}`);
  return record;
}

// An apply fn that resolves immediately, mirroring OverseerImpl.applyPendingAction's effect:
// mark the record approved and persist. Records the order of applied action ids.
function makeImmediateApply(storage: AutoApprovalStorage) {
  let calls: number[] = [];
  let applyFn: ApplyPendingActionFn = async (record, resolvedBy, autoApproved) => {
    calls.push(record.id);
    let fresh = storage.actions.get(record.id);
    if (fresh && fresh.type === "action") {
      fresh.state = "approved";
      fresh.appliedAt = new Date();
      fresh.resolvedBy = resolvedBy;
      fresh.autoApproved = autoApproved;
      storage.actions.put(fresh);
    }
    return "approved";
  };
  return { applyFn, calls };
}

// An apply fn whose every invocation parks on a test-held promise until released. Lets a test hold
// an apply mid-flight (input gate open) while launching a second concurrent drain. On release it
// performs the same approve+persist effect as the real apply.
function makeControlledApply(storage: AutoApprovalStorage) {
  let calls: number[] = [];
  let gates: Array<() => void> = [];
  let applyFn: ApplyPendingActionFn = (record, resolvedBy, autoApproved) => {
    calls.push(record.id);
    return new Promise<"approved">((resolve) => {
      gates.push(() => {
        let fresh = storage.actions.get(record.id);
        if (fresh && fresh.type === "action") {
          fresh.state = "approved";
          fresh.appliedAt = new Date();
          fresh.resolvedBy = resolvedBy;
          fresh.autoApproved = autoApproved;
          storage.actions.put(fresh);
        }
        resolve("approved");
      });
    });
  };
  return {
    applyFn,
    calls,
    inFlight: () => gates.length,
    releaseNext() {
      let gate = gates.shift();
      if (!gate) throw new Error("no apply in flight to release");
      gate();
    },
  };
}

// Drain all microtasks (and the macrotask queue) so suspended drain continuations run to their next
// park point.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AutoApprovalDrainer.drain", () => {
  it("applies all eligible pending actions in ascending id order", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 2, 3]);
    for (let id of [1, 2, 3]) {
      let record = getAction(storage, id);
      expect(record.state).toBe("approved");
      expect(record.autoApproved).toBe(true);
      expect(record.resolvedBy?.id).toBe(ENABLER.id);
    }
  });

  it("stops at a manual gate without skipping ahead, then resumes once it clears", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { autoApprovable: false });  // manual gate
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn);
    await drainer.drain(GK);

    // Only the action before the gate is applied; the gate and everything behind it stay pending.
    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");

    // Clear the gate (as a manual approval would) and re-drain: the rest applies, still in order.
    let gate = getAction(storage, 2);
    gate.state = "approved";
    storage.actions.put(gate);
    await drainer.drain(GK);

    expect(calls).toEqual([1, 3]);
    expect(getAction(storage, 3).state).toBe("approved");
  });

  it("allows auto-approval again after the user explicitly re-enables a cleared rule", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    const calls: number[] = [];
    const apply: ApplyPendingActionFn = async record => {
      calls.push(record.id);
      if (record.id === 1) {
        record.state = "rejected";
        record.invalidationReason = "Policy changed.";
        clearAutoApprovalRules(storage, GK);
        storage.actions.put(record);
        return "stopped";
      }
      record.state = "approved";
      storage.actions.put(record);
      return "approved";
    };

    await new AutoApprovalDrainer(storage, apply).drain(GK);

    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");

    expect(storage.autoApproveTags.get(`${GK}:edit`)).toBeUndefined();
    enableRule(storage);
    await new AutoApprovalDrainer(storage, apply).drain(GK);

    expect(calls).toEqual([1, 2]);
    expect(getAction(storage, 2).state).toBe("approved");
  });

  it("does not restart after invalidation when a concurrent drain requested a rerun", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    const calls: number[] = [];
    let release!: () => void;
    const apply: ApplyPendingActionFn = record => {
      calls.push(record.id);
      return new Promise(resolve => {
        release = () => {
          record.state = "rejected";
          record.invalidationReason = "Policy changed.";
          storage.actions.put(record);
          resolve("stopped");
        };
      });
    };
    const drainer = new AutoApprovalDrainer(storage, apply);

    const first = drainer.drain(GK);
    await flush();
    await drainer.drain(GK);
    release();
    await first;

    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("stops when a later candidate is invalidated after the drain snapshot", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);
    let apply = makeControlledApply(storage);
    let draining = new AutoApprovalDrainer(storage, apply.applyFn).drain(GK);
    await flush();

    let invalidated = getAction(storage, 2);
    invalidated.state = "rejected";
    invalidated.invalidationReason = "Policy changed.";
    storage.actions.put(invalidated);
    apply.releaseNext();
    await flush();
    const callsAfterInvalidation = [...apply.calls];
    if (apply.inFlight() > 0) apply.releaseNext();
    await draining;

    expect(callsAfterInvalidation).toEqual([1]);
    expect(getAction(storage, 3).state).toBe("pending");
  });

  // Two concurrent drains for the same gatekeeper must not double-apply. The input gate is open
  // across the apply await, so without the single-flight guard the second drain's pending re-check
  // would see the still-"pending" record and apply it again.
  it("never applies an action more than once under concurrent drains", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);

    let first = drainer.drain(GK);   // starts, calls apply(1), parks mid-apply
    let second = drainer.drain(GK);  // must coalesce, not start a second apply
    await second;

    expect(apply.calls).toEqual([1]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // resolve apply(1); record becomes approved
    await first;                     // rerun pass re-lists: action 1 no longer pending -> no re-apply

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  // Work that arrives while a drain is parked must still be applied -- the coalescing
  // "rerun" flag must not drop the wakeup.
  it("applies work submitted while a drain is parked mid-apply", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);

    let first = drainer.drain(GK);   // parks mid-apply on action 1

    putAction(storage, 2);           // new eligible action arrives mid-drain
    let second = drainer.drain(GK);  // coalesces -> sets the rerun flag
    await second;
    expect(apply.calls).toEqual([1]);

    apply.releaseNext();             // finish action 1; rerun pass should pick up action 2
    await flush();

    expect(apply.calls).toEqual([1, 2]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // finish action 2
    await first;

    expect(apply.calls).toEqual([1, 2]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("approved");
  });
});

describe("clearAutoApprovalRules", () => {
  it("removes every rule for the invalidated gatekeeper and leaves other connections alone", () => {
    const storage = makeStorage();
    enableRule(storage, "edit", GK);
    enableRule(storage, "delete", GK);
    enableRule(storage, "edit", 2);

    clearAutoApprovalRules(storage, GK);

    expect(storage.autoApproveTags.get(`${GK}:edit`)).toBeUndefined();
    expect(storage.autoApproveTags.get(`${GK}:delete`)).toBeUndefined();
    expect(storage.autoApproveTags.get("2:edit")).toBeDefined();
  });

  it("materializes the lazy rule list before deleting from its collection", () => {
    let iterating = false;
    const deleted: string[] = [];
    const rules: AutoApproveTagRecord[] = [
      { gatekeeperId: GK, actionKind: { tag: "edit", label: "Edits" }, enabledBy: ENABLER },
      { gatekeeperId: GK, actionKind: { tag: "delete", label: "Deletes" }, enabledBy: ENABLER },
    ];
    const autoApproveTags = {
      *list() {
        iterating = true;
        try {
          yield* rules;
        } finally {
          iterating = false;
        }
      },
      delete(key: string) {
        if (iterating) throw new Error("collection iterator invalidated");
        deleted.push(key);
      },
    } as unknown as AutoApprovalStorage["autoApproveTags"];

    expect(() => clearAutoApprovalRules({ autoApproveTags }, GK)).not.toThrow();
    expect(deleted).toEqual([`${GK}:edit`, `${GK}:delete`]);
  });
});

describe("handleActionApplyFailure", () => {
  it("preserves rules when an action predates approval snapshots", () => {
    const storage = makeStorage();
    enableRule(storage, "edit");
    enableRule(storage, "delete");

    expect(handleActionApplyFailure(
      storage,
      GK,
      createActionDispatchStoppedError("restage", "Stage the call again."),
    )).toBe("Stage the call again.");
    expect([...storage.autoApproveTags.list()].map(rule => rule.actionKind.tag).toSorted())
      .toEqual(["delete", "edit"]);
  });

  it("clears rules when the approval context changed", () => {
    const storage = makeStorage();
    enableRule(storage, "edit");
    enableRule(storage, "delete");

    expect(handleActionApplyFailure(
      storage,
      GK,
      createActionDispatchStoppedError("invalidated", "The connection changed."),
    )).toBe("The connection changed.");
    expect([...storage.autoApproveTags.list()]).toEqual([]);
  });
});
