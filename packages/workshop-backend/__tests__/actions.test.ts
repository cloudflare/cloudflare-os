import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import {
  ActionSyncDriver, ActionSyncStorage, GatekeeperActionTarget, isMethodMissing,
} from "../src/actions.js";
import type {
  ActionRecord, GatekeeperActionRecord, OverseerDurableObject,
} from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ApplyActionsThroughResult } from "@gadgets/workshop-shared/gatekeeper";
import { makeActionStorage as makeStorage, openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
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
            suspendedTurn?: true; vetoPending?: true; resolvedBy?: AiChatAuthorInfo;
            failure?: string } = {}): number {
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
    ...(opts.suspendedTurn ? { suspendedTurn: true } : {}),
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

function getAction(storage: ActionSyncStorage, action: number): GatekeeperActionRecord {
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

describe("ActionSyncDriver.apply", () => {
  it("applies the clicked action, riding rule-authorized actions along on either side", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1);                             // rule-authorized, below the click
    let a2 = putAction(storage, 2, { autoApprovable: false });  // clicked
    let a3 = putAction(storage, 3);                             // rule-authorized, above the click

    let { target, calls } = makeBatchGatekeeper();
    let { decided } = await makeDriver(storage, target)
        .apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(calls).toEqual([{ actionId: 3, vetoes: [] }]);
    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a2, a3]);
    for (let action of [1, 3]) {
      let ridden = getAction(storage, action);
      expect(ridden.state).toBe("approved");
      expect(ridden.autoApproved).toBe(true);
      expect(ridden.resolvedBy?.id).toBe(ENABLER.id);
    }
    let clicked = getAction(storage, 2);
    expect(clicked.state).toBe("approved");
    expect(clicked.autoApproved).toBe(false);
    expect(clicked.resolvedBy?.id).toBe(APPROVER.id);
  });

  it("refuses a click above an undecided gate, telling it which action to approve first",
     async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });  // neither clicked nor rule-authorized
    putAction(storage, 2, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    let driver = makeDriver(storage, target);

    expect(await driver.apply(GK, { action: 2, resolvedBy: APPROVER }))
        .toEqual({ decided: [], blockedBy: "Action 1" });
    expect(calls).toEqual([]);
    // The refusal is transient queue state, reported to the clicker rather than recorded, so it
    // can't go stale on the record or later be mistaken for a gatekeeper failure.
    expect(getAction(storage, 1).failure).toBeUndefined();
    expect(getAction(storage, 2).failure).toBeUndefined();

    // Approving the gate, then clicking again, applies both.
    await driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await driver.apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(calls).toEqual([{ actionId: 1, vetoes: [] }, { actionId: 2, vetoes: [] }]);
    expect(getAction(storage, 2).state).toBe("approved");
  });

  it("treats action ID 0 as a real frontier", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 0);

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    expect(calls).toEqual([{ actionId: 0, vetoes: [] }]);
    expect(getAction(storage, 0).state).toBe("approved");
  });

  it("keeps a veto staged while action 0 is undecided", async () => {
    let storage = makeStorage();
    putAction(storage, 0, { autoApprovable: false });
    putAction(storage, 1, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    expect(calls).toEqual([]);
    expect(getAction(storage, 1).vetoPending).toBe(true);
  });

  it("never auto-approves past a manual gate", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { autoApprovable: false });  // manual gate
    putAction(storage, 3);

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("does not scan resolved or unrelated action history", async () => {
    let storage = makeStorage();
    enableRule(storage);
    for (let action = 1; action <= 500; action++) {
      putAction(storage, action, { state: "approved", gatekeeperId: GK + 1 });
    }
    putAction(storage, 501);
    putAction(storage, 502, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let fullScan = vi.spyOn(storage.actions, "list");

    let { target } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    expect(fullScan).not.toHaveBeenCalled();
    expect(getAction(storage, 501).state).toBe("approved");
    expect(getAction(storage, 502).vetoPending).toBeUndefined();
  });

  it("makes no call when nothing is eligible", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    let { decided } = await makeDriver(storage, target).apply(GK);

    expect(decided).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("records a display-safe failure on the stopped action and clears it on a later success",
     async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1);  // rides along under the rule
    putAction(storage, 2, { autoApprovable: false });

    let { target, calls, results } = makeBatchGatekeeper();
    results.push({ stopped: { at: 2, reason: new Error("page was deleted upstream") } });
    let driver = makeDriver(storage, target);

    let first = await driver.apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(first.decided).toEqual([a1]);
    expect(getAction(storage, 1).state).toBe("approved");
    let stopped = getAction(storage, 2);
    expect(stopped.state).toBe("pending");
    expect(stopped.failure).toBe("page was deleted upstream");

    // Retry after the user resolves the problem: only the stopped action remains pending, and its
    // failure is cleared. The already-applied action is never re-sent (idempotent contract), and
    // the gatekeeper sees a second call at the same frontier.
    let retry = await driver.apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(retry.decided).toEqual([getAction(storage, 2).id]);
    expect(calls).toEqual([{ actionId: 2, vetoes: [] }, { actionId: 2, vetoes: [] }]);
    let retried = getAction(storage, 2);
    expect(retried.state).toBe("approved");
    expect(retried.failure).toBeUndefined();
  });

  it("clamps the gatekeeper's failure text before persisting it", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let { target, results } = makeBatchGatekeeper();
    results.push({ stopped: { at: 1, reason: new Error("x".repeat(5000)) } });
    await makeDriver(storage, target).apply(GK);

    expect(getAction(storage, 1).failure).toBe("x".repeat(500));
  });

  it("never re-applies a failed action on a rule alone", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1, { failure: "the upstream page was deleted" });
    putAction(storage, 2);

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    // The gatekeeper said why it stopped, not whether the action landed, so re-sending it
    // unattended could repeat a side effect. It becomes a gate until a human retries it.
    expect(calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("still rides a rule-authorized action along once the gate that refused a click is resolved",
     async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 5, { autoApprovable: false });  // the gate
    putAction(storage, 7);                             // rule-authorized, above the gate

    let { target, calls } = makeBatchGatekeeper();
    let driver = makeDriver(storage, target);

    // Clicking 7 first is refused, and must leave no trace that would later be read as a
    // gatekeeper failure -- otherwise 7 would never auto-apply again.
    expect(await driver.apply(GK, { action: 7, resolvedBy: APPROVER }))
        .toEqual({ decided: [], blockedBy: "Action 5" });

    await driver.apply(GK, { action: 5, resolvedBy: APPROVER });

    expect(calls).toEqual([{ actionId: 7, vetoes: [] }]);
    expect(getAction(storage, 5).state).toBe("approved");
    expect(getAction(storage, 7).state).toBe("approved");
    expect(getAction(storage, 7).autoApproved).toBe(true);
  });

  it("keeps a veto staged while an earlier action is undecided", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

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
    await makeDriver(storage, target).apply(GK);

    expect(calls).toEqual([{ actionId: 2, vetoes: [2] }]);
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
  });

  it("rides staged vetoes along with an approval", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1);
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let a3 = putAction(storage, 3, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    let { decided } = await makeDriver(storage, target)
        .apply(GK, { action: 3, resolvedBy: APPROVER });

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
    let { decided } = await makeDriver(storage, target).apply(GK);

    expect(decided).toEqual([a3]);
    let invalidated = getAction(storage, 3);
    expect(invalidated.state).toBe("rejected");
    expect(invalidated.cascadedFrom).toBe(vetoId);
    expect(invalidated.resolvedBy?.id).toBe(REJECTER.id);
  });

  it("marks an action rejected, not approved, when the frontier covers it but the same pass's " +
     "veto cascade-invalidates it", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1);
    let vetoId = putAction(storage, 2,
        { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let a3 = putAction(storage, 3, { autoApprovable: false });  // depends on the vetoed action 2

    // Approving 3 rides veto 2 along; the gatekeeper applies 1, deletes 3 as a cascade of 2.
    let { target, calls, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [{ action: 3, invalidatedBy: 2 }] });
    let { decided } = await makeDriver(storage, target)
        .apply(GK, { action: 3, resolvedBy: APPROVER });

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
    let { decided } = await makeDriver(storage, target).apply(GK);

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

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });   // parks mid-RPC
    await flush();
    let second = driver.apply(GK, { action: 3, resolvedBy: APPROVER });  // staged
    let third = driver.apply(GK, { action: 2, resolvedBy: APPROVER });   // merged with second
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);

    gates.shift()!();  // finish pass 1
    await flush();
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }, { actionId: 3, vetoes: [] }]);

    gates.shift()!();  // finish pass 2
    let [a, b, c] = await Promise.all([first, second, third]);
    expect(a.decided).toEqual([10]);
    // The coalesced requests share the pass and its decided set.
    expect(b.decided.toSorted((x, y) => x - y)).toEqual([20, 30]);
    expect(c).toBe(b);
    for (let action of [1, 2, 3]) expect(getAction(storage, action).state).toBe("approved");
  });

  it("runs a transition only after the in-flight pass has reconciled", async () => {
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

    let pass = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await flush();
    let seen: ActionRecord["state"] | undefined;
    let settled = driver.withSettled(GK, () => { seen = getAction(storage, 1).state; });
    await flush();
    expect(seen).toBeUndefined();

    gates.shift()!();
    await Promise.all([pass, settled]);
    expect(seen).toBe("approved");
  });

  it("runs a transition between passes while requests keep arriving", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });

    let gates: Array<() => void> = [];
    let target = {
      applyActionsThrough() {
        return new Promise<ApplyActionsThroughResult>(resolve => gates.push(() => resolve({})));
      },
    } as unknown as GatekeeperActionTarget;
    let driver = makeDriver(storage, target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await flush();
    let ran = false;
    let settled = driver.withSettled(GK, () => { ran = true; });

    // A request landing mid-pass keeps the run loop alive. The transition must still get its turn
    // between the two passes rather than starving until the loop finally goes idle.
    let second = driver.apply(GK, { action: 2, resolvedBy: APPROVER });
    await flush();
    expect(ran).toBe(false);

    gates.shift()!();
    await settled;
    await flush();
    expect(ran).toBe(true);
    expect(gates).toHaveLength(1);  // the second pass started anyway

    gates.shift()!();
    await Promise.all([first, second]);
  });

  it("propagates a transport failure to the awaiting caller and recovers on the next sync",
     async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let { target, results } = makeBatchGatekeeper();
    results.push(new Error("network unreachable"));
    let driver = makeDriver(storage, target);

    await expect(driver.apply(GK, { action: 1, resolvedBy: APPROVER }))
        .rejects.toThrow("network unreachable");
    expect(getAction(storage, 1).state).toBe("pending");

    await driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    expect(getAction(storage, 1).state).toBe("approved");
  });

  it("returns decided awaited records across chats so every affected turn can resume", async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1, { chatId: 7, awaitDecision: true });
    let a2 = putAction(storage, 2,
        { autoApprovable: false, chatId: 8, awaitDecision: true });

    let { target } = makeBatchGatekeeper();
    let { decided } = await makeDriver(storage, target)
        .apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a2]);
  });

  it("rejects a cascade-invalidated action that was submitted during the pass", async () => {
    let storage = makeStorage();
    let vetoId = putAction(storage, 2,
        { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [{ action: 3, invalidatedBy: 2 }] });
    let pass = makeDriver(storage, target).apply(GK);
    let a3 = putAction(storage, 3, { autoApprovable: false });  // arrives while the RPC is in
    let { decided } = await pass;                               // flight, so it misses the snapshot

    expect(decided).toContain(a3);
    let invalidated = getAction(storage, 3);
    expect(invalidated.state).toBe("rejected");
    expect(invalidated.cascadedFrom).toBe(vetoId);
  });
});

describe("ActionSyncDriver legacy fallback", () => {
  it("recognizes workerd's real missing-method error", async () => {
    let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
    let call = (stub as any).applyActionsThrough(1, []);
    let error: unknown;
    try {
      await call;
    } catch (caught) {
      error = caught;
    } finally {
      call[Symbol.dispose]();
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('does not implement "applyActionsThrough"');
    expect(isMethodMissing(error)).toBe(true);
  });
  it("falls back on workerd's method-missing TypeError, delivering vetoes then applies in " +
     "ascending order, and probes only once", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    putAction(storage, 3, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper({ remote: true });
    let driver = makeDriver(storage, legacy.target);

    await driver.apply(GK, { action: 3, resolvedBy: APPROVER });

    // Vetoes first (the {restart} return is discarded), then pending actions ascending.
    expect(legacy.calls).toEqual(["reject:2", "apply:1", "apply:3"]);
    expect(legacy.probeCount()).toBe(1);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
    expect(getAction(storage, 3).state).toBe("approved");

    // The legacy verdict is cached: a later pass goes straight to per-action calls.
    putAction(storage, 4, { autoApprovable: false });
    await driver.apply(GK, { action: 4, resolvedBy: APPROVER });
    expect(legacy.probeCount()).toBe(1);
    expect(legacy.calls).toEqual(["reject:2", "apply:1", "apply:3", "apply:4"]);
  });

  it("handles a target with no applyActionsThrough at all", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper();
    await makeDriver(storage, legacy.target).apply(GK, { action: 1, resolvedBy: APPROVER });

    expect(legacy.calls).toEqual(["apply:1"]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  it("synthesizes {stopped} from the first legacy apply failure", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper({ failApply: [2] });
    await makeDriver(storage, legacy.target).apply(GK, { action: 3, resolvedBy: APPROVER });

    expect(legacy.calls).toEqual(["apply:1", "apply:2"]);  // never skips ahead of the failure
    expect(getAction(storage, 1).state).toBe("approved");
    let stopped = getAction(storage, 2);
    expect(stopped.state).toBe("pending");
    expect(stopped.failure).toBe("apply 2 failed");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("keeps a veto staged when a legacy reject throws, and still applies the rest", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    putAction(storage, 2);

    let legacy = makeLegacyGatekeeper();
    legacy.target.rejectAction = (async (action: number) => {
      legacy.calls.push(`reject:${action}`);
      throw new Error("already settled");
    }) as typeof legacy.target.rejectAction;
    await makeDriver(storage, legacy.target).apply(GK);

    // The error can't say whether the gatekeeper ever saw the rejection, so it is re-sent on the
    // next pass rather than dropped: a lost veto would let a later frontier apply the action the
    // user rejected. Re-sending a settled veto is harmless.
    expect(getAction(storage, 1).vetoPending).toBe(true);
    expect(legacy.calls).toEqual(["reject:1", "apply:2"]);
    expect(getAction(storage, 2).state).toBe("approved");
  });

  it("records each legacy approval before issuing the next external call", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { autoApprovable: false });

    // What action 1's record looks like at the moment each apply is issued: a crash (or an
    // outcome-unknown failure) after the first one must not lose it, since a replayed legacy
    // applyAction throws on an already-applied action.
    let seen: string[] = [];
    let target = {
      async applyAction() { seen.push(getAction(storage, 1).state); },
    } as unknown as GatekeeperActionTarget;
    await makeDriver(storage, target).apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(seen).toEqual(["pending", "approved"]);
    expect(getAction(storage, 2).state).toBe("approved");
  });
});

describe("Overseer action decisions", () => {
  it("resumes only the chats that suspended, and one failed resume doesn't strand the rest",
     async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { chatId: 7, awaitDecision: true, suspendedTurn: true });
    let a2 = putAction(storage, 2, { chatId: 8, awaitDecision: true, suspendedTurn: true });
    let a3 = putAction(storage, 3, { chatId: 9, awaitDecision: true });

    // Chat 7's resume throws (its scan reaches chat storage over RPC in production); chat 8's
    // finds no awaited action. Chat 9 never suspended, so it must not be visited at all.
    let resumeScans = 0;
    let client = await openFakeOverseer({
      ...storage,
      chats: {
        list: () => {
          if (++resumeScans === 1) throw new Error("chat storage unavailable");
          return [];
        },
      },
    }, {
      impl: {
        applyDecidedActions: async () => {
          for (let action of [1, 2, 3]) {
            let record = getAction(storage, action);
            record.state = "approved";
            storage.actions.put(record);
          }
          return { decided: [a1, a2, a3] };
        },
      },
    });

    await client.approveAction(a1);

    expect(resumeScans).toBe(2);
  });

  it("keeps the failure on an action rejected after a failed apply", async () => {
    let storage = makeStorage();
    let id = putAction(storage, 1, { failure: "page was deleted upstream" });
    let client = await openFakeOverseer(storage);

    await client.rejectAction(id);

    let record = getAction(storage, 1);
    expect(record.state).toBe("rejected");
    expect(record.vetoPending).toBe(true);
    expect(record.failure).toBe("page was deleted upstream");

    // And it survives the mapping to the client API, which is where the user meets it.
    let entry = (await client.listActions()).entries.find(candidate => candidate.id === id);
    expect(entry?.type === "action" && entry.failure).toBe("page was deleted upstream");
  });
});
