import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { AutoApprovalDrainer, AutoApprovalStorage, ApplyPendingActionFn } from "../src/auto-approval.js";
import {
  jarvisDeploymentAutoApprover,
  type ActionRecord,
  type AutoApproveTagRecord,
} from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { endpointTag } from "@gadgets/mcp-shared/scope";
import { actionKindFor } from "@gadgets/mcp-shared/tools";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage() {
  return createTypedStorage(makeMockStorage(), {
    singletons: { prohibitAllSharing: false },
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
const DEPLOYMENT: AiChatAuthorInfo = {
  type: "agent", id: "deployment:test-auto-approval", name: "Deployment policy",
};

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
  it("withdraws both rule and deployment eligibility when the workspace becomes sensitive", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, {actionTag: "deployment-only"});
    let {applyFn, calls} = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn, () => DEPLOYMENT);
    expect(drainer.approverFor(getAction(storage, 1))).toEqual(ENABLER);
    expect(drainer.approverFor(getAction(storage, 2))).toEqual(DEPLOYMENT);
    storage.prohibitAllSharing.put(true);
    expect(drainer.approverFor(getAction(storage, 1))).toBeUndefined();
    expect(drainer.approverFor(getAction(storage, 2))).toBeUndefined();
    await drainer.drain(GK);
    expect(calls).toEqual([]);
  });

  it("stops an active drain when sensitivity latches during an earlier apply", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);
    let draining = drainer.drain(GK);
    storage.prohibitAllSharing.put(true);
    apply.releaseNext();
    await draining;
    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
  });

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

  it("applies an action authorized by deployment policy without a user rule", async () => {
    let storage = makeStorage();
    putAction(storage, 1);

    let { applyFn, calls } = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn, () => DEPLOYMENT);
    await drainer.drain(GK);

    expect(calls).toEqual([1]);
    expect(getAction(storage, 1)).toMatchObject({
      state: "approved",
      autoApproved: true,
      resolvedBy: DEPLOYMENT,
    });
  });

  it("does not let deployment policy override an action's manual-only verdict", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let { applyFn, calls } = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn, () => DEPLOYMENT);
    await drainer.drain(GK);

    expect(calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
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
    let secondResolved = false;
    void second.then(() => { secondResolved = true; });
    await flush();

    expect(apply.calls).toEqual([1]);
    expect(apply.inFlight()).toBe(1);
    expect(secondResolved).toBe(false);

    apply.releaseNext();             // resolve apply(1); record becomes approved
    await Promise.all([first, second]); // both callers join the rerun pass

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
    let secondResolved = false;
    void second.then(() => { secondResolved = true; });
    await flush();
    expect(apply.calls).toEqual([1]);
    expect(secondResolved).toBe(false);

    apply.releaseNext();             // finish action 1; rerun pass should pick up action 2
    await flush();

    expect(apply.calls).toEqual([1, 2]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // finish action 2
    await Promise.all([first, second]);

    expect(apply.calls).toEqual([1, 2]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("approved");
  });
});

describe("jarvisDeploymentAutoApprover", () => {
  const resourceUrl = "https://jarvis.example.com/mcp#tool=jarvis_call_wren_tool";
  const actionTag = actionKindFor(
      `jarvis:${endpointTag(resourceUrl)}`, "jarvis_call_wren_tool").tag;

  function jarvisAction(tag = actionTag, label = "jarvis_call_wren_tool") {
    return {
      id: 1,
      gatekeeperId: GK,
      caller: {from: "agent" as const, chatId: 1},
      createdAt: new Date(),
      state: "pending" as const,
      type: "action" as const,
      action: 1,
      description: {
        title: "Run Wren tool",
        description: "Run an approved JARVIS dispatcher.",
        autoApprovable: true,
        actionKind: {tag, label},
      },
    };
  }

  const ambientJarvis = {
    resourceUrl,
    creationSpec: {
      type: "ambient" as const,
      vendorId: "jarvis",
      accountId: "account",
      authorityKey: "authority",
    },
  };

  it("approves an exact ambient JARVIS dispatcher tag", () => {
    expect(jarvisDeploymentAutoApprover(jarvisAction(), ambientJarvis)?.id)
      .toBe("deployment:jarvis-auto-approval");
  });

  it("rejects a dispatcher display label paired with a different policy tag", () => {
    expect(jarvisDeploymentAutoApprover(
        jarvisAction("untrusted:tool", "jarvis_call_wren_tool"), ambientJarvis))
      .toBeUndefined();
  });

  it("rejects non-ambient and non-JARVIS bindings", () => {
    expect(jarvisDeploymentAutoApprover(jarvisAction(), {
      resourceUrl,
      creationSpec: {
        type: "gatekeeper",
        vendorId: "jarvis",
        resourceUrl,
        typeUrlPattern: resourceUrl,
      },
    })).toBeUndefined();
    expect(jarvisDeploymentAutoApprover(jarvisAction(), {
      ...ambientJarvis,
      creationSpec: {...ambientJarvis.creationSpec, vendorId: "mcp"},
    })).toBeUndefined();
  });
});
