import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import {
  ActionSyncDriver, ActionSyncStorage, GatekeeperActionTarget, isMethodMissing,
} from "../src/actions.js";
import type {
  ActionRecord, GatekeeperActionRecord, OverseerDurableObject,
} from "../src/overseer.js";
import {
  ACTION_ERROR_CODES, getActionErrorCode, type ActionLogEntry, type AiChatAuthorInfo,
} from "@gadgets/workshop-shared/api";
import type { ApplyActionsThroughResult } from "@gadgets/workshop-shared/gatekeeper";
import type { ManualApproval } from "../src/actions.js";
import { keyString } from "@gadgets/typed-storage";
import {
  createGitPackError,
  getGitPackErrorCode,
  GIT_PACK_ERROR_CODES,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  FIXTURE_EPOCH, makeActionStorage as makeStorage, makeSubscriber, openFakeOverseer,
  putAction as putStoredAction,
} from "./fixtures.js";

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
            suspendedTurn?: boolean; vetoPending?: true; resolvedBy?: AiChatAuthorInfo;
            failure?: string; createdAt?: Date } = {}): number {
  let id = action * 10;
  storage.actions.put({
    id,
    gatekeeperId: opts.gatekeeperId ?? GK,
    caller: { from: "agent", chatId: opts.chatId ?? 1 },
    createdAt: opts.createdAt ?? new Date(),
    state: opts.state ?? "pending",
    type: "action",
    action,
    ...(opts.vetoPending ? { vetoPending: true } : {}),
    ...(opts.suspendedTurn !== undefined ? { suspendedTurn: opts.suspendedTurn } : {}),
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

// A pre-migration live stub rejects the batch method probe, then serves legacy per-action calls.
function makeLegacyGatekeeper(opts: {failApply?: number[]} = {}) {
  let probes = 0;
  let calls: string[] = [];
  let target = {
    async applyActionsThrough() {
      probes++;
      throw new TypeError(
          'The RPC receiver does not implement the method "applyActionsThrough".');
    },
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
  return new ActionSyncDriver(storage, () => target, {
    createGitCache: vi.fn(),
    createGitPackBuilder: vi.fn(),
    applyLegacyAction: async (gatekeeper, record) => {
      let apply = gatekeeper.applyAction as unknown as (action: number) => Promise<void>;
      await apply(record.action);
    },
    persistApproved: record => storage.actions.put(record),
    persistRejected: record => storage.actions.put(record),
  });
}

function makeClient(storage: ActionSyncStorage, target: GatekeeperActionTarget) {
  let driver = makeDriver(storage, target);
  return openFakeOverseer(storage, { impl: {
    applyDecidedActions: (gatekeeperId: number, approval?: ManualApproval) =>
        driver.apply(gatekeeperId, approval),
    rejectPendingAction: (record: GatekeeperActionRecord, author: AiChatAuthorInfo) =>
        driver.reject(record, author),
    applyActionBatch: (
        boundary: GatekeeperActionRecord, vetoes: readonly GatekeeperActionRecord[],
        author: AiChatAuthorInfo) => driver.applyThrough(boundary, vetoes, author),
  } });
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

  it("does not flush persisted vetoes without an authorized frontier", async () => {
    let storage = makeStorage();
    putAction(storage, 0, { autoApprovable: false });
    putAction(storage, 1, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    expect(calls).toEqual([]);
    expect(getAction(storage, 0).state).toBe("pending");
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

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).apply(GK);

    expect(fullScan).not.toHaveBeenCalled();
    expect(calls).toEqual([{ actionId: 501, vetoes: [] }]);
    expect(getAction(storage, 501).state).toBe("approved");
    expect(getAction(storage, 502).vetoPending).toBe(true);
  });

  it("makes no call when nothing is eligible", async () => {
    let storage = makeStorage();
    putAction(storage, 1);                             // auto-approvable, but no rule enables it
    putAction(storage, 2, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    let { decided } = await makeDriver(storage, target).apply(GK);

    expect(decided).toEqual([]);
    expect(calls).toEqual([]);
    for (let action of [1, 2]) expect(getAction(storage, action).state).toBe("pending");
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
    expect(first.stoppedAt).toBe(2);
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


  it("delivers a persisted veto from a fresh driver through a covering boundary", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    // A fresh driver over the same storage (e.g. after DO hibernation) sees durable delivery intent,
    // but transmits it only when an explicit boundary covers it.
    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).applyThrough(getAction(storage, 2), [], REJECTER);

    expect(calls).toEqual([{ actionId: 2, vetoes: [2] }]);
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
  });

  it("authorizes the whole explicit prefix while leaving later vetoes staged", async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });
    let a3 = putAction(storage, 3, { autoApprovable: false });
    putAction(storage, 4, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, calls } = makeBatchGatekeeper();
    let driver = makeDriver(storage, target);
    let { decided } = await driver.applyThrough(
        getAction(storage, 3), [getAction(storage, 2)], APPROVER);

    expect(calls).toEqual([{ actionId: 3, vetoes: [2] }]);
    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a3]);
    for (let action of [1, 3]) {
      expect(getAction(storage, action)).toMatchObject({
        state: "approved", resolvedBy: APPROVER, autoApproved: false,
      });
    }
    expect(getAction(storage, 2).state).toBe("rejected");
    expect(getAction(storage, 4).vetoPending).toBe(true);
  });

  it("uses the ordinary final action as an all-veto boundary", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });

    let { target, calls } = makeBatchGatekeeper();
    await makeDriver(storage, target).applyThrough(
        getAction(storage, 2), [getAction(storage, 1), getAction(storage, 2)], REJECTER);

    expect(calls).toEqual([{ actionId: 2, vetoes: [1, 2] }]);
    expect(getAction(storage, 1).state).toBe("rejected");
    expect(getAction(storage, 2).state).toBe("rejected");
  });

  it("reports stopping action zero", async () => {
    let storage = makeStorage();
    putAction(storage, 0, { autoApprovable: false });
    let { target, results } = makeBatchGatekeeper();
    results.push({ stopped: { at: 0, reason: new Error("zero stopped") } });

    let result = await makeDriver(storage, target)
        .applyThrough(getAction(storage, 0), [], APPROVER);

    expect(result.stoppedAt).toBe(0);
    expect(getAction(storage, 0)).toMatchObject({ state: "pending", failure: "zero stopped" });
  });

  it.each([1, 4])("fails closed when a gatekeeper stops outside the applied plan at %i",
      async invalidAt => {
    let storage = makeStorage();
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });
    let { target, results } = makeBatchGatekeeper();
    results.push({ stopped: { at: invalidAt, reason: new Error("invalid stop") } });

    let result = await makeDriver(storage, target)
        .applyThrough(getAction(storage, 3), [], APPROVER);

    expect(result.stoppedAt).toBe(2);
    expect(getAction(storage, 2)).toMatchObject({
      state: "pending",
      failure: "The gatekeeper could not apply this action.",
    });
    expect(getAction(storage, 3).state).toBe("pending");
    expect(getAction(storage, 3).failure).toBeUndefined();
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
    let { decided } = await makeDriver(storage, target)
        .applyThrough(getAction(storage, 3), [], REJECTER);

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

  it("ignores cascades attributed to a veto that was not sent", async () => {
    let storage = makeStorage();
    let actionId = putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let { target, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [{ action: 1, invalidatedBy: 2 }] });

    let { decided } = await makeDriver(storage, target)
        .applyThrough(getAction(storage, 1), [], APPROVER);

    expect(decided).toEqual([actionId]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).vetoPending).toBe(true);
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
    let { decided } = await makeDriver(storage, target)
        .applyThrough(getAction(storage, 2), [], REJECTER);

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
    expect(c).toEqual(b);
    for (let action of [1, 2, 3]) expect(getAction(storage, action).state).toBe("approved");
  });
  it("runs an explicit batch between the in-flight pass and later staged approvals", async () => {
    let storage = makeStorage();
    for (let action of [1, 2, 3]) putAction(storage, action, { autoApprovable: false });
    let firstCall = Promise.withResolvers<void>();
    let calls: Array<{actionId: number, vetoes: number[]}> = [];
    let target = {
      async applyActionsThrough(actionId: number, vetoes: number[]) {
        calls.push({ actionId, vetoes });
        if (actionId === 1) await firstCall.promise;
        return {};
      },
    } as unknown as GatekeeperActionTarget;
    let driver = makeDriver(storage, target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await flush();
    let batch = driver.applyThrough(getAction(storage, 2), [getAction(storage, 2)], REJECTER);
    let later = driver.apply(GK, { action: 3, resolvedBy: APPROVER });

    firstCall.resolve();
    await Promise.all([first, batch, later]);

    expect(calls).toEqual([
      { actionId: 1, vetoes: [] },
      { actionId: 2, vetoes: [2] },
      { actionId: 3, vetoes: [] },
    ]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("rejected");
    expect(getAction(storage, 3).state).toBe("approved");
  });

  it("revalidates the complete batch after waiting in the decision queue", async () => {
    let storage = makeStorage();
    for (let action of [1, 2, 3]) putAction(storage, action, { autoApprovable: false });
    let firstCall = Promise.withResolvers<void>();
    let calls: Array<{actionId: number, vetoes: number[]}> = [];
    let target = {
      async applyActionsThrough(actionId: number, vetoes: number[]) {
        calls.push({ actionId, vetoes });
        if (actionId === 1) await firstCall.promise;
        return {};
      },
    } as unknown as GatekeeperActionTarget;
    let driver = makeDriver(storage, target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await flush();
    let batch = driver.applyThrough(getAction(storage, 3), [getAction(storage, 2)], REJECTER);
    storage.actions.delete(20);
    firstCall.resolve();

    await first;
    await expect(batch).rejects.toThrow("No such action: 20");
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("ignores a selected veto the queue's earlier pass approved", async () => {
    let storage = makeStorage();
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });
    let firstCall = Promise.withResolvers<void>();
    let calls: Array<{actionId: number, vetoes: number[]}> = [];
    let target = {
      async applyActionsThrough(actionId: number, vetoes: number[]) {
        calls.push({ actionId, vetoes });
        if (actionId === 2) await firstCall.promise;
        return {};
      },
    } as unknown as GatekeeperActionTarget;
    let driver = makeDriver(storage, target);

    let click = driver.apply(GK, { action: 2, resolvedBy: APPROVER });
    await flush();
    let batch = driver.applyThrough(getAction(storage, 3), [getAction(storage, 2)], REJECTER);
    firstCall.resolve();
    await Promise.all([click, batch]);

    expect(calls).toEqual([{ actionId: 2, vetoes: [] }, { actionId: 3, vetoes: [] }]);
    expect(getAction(storage, 2)).toMatchObject({ state: "approved", resolvedBy: APPROVER });
    expect(getAction(storage, 3)).toMatchObject({ state: "approved", resolvedBy: REJECTER });
  });

  it("refuses a rejection after an in-flight approval has applied the same action", async () => {
    let storage = makeStorage();
    putAction(storage, 1);
    let applied = Promise.withResolvers<void>();
    let legacy = makeLegacyGatekeeper();
    legacy.target.applyAction = (async () => applied.promise) as typeof legacy.target.applyAction;
    let driver = makeDriver(storage, legacy.target);

    let pass = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    let rejection = expect(driver.reject(getAction(storage, 1), REJECTER))
        .rejects.toThrow("Action is not pending");
    applied.resolve();
    await Promise.all([pass, rejection]);

    expect(getAction(storage, 1).state).toBe("approved");
    expect(legacy.calls).toEqual([]);
  });

  it("holds later approvals until a rejection between passes is acknowledged", async () => {
    let storage = makeStorage();
    for (let action of [1, 2, 3]) putAction(storage, action);
    let applied = Promise.withResolvers<void>();
    let rejected = Promise.withResolvers<void>();
    let legacy = makeLegacyGatekeeper();
    legacy.target.applyAction = (async (action: number) => {
      legacy.calls.push(`apply:${action}`);
      if (action === 1) await applied.promise;
    }) as typeof legacy.target.applyAction;
    legacy.target.rejectAction = (async (action: number) => {
      legacy.calls.push(`reject:${action}`);
      await rejected.promise;
    }) as typeof legacy.target.rejectAction;
    let driver = makeDriver(storage, legacy.target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    let veto = driver.reject(getAction(storage, 2), REJECTER);
    let second = driver.apply(GK, { action: 3, resolvedBy: APPROVER });
    applied.resolve();
    await flush();
    expect(legacy.calls).toEqual(["apply:1", "reject:2"]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");

    rejected.resolve();
    await Promise.all([first, veto, second]);
    expect(legacy.calls).toEqual(["apply:1", "reject:2", "apply:3"]);
    expect(getAction(storage, 2).state).toBe("rejected");
    expect(getAction(storage, 3).state).toBe("approved");
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

  it("rejects a cascade-invalidated action that was submitted during the pass", async () => {
    let storage = makeStorage();
    let vetoId = putAction(storage, 2,
        { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    let { target, results } = makeBatchGatekeeper();
    results.push({ invalidatedByVeto: [{ action: 3, invalidatedBy: 2 }] });
    let pass = makeDriver(storage, target)
        .applyThrough(getAction(storage, 2), [], REJECTER);
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
  it("does not replay a coded batch failure whose message resembles method-missing prose",
     async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    let { target, results } = makeBatchGatekeeper();
    let failure = createGitPackError(GIT_PACK_ERROR_CODES.builderExpired);
    failure.message = 'The RPC receiver does not implement "applyActionsThrough".';
    results.push(failure);

    let caught: unknown;
    try {
      await makeDriver(storage, target).apply(GK, { action: 1, resolvedBy: APPROVER });
    } catch (error) {
      caught = error;
    }

    expect(getGitPackErrorCode(caught)).toBe(GIT_PACK_ERROR_CODES.builderExpired);
    expect(getAction(storage, 1).state).toBe("pending");
  });

  it("falls back on workerd's method-missing TypeError, delivering vetoes then applies in " +
     "ascending order, and probes only once", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    putAction(storage, 3, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper();
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

  it("synthesizes {stopped} from the first legacy apply failure, then retries only the suffix",
     async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3, { autoApprovable: false });

    let failing = [2];
    let legacy = makeLegacyGatekeeper({ failApply: failing });
    let driver = makeDriver(storage, legacy.target);
    await driver.apply(GK, { action: 3, resolvedBy: APPROVER });

    expect(legacy.calls).toEqual(["apply:1", "apply:2"]);  // never skips ahead of the failure
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2)).toMatchObject({ state: "pending", failure: "apply 2 failed" });
    expect(getAction(storage, 3).state).toBe("pending");

    // The retry re-sends only the undelivered suffix: a replayed legacy applyAction would throw
    // on the action that already landed.
    failing.length = 0;
    await driver.apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(legacy.calls).toEqual(["apply:1", "apply:2", "apply:2"]);
    expect(getAction(storage, 2)).toMatchObject({ state: "approved" });
    expect(getAction(storage, 2).failure).toBeUndefined();
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("checkpoints legacy vetoes and retries only the undelivered suffix", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });

    let legacy = makeLegacyGatekeeper();
    let failSecond = true;
    legacy.target.rejectAction = (async (action: number) => {
      legacy.calls.push(`reject:${action}`);
      if (action === 2 && failSecond) throw new Error("reject 2 failed");
    }) as typeof legacy.target.rejectAction;

    let firstDriver = makeDriver(storage, legacy.target);
    await expect(firstDriver.applyThrough(
        getAction(storage, 3), [getAction(storage, 1), getAction(storage, 2)], REJECTER))
        .rejects.toThrow("reject 2 failed");

    expect(getAction(storage, 1).vetoPending).toBeUndefined();
    expect(getAction(storage, 2).vetoPending).toBe(true);
    expect(legacy.calls).toEqual(["reject:1", "reject:2"]);
    expect(getAction(storage, 3).state).toBe("pending");

    failSecond = false;
    await makeDriver(storage, legacy.target)
        .applyThrough(getAction(storage, 3), [], APPROVER);

    expect(legacy.calls).toEqual(["reject:1", "reject:2", "reject:2", "apply:3"]);
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
    expect(getAction(storage, 3).state).toBe("approved");
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
    let legacy = makeLegacyGatekeeper();
    legacy.target.applyAction = async () => { seen.push(getAction(storage, 1).state); };
    await makeDriver(storage, legacy.target).apply(GK, { action: 2, resolvedBy: APPROVER });

    expect(seen).toEqual(["pending", "approved"]);
    expect(getAction(storage, 2).state).toBe("approved");
  });
});

describe("Overseer action decisions", () => {
  it("maps workspace IDs to one bounded gatekeeper-local batch", async () => {
    let storage = makeStorage();
    let first = putAction(storage, 1, { autoApprovable: false });
    let boundary = putAction(storage, 2, { autoApprovable: false });
    let later = putAction(storage, 3, { autoApprovable: false });
    putAction(storage, 4, { gatekeeperId: GK + 1, autoApprovable: false });
    let batch = makeBatchGatekeeper();
    let client = await makeClient(storage, batch.target);

    await client.applyActionsThrough(boundary, [first]);

    expect(batch.calls).toEqual([{ actionId: 2, vetoes: [1] }]);
    expect(getAction(storage, 1)).toMatchObject({
      state: "rejected", resolvedBy: { id: "profile-id" },
    });
    expect(getAction(storage, 1).vetoPending).toBeUndefined();
    expect(getAction(storage, 2)).toMatchObject({
      state: "approved", resolvedBy: { id: "profile-id" }, autoApproved: false,
    });
    expect(getAction(storage, 3).state).toBe("pending");
    expect(getAction(storage, 4).state).toBe("pending");

    await client.applyActionsThrough(later, [later]);
    expect(batch.calls).toEqual([
      { actionId: 2, vetoes: [1] },
      { actionId: 3, vetoes: [3] },
    ]);
    expect(getAction(storage, 3).state).toBe("rejected");
    expect(getAction(storage, 4).state).toBe("pending");
  });
  it("reports an earlier stop even when the batch boundary is vetoed", async () => {
    let storage = makeStorage();
    let first = putAction(storage, 0, { autoApprovable: false });
    let stopped = putAction(storage, 1, { autoApprovable: false });
    let boundary = putAction(storage, 2, { autoApprovable: false });
    let batch = makeBatchGatekeeper();
    batch.results.push({ stopped: { at: 1, reason: new Error("provider refused action one") } });
    let client = await makeClient(storage, batch.target);

    let error = await client.applyActionsThrough(boundary, [boundary]).catch(caught => caught);

    expect(getActionErrorCode(error)).toBe(ACTION_ERROR_CODES.stopped);
    expect(batch.calls).toEqual([{ actionId: 2, vetoes: [2] }]);
    expect(storage.actions.get(first)).toMatchObject({ state: "approved" });
    expect(storage.actions.get(stopped)).toMatchObject({
      state: "pending", failure: "provider refused action one",
    });
    expect(storage.actions.get(boundary)).toMatchObject({ state: "rejected" });
  });

  it("replays a recorded stop to a client resuming after the action was created", async () => {
    let storage = makeStorage();
    let boundary = putAction(storage, 1,
        { autoApprovable: false, createdAt: new Date(FIXTURE_EPOCH) });
    let batch = makeBatchGatekeeper();
    batch.results.push({ stopped: { at: 1, reason: new Error("page was deleted upstream") } });
    let client = await makeClient(storage, batch.target);

    await expect(client.applyActionsThrough(boundary, [])).rejects.toThrow();

    // Cutoff after creation, before the stop: only the mutation's own stamp carries the record
    // into the resume sweep, so a reconnecting client still learns why it wasn't applied.
    let entries: ActionLogEntry[] = [];
    let { subscriber } = makeSubscriber(async record => { entries.push(record); });
    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 1));

    expect(entries).toMatchObject([{ id: boundary, failure: "page was deleted upstream" }]);
  });

  it("refuses a clicked action the pass cascade-invalidated", async () => {
    let storage = makeStorage();
    let vetoId = putAction(storage, 1,
        { state: "rejected", vetoPending: true, resolvedBy: REJECTER });
    let clicked = putAction(storage, 2, { autoApprovable: false });
    let batch = makeBatchGatekeeper();
    batch.results.push({ invalidatedByVeto: [{ action: 2, invalidatedBy: 1 }] });
    let client = await makeClient(storage, batch.target);

    await expect(client.approveAction(clicked))
        .rejects.toThrow(`Action was invalidated by a rejected earlier action: ${clicked}`);

    let entry = (await client.listActions()).entries.find(candidate => candidate.id === clicked);
    expect(entry).toMatchObject({ state: "rejected", cascadedFrom: vetoId });
  });

  it("denies batch mutation to use-only sessions", async () => {
    let storage = makeStorage();
    let boundary = putAction(storage, 1, { autoApprovable: false });
    let client = await openFakeOverseer(storage, { role: "use" });

    await expect(client.applyActionsThrough(boundary, []))
        .rejects.toThrow("Unauthorized: this collaborator only has permission to use the gadget's UI.");
    expect(getAction(storage, 1).state).toBe("pending");
  });

  it("rejects invalid batch selections before mutation or RPC", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    let boundary = putAction(storage, 2, { autoApprovable: false });
    let later = putAction(storage, 3, { autoApprovable: false });
    let foreign = putAction(storage, 4, { gatekeeperId: GK + 1, autoApprovable: false });
    putStoredAction(storage, 50, { type: "observation" });
    let batch = makeBatchGatekeeper();
    let client = await makeClient(storage, batch.target);

    await expect(client.applyActionsThrough(999, [])).rejects.toThrow("No such action: 999");
    await expect(client.applyActionsThrough(50, [])).rejects.toThrow("Not an action: 50");
    await expect(client.applyActionsThrough(boundary, [foreign]))
        .rejects.toThrow("Action batch contains a different connection.");
    await expect(client.applyActionsThrough(boundary, [later]))
        .rejects.toThrow("Veto is beyond the action batch boundary.");

    expect(batch.calls).toEqual([]);
    for (let action of [1, 2, 3, 4]) expect(getAction(storage, action).state).toBe("pending");
  });

  it("keeps exact approval blocked by an earlier undecided action", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    let boundary = putAction(storage, 2, { autoApprovable: false });
    let batch = makeBatchGatekeeper();
    let client = await makeClient(storage, batch.target);

    let error = await client.approveAction(boundary).catch(caught => caught);

    expect(getActionErrorCode(error)).toBe(ACTION_ERROR_CODES.blocked);
    expect(batch.calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 2).state).toBe("pending");
  });

  // Chat 7 suspended but its storage fails; 8 suspended, with an unsuspended sibling in-turn;
  // 9 suspended but its awaited action was rejected; 10 never suspended; 11 predates the flag
  // and resumes on the rule that used to set it.
  it("resumes only chats whose turn suspended, and one failed resume doesn't strand the rest",
     async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { chatId: 7, awaitDecision: true, suspendedTurn: true });
    let a2 = putAction(storage, 2, { chatId: 8, awaitDecision: true, suspendedTurn: true });
    let a3 = putAction(storage, 3, { chatId: 9, awaitDecision: true, suspendedTurn: true });
    let a4 = putAction(storage, 4,
        { chatId: 10, awaitDecision: true, suspendedTurn: false });
    let a5 = putAction(storage, 5,
        { chatId: 8, awaitDecision: true, suspendedTurn: false, state: "rejected" });
    let a6 = putAction(storage, 6, { chatId: 11, awaitDecision: true });

    let notes = vi.fn();
    let listedChats: string[] = [];
    let client = await openFakeOverseer({
      ...storage,
      chats: {
        list: ({ prefix }: { prefix: string }) => {
          listedChats.push(prefix);
          if (prefix === `${keyString(7)}.`) throw new Error("chat storage unavailable");
          // Chat 8's turn also holds an awaitDecision action that never suspended it.
          if (prefix === `${keyString(8)}.`) {
            return [a2, a5].map(actionId => ({ type: "action", actionId }));
          }
          let actionId = prefix === `${keyString(9)}.` ? a3
              : prefix === `${keyString(11)}.` ? a6 : a4;
          return [{ type: "action", actionId }];
        },
      },
    }, {
      impl: {
        addChatMessages: notes,
        waitForChatMessagePreparation: () => undefined,
        applyActionBatch: async () => {
          for (let action of [1, 2, 3, 4, 6]) {
            let record = getAction(storage, action);
            record.state = action === 3 ? "rejected" : "approved";
            storage.actions.put(record);
          }
          return { decided: [a1, a2, a3, a4, a6] };
        },
      },
    });

    await client.applyActionsThrough(a4, []);

    expect(notes.mock.calls).toEqual([
      [8, expect.anything(), [expect.objectContaining({
        type: "message", message: expect.stringContaining("Action 2"),
      })]],
      [11, expect.anything(), [expect.objectContaining({
        type: "message", message: expect.stringContaining("Action 6"),
      })]],
    ]);
    expect(listedChats).toEqual([
      `${keyString(7)}.`, `${keyString(8)}.`, `${keyString(9)}.`, `${keyString(11)}.`,
    ]);
  });

  it("awaits legacy rejection of a later action without applying other pending actions", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1, { autoApprovable: false });
    let id = putAction(storage, 2);
    putAction(storage, 3);
    let rejected = Promise.withResolvers<void>();
    let legacy = makeLegacyGatekeeper();
    legacy.target.rejectAction = (async (action: number) => {
      legacy.calls.push(`reject:${action}`);
      await rejected.promise;
    }) as typeof legacy.target.rejectAction;
    let client = await makeClient(storage, legacy.target);

    let settled = false;
    let decision = client.rejectAction(id).then(() => { settled = true; });
    await flush();
    expect(legacy.calls).toEqual(["reject:2"]);
    expect(settled).toBe(false);
    expect(getAction(storage, 2).state).toBe("pending");

    rejected.resolve();
    await decision;
    expect(getAction(storage, 2)).toMatchObject({
      state: "rejected", resolvedBy: { id: "profile-id" },
    });
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("leaves a failed rejection pending so the user can retry it", async () => {
    let storage = makeStorage();
    let id = putAction(storage, 1);
    let legacy = makeLegacyGatekeeper();
    let reject = vi.fn().mockRejectedValueOnce(new Error("temporary RPC failure"))
        .mockResolvedValue(undefined);
    legacy.target.rejectAction = reject;
    let client = await makeClient(storage, legacy.target);

    await expect(client.rejectAction(id)).rejects.toThrow("temporary RPC failure");
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 1).appliedAt).toBeUndefined();
    await client.rejectAction(id);
    expect(getAction(storage, 1).state).toBe("rejected");
    expect(legacy.calls).toEqual([]);
  });

  it("keeps immediate rejection on the legacy rejectAction endpoint", async () => {
    let storage = makeStorage();
    putAction(storage, 0);
    let id = putAction(storage, 1);
    putAction(storage, 2);
    let batch = makeBatchGatekeeper();
    let calls: number[] = [];
    let reject = vi.fn(async (action: number) => {
      calls.push(action);
      if (calls.length === 1) throw new Error("temporary RPC failure");
    });
    batch.target.rejectAction = reject as typeof batch.target.rejectAction;
    let client = await makeClient(storage, batch.target);

    await expect(client.rejectAction(id)).rejects.toThrow("temporary RPC failure");
    expect(getAction(storage, 1).state).toBe("pending");
    await client.rejectAction(id);

    expect(calls).toEqual([1, 1]);
    expect(batch.calls).toEqual([]);
    expect(getAction(storage, 0).state).toBe("pending");
    expect(getAction(storage, 1)).toMatchObject({
      state: "rejected", resolvedBy: { id: "profile-id" },
    });
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("distinguishes a blocked approval from an application with a recorded failure", async () => {
    let storage = makeStorage();
    let first = putAction(storage, 1);
    let second = putAction(storage, 2);
    let legacy = makeLegacyGatekeeper({ failApply: [1] });
    let client = await makeClient(storage, legacy.target);

    let blocked = await client.approveAction(second).catch(error => error);
    expect(getActionErrorCode(blocked)).toBe(ACTION_ERROR_CODES.blocked);
    let stopped = await client.approveAction(first).catch(error => error);
    expect(getActionErrorCode(stopped)).toBe(ACTION_ERROR_CODES.stopped);
    expect(getAction(storage, 1)).toMatchObject({ state: "pending", failure: "apply 1 failed" });
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("reports a stop at an earlier rule-authorized action on the clicked one", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    let clicked = putAction(storage, 2, { autoApprovable: false });
    let client = await makeClient(storage, makeLegacyGatekeeper({ failApply: [1] }).target);

    let error = await client.approveAction(clicked).catch(caught => caught);

    expect(getActionErrorCode(error)).toBe(ACTION_ERROR_CODES.stopped);
    expect(getAction(storage, 1)).toMatchObject({ state: "pending", failure: "apply 1 failed" });
    expect(getAction(storage, 2).state).toBe("pending");
    // The reason lives on the action that stopped, so the clicked one carries none of its own.
    expect(getAction(storage, 2).failure).toBeUndefined();
  });

  it("keeps the failure on an action rejected after a failed apply", async () => {
    let storage = makeStorage();
    let id = putAction(storage, 1, { failure: "page was deleted upstream" });
    let client = await makeClient(storage, makeLegacyGatekeeper().target);

    await client.rejectAction(id);

    let record = getAction(storage, 1);
    expect(record.state).toBe("rejected");
    expect(record.vetoPending).toBeUndefined();
    expect(record.failure).toBe("page was deleted upstream");

    // And it survives the mapping to the client API, which is where the user meets it.
    let entry = (await client.listActions()).entries.find(candidate => candidate.id === id);
    expect(entry?.type === "action" && entry.failure).toBe("page was deleted upstream");
  });
});
