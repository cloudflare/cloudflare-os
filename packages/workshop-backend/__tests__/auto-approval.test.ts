import { describe, it, expect } from "vitest";
import {
  AutoApprovalDrainer, AutoApprovalStorage, ApplyPendingActionFn, autoApprovalRule,
  guardRuleExemption, ruleApplies,
} from "../src/auto-approval.js";
import type { ActionRecord, StoredActionDescription }
    from "../src/storage-schema/overseer-storage.js";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_GATEKEEPER_VENDOR_ID, type AdminAgentAction,
} from "@gadgets/workshop-shared/admin-agent";
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

// A connection of `vendorId`, as Overseer.newGatekeeper() stores one.
function putConnection(storage: AutoApprovalStorage, vendorId: string, gatekeeperId = GK) {
  let resourceUrl = `https://${vendorId}.example/resource`;
  storage.gatekeepers.put({
    id: gatekeeperId, class: {} as any,
    creationSpec: { type: "gatekeeper", vendorId, resourceUrl, typeUrlPattern: resourceUrl },
  });
}

// A workspace that holds restricted data which only its admin connection, GK, read: the one
// state in which a rule still applies some actions.
function makeAdminMarkedStorage() {
  let storage = makeStorage();
  putConnection(storage, ADMIN_GATEKEEPER_VENDOR_ID);
  storage.containsRestrictedData.put(true);
  storage.adminRestrictedDataOnly.put(true);
  return storage;
}

const tagOf = (kind: AdminAgentAction) => ADMIN_AGENT_ACTIONS[kind].kind.tag;

function getAction(storage: AutoApprovalStorage, id: number): ActionRecord & {type: "action"} {
  let record = storage.actions.get(id);
  if (!record || record.type !== "action") throw new Error(`No action ${id}`);
  return record;
}

// No decision in flight anywhere, which is every case but the one that claims one.
const NONE_DECIDING = () => false;

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
    await new AutoApprovalDrainer(storage, applyFn, NONE_DECIDING).drain(GK);

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
    let drainer = new AutoApprovalDrainer(storage, applyFn, NONE_DECIDING);
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
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn, NONE_DECIDING);

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

  // A manual decision in flight leaves its action reading as pending until it lands, so the
  // pending re-check alone would let the drain apply it a second time.
  it("stops at an action someone is already deciding, without skipping ahead", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let deciding = new Set([2]);
    let { applyFn, calls } = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn, id => deciding.has(id));
    await drainer.drain(GK);

    // Not #2, and not #3 behind it either: applying past an action that is still being decided
    // would land them out of order.
    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");

    // The decision lands (here, as a rejection), which drains again.
    let decided = getAction(storage, 2);
    decided.state = "rejected";
    storage.actions.put(decided);
    deciding.delete(2);
    await drainer.drain(GK);

    expect(calls).toEqual([1, 3]);
  });

  // Work that arrives while a drain is parked must still be applied -- the coalescing "rerun" flag
  // must not drop the wakeup -- and the coalesced caller must see it applied when drain() resolves.
  it("applies work submitted mid-drain before resolving the drain that requested it", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn, NONE_DECIDING);

    let first = drainer.drain(GK);   // parks mid-apply on action 1

    putAction(storage, 2);           // new eligible action arrives mid-drain
    let secondResolved = false;
    let second = drainer.drain(GK).then(() => { secondResolved = true; });

    apply.releaseNext();             // finish action 1; rerun pass should pick up action 2
    await flush();

    expect(apply.calls).toEqual([1, 2]);
    expect(apply.inFlight()).toBe(1);
    expect(secondResolved).toBe(false);

    apply.releaseNext();             // finish action 2
    await Promise.all([first, second]);

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
    await new AutoApprovalDrainer(storage, applyFn, NONE_DECIDING).drain(GK);

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
    await new AutoApprovalDrainer(storage, applyFn, NONE_DECIDING).drain(GK);

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
    await new AutoApprovalDrainer(storage, applyFn, NONE_DECIDING).drain(GK);

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
    await new AutoApprovalDrainer(storage, applyFn, NONE_DECIDING).drain(GK);

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
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn, NONE_DECIDING);
    let first = drainer.drain(GK);   // snapshots pending = [1]

    putAction(storage, 2);           // arrives mid-drain, with no accompanying drain() call
    apply.releaseNext();
    await first;

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("applies nothing of another vendor's connection while the workspace is latched, even with " +
     "a matching rule", async () => {
    let storage = makeStorage();
    putConnection(storage, "github");
    enableRule(storage);
    putAction(storage, 1);
    storage.containsRestrictedData.put(true);

    let apply = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, apply.applyFn, NONE_DECIDING).drain(GK);

    expect(apply.calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
  });

  describe("under the latch only the admin connection's reads set", () => {
    const RULES: AdminAgentAction[] =
        ["issueReportNote", "issueReportStatus", "issueReportAssignment", "issueReportScopedReply"];

    // Pending actions 1, 2, ... of GK, one of each kind in `kinds`, with a rule on for every
    // kind in RULES.
    async function drainKinds(kinds: AdminAgentAction[]) {
      let storage = makeAdminMarkedStorage();
      for (let kind of RULES) enableRule(storage, tagOf(kind));
      kinds.forEach((kind, index) => putAction(storage, index + 1, { actionTag: tagOf(kind) }));
      let apply = makeImmediateApply(storage);
      await new AutoApprovalDrainer(storage, apply.applyFn, NONE_DECIDING).drain(GK);
      return { storage, calls: apply.calls };
    }

    it("applies a note, a status and an assignment in order", async () => {
      let { calls } = await drainKinds(
          ["issueReportNote", "issueReportStatus", "issueReportAssignment"]);
      expect(calls).toEqual([1, 2, 3]);
    });

    it("applies nothing behind a scoped reply, which waits for a person", async () => {
      let { storage, calls } = await drainKinds(["issueReportScopedReply", "issueReportNote"]);
      expect(calls).toEqual([]);
      expect(getAction(storage, 1).state).toBe("pending");
      expect(getAction(storage, 2).state).toBe("pending");
    });

    it("applies a note and stops at the scoped reply behind it", async () => {
      let { storage, calls } = await drainKinds(
          ["issueReportNote", "issueReportScopedReply", "issueReportStatus"]);
      expect(calls).toEqual([1]);
      expect(getAction(storage, 2).state).toBe("pending");
      expect(getAction(storage, 3).state).toBe("pending");
    });

    it("holds an action judged eligible once another vendor's read ended the exemption",
       async () => {
      let storage = makeAdminMarkedStorage();
      enableRule(storage, tagOf("issueReportNote"));
      putAction(storage, 1, { actionTag: tagOf("issueReportNote") });
      expect(autoApprovalRule(storage, GK, getAction(storage, 1).description)).toBeDefined();

      storage.adminRestrictedDataOnly.put(false);

      let apply = makeImmediateApply(storage);
      await new AutoApprovalDrainer(storage, apply.applyFn, NONE_DECIDING).drain(GK);
      expect(apply.calls).toEqual([]);
      expect(getAction(storage, 1).state).toBe("pending");
    });
  });
});

describe("ruleApplies", () => {
  const KINDS = Object.keys(ADMIN_AGENT_ACTIONS) as AdminAgentAction[];

  it("allows any tag of any connection while the workspace holds no restricted data", () => {
    let storage = makeStorage();
    putConnection(storage, "github");
    expect(ruleApplies(storage, GK, "edit")).toBe(true);
    expect(ruleApplies(storage, GK, tagOf("issueReportReply"))).toBe(true);
    // A connection with no record too: the latch is all it reads here.
    expect(ruleApplies(storage, GK + 1, "edit")).toBe(true);
  });

  it("allows exactly a note, a status and an assignment of the admin connection once only its " +
     "reads marked the workspace", () => {
    let storage = makeAdminMarkedStorage();
    expect(KINDS).toHaveLength(7);
    expect(KINDS.filter(kind => ruleApplies(storage, GK, tagOf(kind))))
        .toEqual(["issueReportNote", "issueReportStatus", "issueReportAssignment"]);
  });

  it("refuses the right tag on another vendor's connection", () => {
    let storage = makeAdminMarkedStorage();
    putConnection(storage, "github", GK + 1);
    expect(ruleApplies(storage, GK + 1, tagOf("issueReportNote"))).toBe(false);
  });

  it("refuses a tag that is none of the admin gatekeeper's kinds", () => {
    let storage = makeAdminMarkedStorage();
    expect(ruleApplies(storage, GK, "edit")).toBe(false);
  });

  it("refuses everything in a workspace latched before the singleton existed", () => {
    let storage = makeStorage();
    putConnection(storage, ADMIN_GATEKEEPER_VENDOR_ID);
    storage.containsRestrictedData.put(true);
    expect(KINDS.filter(kind => ruleApplies(storage, GK, tagOf(kind)))).toEqual([]);
  });

  it("refuses a connection that has no record", () => {
    let storage = makeAdminMarkedStorage();
    expect(ruleApplies(storage, GK + 1, tagOf("issueReportNote"))).toBe(false);
  });
});

describe("guardRuleExemption", () => {
  const NOTE = tagOf("issueReportNote");

  // The workspace's storage as its object finds it when it starts: guarded, as the constructor
  // guards it.
  function start(disk: DurableObjectStorage) {
    let storage = makeStorage(disk);
    guardRuleExemption(storage);
    return storage;
  }

  // What authorizeObservation() writes for a restricted observation of the admin connection
  // that sets the latch: the singleton, the latch and the id the observation takes.
  function markThroughAdmin(storage: AutoApprovalStorage) {
    putConnection(storage, ADMIN_GATEKEEPER_VENDOR_ID);
    storage.adminRestrictedDataOnly.put(true);
    storage.containsRestrictedData.put(true);
    takeId(storage);
  }

  function takeId(storage: AutoApprovalStorage) {
    storage.nextActionId.put(storage.nextActionId.get() + 1);
  }

  it("keeps the exemption across restarts while this code takes every action id", () => {
    let disk = makeMockStorage();
    let storage = start(disk);
    // Ids taken before the mark, as in any workspace's life.
    takeId(storage);
    markThroughAdmin(storage);
    takeId(storage);
    takeId(storage);

    let restarted = start(disk);
    expect(ruleApplies(restarted, GK, NOTE)).toBe(true);
    takeId(restarted);
    expect(ruleApplies(start(disk), GK, NOTE)).toBe(true);
  });

  it.each([
    ["another connection's restricted observation", true],
    ["anything else that takes an action id", false],
  ])("ends the exemption once a version that does not keep it wrote %s", (_what, restricted) => {
    let disk = makeMockStorage();
    markThroughAdmin(start(disk));

    // The older version: the same storage with no guard, which sets the latch, takes an id and
    // leaves the singleton as it found it.
    let older = makeStorage(disk);
    if (restricted) older.containsRestrictedData.put(true);
    takeId(older);
    expect(older.adminRestrictedDataOnly.get()).toBe(true);

    let upgraded = start(disk);
    expect(upgraded.adminRestrictedDataOnly.get()).toBe(false);
    expect(ruleApplies(upgraded, GK, NOTE)).toBe(false);
    // Nothing restores it: not the ids this code takes next, nor another start.
    takeId(upgraded);
    expect(ruleApplies(start(disk), GK, NOTE)).toBe(false);
  });

  it("leaves a workspace that was never exempt as it is", () => {
    let disk = makeMockStorage();
    let storage = start(disk);
    takeId(storage);
    takeId(makeStorage(disk));
    let restarted = start(disk);
    expect(restarted.adminRestrictedDataOnly.get()).toBe(false);
    expect(ruleApplies(restarted, GK, "edit")).toBe(true);
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

  it("refuses every action of another vendor's connections while the restricted-data latch is " +
     "set", () => {
    let storage = makeStorage();
    putConnection(storage, "github");
    putConnection(storage, "github", GK + 1);
    enableRule(storage);
    enableRule(storage, "edit", GK + 1);
    storage.containsRestrictedData.put(true);
    // The latch is workspace-wide: every action submitAction lets pend must be read by a human,
    // on every gatekeeper.
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    expect(autoApprovalRule(storage, GK + 1, eligibleDescription())).toBeUndefined();
  });

  it("returns the rule for a note of the admin connection under the latch only its reads set, " +
     "and none for a scoped reply", () => {
    let storage = makeAdminMarkedStorage();
    enableRule(storage, tagOf("issueReportNote"));
    enableRule(storage, tagOf("issueReportScopedReply"));
    let described = (kind: AdminAgentAction) =>
        eligibleDescription({ actionKind: ADMIN_AGENT_ACTIONS[kind].kind });

    expect(autoApprovalRule(storage, GK, described("issueReportNote"))?.enabledBy)
        .toEqual(ENABLER);
    expect(autoApprovalRule(storage, GK, described("issueReportScopedReply"))).toBeUndefined();
  });

  it("gives a push its rule, and none while the restricted-data latch is set", () => {
    let storage = makeStorage();
    enableRule(storage);
    let push = eligibleDescription({ pushedCommits: ["0123456789abcdef0123456789abcdef01234567"] });
    // Without the latch the rule is the push's, so it is the latch that withholds it below.
    expect(autoApprovalRule(storage, GK, push)?.enabledBy).toEqual(ENABLER);
    // A push queued from a restricted workspace waits for the person who reads its commits,
    // whatever the gatekeeper declares and whatever rules the workspace holds.
    storage.containsRestrictedData.put(true);
    expect(autoApprovalRule(storage, GK, push)).toBeUndefined();
  });
});
