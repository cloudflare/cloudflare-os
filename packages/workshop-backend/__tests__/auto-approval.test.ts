import { describe, it, expect } from "vitest";
import { AutoApprovalDrainer, AutoApprovalStorage, ApplyPendingActionFn, autoApprovalRule }
    from "../src/auto-approval.js";
import type { ActionRecord } from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { makeMockStorage } from "./mock-storage.js";
import { makeActionStorage, makePreIndexActionStorage, putAction } from "./fixtures.js";

const makeStorage = makeActionStorage;

const GK = 1;
const ENABLER: AiChatAuthorInfo = { type: "user", id: "enabler@example.com", name: "Enabler" };

function enableRule(storage: AutoApprovalStorage, actionTag = "edit", gatekeeperId = GK) {
  storage.autoApproveTags.put({
    gatekeeperId, actionKind: { tag: actionTag, label: "Edits" }, enabledBy: ENABLER });
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
    return new Promise<void>((resolve) => {
      gates.push(() => {
        let fresh = storage.actions.get(record.id);
        if (fresh && fresh.type === "action") {
          fresh.state = "approved";
          fresh.appliedAt = new Date();
          fresh.resolvedBy = resolvedBy;
          fresh.autoApproved = autoApproved;
          storage.actions.put(fresh);
        }
        resolve();
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

  it("drains a large log, applying eligible actions in ascending order", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let eligible: number[] = [];
    for (let id = 0; id < 230; id++) {
      if (id % 5 === 0) {
        putAction(storage, id, { gatekeeperId: GK + 1 });   // other gatekeeper: skipped, not a gate
      } else if (id % 5 === 1) {
        putAction(storage, id, { state: "approved" });      // already resolved
      } else {
        putAction(storage, id);
        eligible.push(id);
      }
    }

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual(eligible);
  });

  it("halts at a manual gate deep in the log", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let gateId = 105;
    for (let id = 0; id < 120; id++) {
      putAction(storage, id, { autoApprovable: id !== gateId });
    }

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual(Array.from({ length: gateId }, (_, i) => i));
    expect(getAction(storage, gateId).state).toBe("pending");
    expect(getAction(storage, gateId + 1).state).toBe("pending");
  });

  it("drains pendings written before the index existed once a rebuild backfills it", async () => {
    // Mirrors the version-3 migration: the records predate the action-index declarations.
    let mock = makeMockStorage();
    let legacy = makePreIndexActionStorage(mock);
    putAction(legacy, 1);
    putAction(legacy, 2, { state: "approved" });
    putAction(legacy, 3);

    let storage = makeStorage(mock);
    storage.actions.pendingByGatekeeper.rebuild();
    storage.actions.byHistoryFilter.rebuild();
    storage.actions.byLastChanged.rebuild();
    enableRule(storage);

    // The apply persists a resolved state, which must not throw on the backfilled index.
    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 3]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 3).state).toBe("approved");
  });

  it("halts when an apply fails, leaving it and everything after pending", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let inner = makeImmediateApply(storage);
    let applyFn: ApplyPendingActionFn = (record, resolvedBy, autoApproved) => {
      if (record.id === 2) throw new Error("apply failed");
      return inner.applyFn(record, resolvedBy, autoApproved);
    };
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(inner.calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  // An action created after a drain snapshotted the pending index is out of that drain's scope;
  // the creation path is responsible for its own drain() call (which the rerun flag folds in --
  // see the parked-mid-apply test above).
  it("leaves actions created after the drain's snapshot for their own drain call", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);
    let first = drainer.drain(GK);   // snapshots pending = [1]

    putAction(storage, 2);           // arrives mid-drain, with no accompanying drain() call
    apply.releaseNext();
    await first;

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("stops at a warned action without skipping ahead", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1, { operatorWarnings: ["cross-account data risk"] });
    putAction(storage, 2);

    let apply = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, apply.applyFn).drain(GK);

    expect(apply.calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("applies nothing while the workspace is latched, even with a matching rule", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    storage.prohibitAllSharing.put(true);

    let apply = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, apply.applyFn).drain(GK);

    expect(apply.calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
  });
});

// A description that passes every gate, for the predicate tests to knock single gates out of.
function eligibleDescription(overrides: Partial<ActionDescription> = {}): ActionDescription {
  return {
    title: "Edit the thing",
    description: "Edits the thing.",
    implementsRevert: true,
    actionKind: { tag: "edit", label: "Edits" },
    autoApprovable: true,
    ...overrides,
  };
}

describe("autoApprovalRule", () => {
  it("returns the enabling rule when every gate passes", () => {
    let storage = makeStorage();
    enableRule(storage);
    let rule = autoApprovalRule(storage, GK, eligibleDescription());
    expect(rule?.enabledBy).toEqual(ENABLER);
  });

  it("requires the author's autoApprovable verdict", () => {
    let storage = makeStorage();
    enableRule(storage);
    expect(autoApprovalRule(storage, GK, eligibleDescription({ autoApprovable: undefined })))
        .toBeUndefined();
    expect(autoApprovalRule(storage, GK, eligibleDescription({ autoApprovable: false })))
        .toBeUndefined();
  });

  it("requires an actionKind", () => {
    let storage = makeStorage();
    enableRule(storage);
    expect(autoApprovalRule(storage, GK, eligibleDescription({ actionKind: undefined })))
        .toBeUndefined();
  });

  it("requires a user-enabled rule for the kind on this gatekeeper", () => {
    let storage = makeStorage();
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    enableRule(storage, "edit", GK + 1);  // right tag, wrong gatekeeper
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    enableRule(storage, "delete", GK);    // right gatekeeper, wrong tag
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
  });

  it("refuses any action carrying operator warnings", () => {
    let storage = makeStorage();
    enableRule(storage);
    expect(autoApprovalRule(
        storage, GK, eligibleDescription({ operatorWarnings: ["watch out"] })))
        .toBeUndefined();
    // An empty array carries no warning to read, so it does not disqualify.
    expect(autoApprovalRule(storage, GK, eligibleDescription({ operatorWarnings: [] })))
        .toBeDefined();
  });

  it("refuses every action while the restricted-data latch is set", () => {
    let storage = makeStorage();
    enableRule(storage);
    enableRule(storage, "edit", GK + 1);
    storage.prohibitAllSharing.put(true);
    // The latch is workspace-wide: even a write-to-self (which submitAction lets pend) must be
    // read by a human, on every gatekeeper.
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    expect(autoApprovalRule(storage, GK + 1, eligibleDescription())).toBeUndefined();
  });
});
