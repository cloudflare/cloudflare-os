import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { ActionSyncDriver, ActionSyncStorage, GatekeeperActionTarget } from "../src/action-sync.js";
import type { ActionRecord, AutoApproveTagRecord } from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ApplyActionsThroughResult } from "@gadgets/workshop-shared/gatekeeper";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): ActionSyncStorage {
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
const APPROVER: AiChatAuthorInfo = { type: "user", id: "approver@example.com", name: "Approver" };
const REJECTER: AiChatAuthorInfo = { type: "user", id: "rejecter@example.com", name: "Rejecter" };

function enableRule(storage: ActionSyncStorage, actionTag = "edit", gatekeeperId = GK) {
  storage.autoApproveTags.put({
    gatekeeperId, actionKind: { tag: actionTag, label: "Edits" }, enabledBy: ENABLER });
}

// Workspace record ids are deliberately offset from gatekeeper-local action ids (`id = action*10`)
// so a test that confuses the two ID spaces fails loudly.
function putAction(
    storage: ActionSyncStorage, action: number,
    opts: { gatekeeperId?: number; actionTag?: string; autoApprovable?: boolean;
            state?: ActionRecord["state"]; chatId?: number; awaitDecision?: boolean;
            vetoPending?: true; resolvedBy?: AiChatAuthorInfo; failure?: string } = {}): number {
  let id = action * 10;
  storage.actions.put({
    id,
    gatekeeperId: opts.gatekeeperId ?? GK,
    caller: { from: "agent", chatId: opts.chatId ?? 1 },
    createdAt: new Date(),
    state: opts.state ?? "pending",
    type: "action",
    action,
    ...(opts.vetoPending ? { vetoPending: true } : {}),
    ...(opts.resolvedBy ? { resolvedBy: opts.resolvedBy } : {}),
    ...(opts.failure !== undefined ? { failure: opts.failure } : {}),
    description: {
      title: `Action ${action}`,
      description: `Action ${action} description`,
      implementsRevert: true,
      actionKind: { tag: opts.actionTag ?? "edit", label: "Edits" },
      autoApprovable: opts.autoApprovable ?? true,
      ...(opts.awaitDecision ? { awaitDecision: true } : {}),
    },
  });
  return id;
}

function getAction(storage: ActionSyncStorage, action: number): ActionRecord & {type: "action"} {
  let record = storage.actions.get(action * 10);
  if (!record || record.type !== "action") throw new Error(`No action ${action}`);
  return record;
}

// A migrated gatekeeper stub: records every batch call and answers from a scripted queue (or {}).
function makeBatchGatekeeper() {
  let calls: Array<{actionId: number, vetoes: number[]}> = [];
  let results: Array<ApplyActionsThroughResult | Error> = [];
  let target = {
    async applyActionsThrough(actionId: number, vetoes: number[]) {
      calls.push({ actionId, vetoes });
      let next = results.shift() ?? {};
      if (next instanceof Error) throw next;
      return next;
    },
    async applyAction() { throw new Error("legacy applyAction must not be called"); },
    async rejectAction() { throw new Error("legacy rejectAction must not be called"); },
  } as unknown as GatekeeperActionTarget;
  return { target, calls, results };
}

// A pre-migration gatekeeper stub: applyActionsThrough is missing (locally undefined, or throwing
// workerd's method-missing TypeError when `remote` mimics a live stub), so the driver must fall
// back to per-action legacy calls.
function makeLegacyGatekeeper(opts: {remote?: boolean, failApply?: number[]} = {}) {
  let probes = 0;
  let calls: string[] = [];
  let target = {
    ...(opts.remote ? {
      async applyActionsThrough() {
        probes++;
        throw new TypeError(
            'The RPC receiver does not implement the method "applyActionsThrough".');
      },
    } : {}),
    async applyAction(action: number) {
      calls.push(`apply:${action}`);
      if (opts.failApply?.includes(action)) throw new Error(`apply ${action} failed`);
    },
    async rejectAction(action: number) {
      calls.push(`reject:${action}`);
      return { restart: true };  // must be discarded
    },
  } as unknown as GatekeeperActionTarget;
  return { target, calls, probeCount: () => probes };
}

function makeDriver(storage: ActionSyncStorage, target: GatekeeperActionTarget) {
  return new ActionSyncDriver(storage, () => target);
}

// Drain the microtask queue (and one macrotask) so parked continuations reach their next await.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ActionSyncDriver.sync", () => {
  it("applies through a manual frontier, attributing covered actions to the approver and " +
     "auto-extended ones to the rule enabler", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1, { autoApprovable: false });
    let a2 = putAction(storage, 2, { autoApprovable: false });
    let a3 = putAction(storage, 3);  // auto-eligible beyond the manual frontier

    let { target, calls } = makeBatchGatekeeper();
    let decided = await makeDriver(storage, target)
        .sync(GK, { frontier: 2, resolvedBy: APPROVER });

    expect(calls).toEqual([{ actionId: 3, vetoes: [] }]);
    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a2, a3]);
    for (let action of [1, 2]) {
      let record = getAction(storage, action);
      expect(record.state).toBe("approved");
      expect(record.autoApproved).toBe(false);
      expect(record.resolvedBy?.id).toBe(APPROVER.id);
    }
    let auto = getAction(storage, 3);
    expect(auto.state).toBe("approved");
    expect(auto.autoApproved).toBe(true);
    expect(auto.resolvedBy?.id).toBe(ENABLER.id);
  });

  it("never auto-approves past a manual gate", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { autoApprovable: false });  // manual gate
    putAction(storage, 3);

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).sync(GK);

    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("makes no call when nothing is eligible", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    let decided = await makeDriver(storage, target).sync(GK);

    expect(decided).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("records a display-safe failure on the stopped action and clears it on a later success",
     async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });

    let { target, calls, results } = makeBatchGatekeeper();
    results.push({ stopped: { at: 2, reason: new Error("page was deleted upstream") } });
    let driver = makeDriver(storage, target);

    let first = await driver.sync(GK, { frontier: 2, resolvedBy: APPROVER });

    expect(first).toEqual([a1]);
    expect(getAction(storage, 1).state).toBe("approved");
    let stopped = getAction(storage, 2);
    expect(stopped.state).toBe("pending");
    expect(stopped.failure).toBe("page was deleted upstream");

    // Retry after the user resolves the problem: only the stopped action remains pending, and its
    // failure is cleared. The already-applied action is never re-sent (idempotent contract), and
    // the gatekeeper sees a second call at the same frontier.
    let retry = await driver.sync(GK, { frontier: 2, resolvedBy: APPROVER });

    expect(retry).toEqual([getAction(storage, 2).id]);
    expect(calls).toEqual([{ actionId: 2, vetoes: [] }, { actionId: 2, vetoes: [] }]);
    let retried = getAction(storage, 2);
    expect(retried.state).toBe("approved");
    expect(retried.failure).toBeUndefined();
  });

  it("keeps a veto staged while an earlier action is undecided", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).sync(GK);

    expect(calls).toEqual([]);
    expect(getAction(storage, 2).vetoPending).toBe(true);
  });

  it("delivers a staged veto at the current frontier once everything below is decided, even " +
     "from a fresh driver", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    // A fresh driver over the same storage (e.g. after DO hibernation) must still see the staged
    // veto -- it is durable state, not driver memory.
    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).sync(GK);

    expect(calls).toEqual([{ actionId: 2, vetoes: [2] }]);
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
  });

  it("rides staged vetoes along with a covering approval", async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let a3 = putAction(storage, 3, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    let decided = await makeDriver(storage, target)
        .sync(GK, { frontier: 3, resolvedBy: APPROVER });

    expect(calls).toEqual([{ actionId: 3, vetoes: [2] }]);
    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a3]);
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
  });

  it("marks cascade-invalidated actions rejected with the vetoing record's attribution",
     async () => {
    let storage = makeStorage();
    putAction(storage, 1, { state: "approved" });
    let vetoId = putAction(storage, 2,
        { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let a3 = putAction(storage, 3, { autoApprovable: false });

    let { target, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [{ action: 3, invalidatedBy: 2 }] });
    let decided = await makeDriver(storage, target).sync(GK);

    expect(decided).toEqual([a3]);
    let invalidated = getAction(storage, 3);
    expect(invalidated.state).toBe("rejected");
    expect(invalidated.cascadedFrom).toBe(vetoId);
    expect(invalidated.resolvedBy?.id).toBe(REJECTER.id);
  });

  it("marks an action rejected, not approved, when the frontier covers it but the same pass's " +
     "veto cascade-invalidates it", async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { autoApprovable: false });
    let vetoId = putAction(storage, 2,
        { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let a3 = putAction(storage, 3, { autoApprovable: false });  // depends on the vetoed action 2

    // Approving 3 rides veto 2 along; the gatekeeper applies 1, deletes 3 as a cascade of 2.
    let { target, calls, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [{ action: 3, invalidatedBy: 2 }] });
    let decided = await makeDriver(storage, target)
        .sync(GK, { frontier: 3, resolvedBy: APPROVER });

    expect(calls).toEqual([{ actionId: 3, vetoes: [2] }]);
    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a3]);
    expect(getAction(storage, 1).state).toBe("approved");
    let invalidated = getAction(storage, 3);
    expect(invalidated.state).toBe("rejected");
    expect(invalidated.cascadedFrom).toBe(vetoId);
    expect(invalidated.resolvedBy?.id).toBe(REJECTER.id);
  });

  it("ignores invalidations for unknown or already-decided actions", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [
      { action: 1, invalidatedBy: 2 },   // already applied
      { action: 99, invalidatedBy: 2 },  // unknown
    ]});
    let decided = await makeDriver(storage, target).sync(GK);

    expect(decided).toEqual([]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  it("coalesces concurrent approvals into one follow-up pass at the highest frontier", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });

    let calls: Array<{actionId: number, vetoes: number[]}> = [];
    let gates: Array<() => void> = [];
    let target = {
      applyActionsThrough(actionId: number, vetoes: number[]) {
        calls.push({ actionId, vetoes });
        return new Promise<ApplyActionsThroughResult>(resolve => {
          gates.push(() => resolve({}));
        });
      },
    } as unknown as GatekeeperActionTarget;
    let driver = makeDriver(storage, target);

    let first = driver.sync(GK, { frontier: 1, resolvedBy: APPROVER });   // parks mid-RPC
    await flush();
    let second = driver.sync(GK, { frontier: 3, resolvedBy: APPROVER });  // staged
    let third = driver.sync(GK, { frontier: 2, resolvedBy: APPROVER });   // merged with second
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);

    gates.shift()!();  // finish pass 1
    await flush();
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }, { actionId: 3, vetoes: [] }]);

    gates.shift()!();  // finish pass 2
    let [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toEqual([10]);
    // The coalesced requests share the pass and its decided set.
    expect(b.toSorted((x, y) => x - y)).toEqual([20, 30]);
    expect(c).toBe(b);
    for (let action of [1, 2, 3]) expect(getAction(storage, action).state).toBe("approved");
  });

  it("settled() resolves only after the in-flight pass (and its reruns) complete", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let gates: Array<() => void> = [];
    let target = {
      applyActionsThrough() {
        return new Promise<ApplyActionsThroughResult>(resolve => {
          gates.push(() => resolve({}));
        });
      },
    } as unknown as GatekeeperActionTarget;
    let driver = makeDriver(storage, target);

    let pass = driver.sync(GK, { frontier: 1, resolvedBy: APPROVER });
    await flush();
    let settledDone = false;
    let settled = driver.settled(GK).then(() => { settledDone = true; });
    await flush();
    expect(settledDone).toBe(false);

    gates.shift()!();
    await Promise.all([pass, settled]);
    expect(settledDone).toBe(true);
  });

  it("propagates a transport failure to the awaiting caller and recovers on the next sync",
     async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let { target, results } = makeBatchGatekeeper();
    results.push(new Error("network unreachable"));
    let driver = makeDriver(storage, target);

    await expect(driver.sync(GK, { frontier: 1, resolvedBy: APPROVER }))
        .rejects.toThrow("network unreachable");
    expect(getAction(storage, 1).state).toBe("pending");

    await driver.sync(GK, { frontier: 1, resolvedBy: APPROVER });
    expect(getAction(storage, 1).state).toBe("approved");
  });

  it("returns decided awaited records across chats so every affected turn can resume", async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { autoApprovable: false, chatId: 7, awaitDecision: true });
    let a2 = putAction(storage, 2, { autoApprovable: false, chatId: 8, awaitDecision: true });

    let { target } = makeBatchGatekeeper();
    let decided = await makeDriver(storage, target)
        .sync(GK, { frontier: 2, resolvedBy: APPROVER });

    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a2]);
  });
});

describe("ActionSyncDriver legacy fallback", () => {
  it("falls back on workerd's method-missing TypeError, delivering vetoes then applies in " +
     "ascending order, and probes only once", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    putAction(storage, 3, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper({ remote: true });
    let driver = makeDriver(storage, legacy.target);

    await driver.sync(GK, { frontier: 3, resolvedBy: APPROVER });

    // Vetoes first (the {restart} return is discarded), then pending actions ascending.
    expect(legacy.calls).toEqual(["reject:2", "apply:1", "apply:3"]);
    expect(legacy.probeCount()).toBe(1);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
    expect(getAction(storage, 3).state).toBe("approved");

    // The legacy verdict is cached: a later pass goes straight to per-action calls.
    putAction(storage, 4, { autoApprovable: false });
    await driver.sync(GK, { frontier: 4, resolvedBy: APPROVER });
    expect(legacy.probeCount()).toBe(1);
    expect(legacy.calls).toEqual(["reject:2", "apply:1", "apply:3", "apply:4"]);
  });

  it("handles a target with no applyActionsThrough at all", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper();
    await makeDriver(storage, legacy.target).sync(GK, { frontier: 1, resolvedBy: APPROVER });

    expect(legacy.calls).toEqual(["apply:1"]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  it("synthesizes {stopped} from the first legacy apply failure", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper({ failApply: [2] });
    await makeDriver(storage, legacy.target).sync(GK, { frontier: 3, resolvedBy: APPROVER });

    expect(legacy.calls).toEqual(["apply:1", "apply:2"]);  // never skips ahead of the failure
    expect(getAction(storage, 1).state).toBe("approved");
    let stopped = getAction(storage, 2);
    expect(stopped.state).toBe("pending");
    expect(stopped.failure).toBe("apply 2 failed");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("keeps delivering vetoes even when a legacy reject throws", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let legacy = makeLegacyGatekeeper();
    legacy.target.rejectAction =
        (async () => { throw new Error("already settled"); }) as typeof legacy.target.rejectAction;
    await makeDriver(storage, legacy.target).sync(GK);

    // The reject was attempted once and is not re-staged: legacy gatekeepers throw forever on
    // settled actions, so retrying would wedge the queue.
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
  });
});
