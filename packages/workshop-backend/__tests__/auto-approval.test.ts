import { describe, it, expect } from "vitest";
import { AutoApprovalDrainer, ApplyActionListFn, ApplyItem, autoApprovalRule }
    from "../src/auto-approval.js";
import type { ActionRecord, StoredActionDescription }
    from "../src/storage-schema/overseer-storage.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { makeActionStorage, putAction, type ActionTestStorage } from "./fixtures.js";

const makeStorage = makeActionStorage;

const GK = 1;
const ENABLER: AiChatAuthorInfo = { type: "user", id: "enabler@example.com", name: "Enabler" };

function enableRule(storage: ActionTestStorage, actionTag = "edit", gatekeeperId = GK) {
  storage.autoApproveTags.put({
    gatekeeperId, actionKind: { tag: actionTag, label: "Edits" }, enabledBy: ENABLER });
}

function getAction(storage: ActionTestStorage, id: number): ActionRecord & {type: "action"} {
  let record = storage.actions.get(id);
  if (!record || record.type !== "action") throw new Error(`No action ${id}`);
  return record;
}

// Applies one action, as the routine that applies a list does for each in turn.
type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"}, resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

// The routine that applies a list, for a gatekeeper that applies one action at a time.
function sequentially(applyFn: ApplyPendingActionFn): ApplyActionListFn {
  return async (_gatekeeperId, select) => {
    for (let {record, resolvedBy} of select()) await applyFn(record, resolvedBy, true);
  };
}

// What a drain applies, standing in for the staged run (OverseerImpl.#stagedRun): every pending
// action on the gatekeeper, in ID order, as ENABLER.
function everyPending(storage: ActionTestStorage) {
  return (gatekeeperId: number): ApplyItem[] =>
      [...storage.actions.pendingByGatekeeper.get(gatekeeperId)].flatMap(record =>
          record.type === "action" ? [{record, resolvedBy: ENABLER}] : []);
}

// An apply fn that resolves immediately, mirroring OverseerImpl.applyPendingAction's effect:
// mark the record approved and persist. Records the order of applied action ids.
function makeImmediateApply(storage: ActionTestStorage) {
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
function makeControlledApply(storage: ActionTestStorage) {
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
  it("applies what its selector picks, in order, automatically", async () => {
    let storage = makeStorage();
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(sequentially(applyFn), everyPending(storage)).drain(GK);

    expect(calls).toEqual([1, 2, 3]);
    for (let id of [1, 2, 3]) {
      let record = getAction(storage, id);
      expect(record.state).toBe("approved");
      expect(record.autoApproved).toBe(true);
      expect(record.resolvedBy?.id).toBe(ENABLER.id);
    }
  });

  it("starts no apply when its selector picks nothing", async () => {
    let started = false;
    let drainer = new AutoApprovalDrainer(async () => { started = true; }, () => []);
    await drainer.drain(GK);
    expect(started).toBe(false);
  });

  // Two concurrent drains for the same gatekeeper must not double-apply. The input gate is open
  // across the apply await, so without the single-flight guard the second drain's pending re-check
  // would see the still-"pending" record and apply it again.
  it("never applies an action more than once under concurrent drains", async () => {
    let storage = makeStorage();
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(sequentially(apply.applyFn), everyPending(storage));

    let first = drainer.drain(GK);   // starts, calls apply(1), parks mid-apply
    let second = drainer.drain(GK);  // must coalesce, not start a second apply
    await flush();

    expect(apply.calls).toEqual([1]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // resolve apply(1); record becomes approved
    await Promise.all([first, second]);  // rerun re-lists: action 1 no longer pending

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  // Work that arrives while a drain is parked must still be applied -- the coalescing "rerun" flag
  // must not drop the wakeup -- and the coalesced caller must see it applied when drain() resolves.
  it("applies work submitted mid-drain before resolving the drain that requested it", async () => {
    let storage = makeStorage();
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(sequentially(apply.applyFn), everyPending(storage));

    let first = drainer.drain(GK);   // parks mid-apply on action 1

    putAction(storage, 2);           // new action arrives mid-drain
    let secondResolved = false;
    let second = drainer.drain(GK).then(() => { secondResolved = true; });
    let settled = drainer.settled(GK);

    apply.releaseNext();             // finish action 1; rerun pass should pick up action 2
    await flush();

    expect(apply.calls).toEqual([1, 2]);
    expect(apply.inFlight()).toBe(1);
    expect(secondResolved).toBe(false);

    apply.releaseNext();             // finish action 2
    await Promise.all([first, second, settled]);

    expect(apply.calls).toEqual([1, 2]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("approved");
  });

  it("halts when an apply fails, leaving it and everything after pending", async () => {
    let storage = makeStorage();
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let inner = makeImmediateApply(storage);
    let applyFn: ApplyPendingActionFn = (record, resolvedBy, autoApproved) => {
      if (record.id === 2) throw new Error("apply failed");
      return inner.applyFn(record, resolvedBy, autoApproved);
    };
    await new AutoApprovalDrainer(sequentially(applyFn), everyPending(storage)).drain(GK);

    expect(inner.calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  // An action created after a drain snapshotted the pending index is out of that drain's scope;
  // the creation path is responsible for its own drain() call (which the rerun flag folds in --
  // see the parked-mid-apply test above).
  it("leaves actions created after the drain's snapshot for their own drain call", async () => {
    let storage = makeStorage();
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(sequentially(apply.applyFn), everyPending(storage));
    let first = drainer.drain(GK);   // snapshots pending = [1]

    putAction(storage, 2);           // arrives mid-drain, with no accompanying drain() call
    apply.releaseNext();
    await first;

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
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
    expect(autoApprovalRule(storage, GK, eligibleDescription({ autoApprovable: false })))
        .toBeUndefined();
  });

  it("refuses a stored description that predates the verdict", () => {
    let storage = makeStorage();
    enableRule(storage);
    let legacy: StoredActionDescription = {
      title: "Edit the thing",
      description: "Edits the thing.",
      implementsRevert: true,
      actionKind: { tag: "edit", label: "Edits" },
    };
    expect(autoApprovalRule(storage, GK, legacy)).toBeUndefined();
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

  it("refuses every action while the restricted-data latch is set", () => {
    let storage = makeStorage();
    enableRule(storage);
    enableRule(storage, "edit", GK + 1);
    storage.containsRestrictedData.put(true);
    // The latch is workspace-wide: every action submitAction lets pend must be read by a human,
    // on every gatekeeper.
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    expect(autoApprovalRule(storage, GK + 1, eligibleDescription())).toBeUndefined();
  });
});
