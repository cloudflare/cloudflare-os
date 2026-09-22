import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import {
  ActionSyncDriver, ActionSyncStorage, GatekeeperActionTarget, isMethodMissing,
} from "../src/actions.js";
import type { GatekeeperActionRecord, OverseerDurableObject } from "../src/overseer.js";
import {
  ACTION_ERROR_CODES, getActionErrorCode, type ActionLogEntry, type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { ApplyActionsThroughResult } from "@gadgets/workshop-shared/gatekeeper";
import type { ManualApproval } from "../src/actions.js";
import { keyString } from "@gadgets/typed-storage";
import {
  FIXTURE_EPOCH, makeActionStorage as makeStorage, makeSubscriber, openFakeOverseer,
  putAction as putStoredAction, rejectBatchProbe, rejectionOf, type PutActionOptions,
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
// so a test that confuses the two ID spaces fails loudly. `id` overrides that, for tests that need
// the same local action id on two connections.
function putAction(
    storage: ReturnType<typeof makeStorage>, action: number,
    opts: Omit<PutActionOptions, "action" | "type"> & { id?: number } = {}): number {
  let { id = action * 10, ...rest } = opts;
  putStoredAction(storage, id, { gatekeeperId: GK, ...rest, action });
  return id;
}

function getAction(storage: ActionSyncStorage, action: number): GatekeeperActionRecord {
  return getRecord(storage, action * 10);
}

// By workspace record id, for the tests that seed explicit ids.
function getRecord(storage: ActionSyncStorage, id: number): GatekeeperActionRecord {
  let record = storage.actions.get(id);
  if (record?.type !== "action") throw new Error(`No action record ${id}`);
  return record;
}

// A migrated gatekeeper stub: records every batch call and answers from a scripted queue (or {}).
// A call whose frontier matches `parkAt` ("every" matches all) waits until release() (oldest
// first), so tests can hold a pass mid-RPC.
function makeBatchGatekeeper(opts: {parkAt?: number | "every"} = {}) {
  let calls: Array<{actionId: number, vetoes: number[]}> = [];
  let results: Array<ApplyActionsThroughResult | Error> = [];
  let parked: Array<() => void> = [];
  let target = {
    async applyActionsThrough(actionId: number, vetoes: number[]) {
      calls.push({ actionId, vetoes });
      if (opts.parkAt === "every" || opts.parkAt === actionId) {
        await new Promise<void>(resolve => parked.push(resolve));
      }
      let next = results.shift() ?? {};
      if (next instanceof Error) throw next;
      return next;
    },
    async applyAction() { throw new Error("legacy applyAction must not be called"); },
    async rejectAction() { throw new Error("legacy rejectAction must not be called"); },
  } as unknown as GatekeeperActionTarget;
  return { target, calls, results, release: () => parked.shift()!() };
}

// A pre-migration live stub rejects the batch method probe, then serves legacy per-action calls.
function makeLegacyGatekeeper(opts: {failApply?: number[]} = {}) {
  let probes = 0;
  let calls: string[] = [];
  let target = {
    async applyActionsThrough() {
      probes++;
      rejectBatchProbe();
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

function makeDriver(
    storage: ActionSyncStorage,
    target: GatekeeperActionTarget | ((gatekeeperId: number) => GatekeeperActionTarget)) {
  return new ActionSyncDriver(storage, typeof target === "function" ? target : () => target, {
    createGitCache: vi.fn(),
    createGitPackBuilder: vi.fn(),
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
    applyActionBatch: (boundaryId: number, vetoIds: readonly number[],
        author: AiChatAuthorInfo) => driver.applyThrough(boundaryId, vetoIds, author),
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
        .toEqual({ decided: [], blocked: true });
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
    expect(first.stopped).toBe(true);
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

  it("never re-applies a failed action on a rule alone, neither deciding it nor dropping the rule",
     async () => {
    let storage = makeStorage();
    enableRule(storage);
    let a1 = putAction(storage, 1);
    putAction(storage, 2);

    let { target, calls, results } = makeBatchGatekeeper();
    results.push({ stopped: { at: 1, reason: new Error("the upstream page was deleted") } });
    await makeDriver(storage, target).apply(GK);

    expect(calls).toEqual([{ actionId: 2, vetoes: [] }]);
    expect(getAction(storage, 2).state).toBe("pending");
    // The gatekeeper said why it stopped, not whether the action landed, so re-sending it
    // unattended could repeat a side effect. It becomes a gate until a human retries it -- which
    // means the rule that authorized the attempt has to survive the attempt.
    expect(storage.autoApproveTags.get(`${GK}:edit`)?.enabledBy).toEqual(ENABLER);

    // Nor is the attempt a decision: the user sees a pending action with a reason and no resolver.
    let entry = (await (await openFakeOverseer(storage)).listActions({ filter: "pending" }))
        .entries.find(candidate => candidate.id === a1);
    expect(entry).toMatchObject({
      state: "pending", failure: "the upstream page was deleted" });
    expect(entry?.type === "action" && entry.resolvedBy).toBeUndefined();
    expect(entry?.type === "action" && entry.autoApproved).toBeUndefined();

    // A fresh driver (a restarted DO) runs the rule pass again and must not retry it.
    await makeDriver(storage, target).apply(GK);
    expect(calls).toEqual([{ actionId: 2, vetoes: [] }]);
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
        .toEqual({ decided: [], blocked: true });

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
    await makeDriver(storage, target).applyThrough(getAction(storage, 2).id, [], REJECTER);

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
        getAction(storage, 3).id, [getAction(storage, 2).id], APPROVER);

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
        getAction(storage, 2).id, [getAction(storage, 1).id, getAction(storage, 2).id], REJECTER);

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
        .applyThrough(getAction(storage, 0).id, [], APPROVER);

    expect(result.stopped).toBe(true);
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
        .applyThrough(getAction(storage, 3).id, [], APPROVER);

    expect(result.stopped).toBe(true);
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
        .applyThrough(getAction(storage, 3).id, [], REJECTER);

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
        .applyThrough(getAction(storage, 1).id, [], APPROVER);

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
        .applyThrough(getAction(storage, 2).id, [], REJECTER);

    expect(decided).toEqual([]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  it("records a veto the gatekeeper refused as already applied", async () => {
    let storage = makeStorage();
    let a1 = putAction(storage, 1, { autoApprovable: false });
    let a2 = putAction(storage, 2,
        { autoApprovable: false, failure: "an earlier attempt stopped here" });
    putAction(storage, 4, { state: "rejected", vetoPending: true, resolvedBy: REJECTER });

    // Action 2 stopped once, was applied on the retry with the reply lost, and was then
    // rejected. Recording that rejection would enter an executed action as denied, and the
    // stale reason would ride along onto an approved card.
    let { target, calls, results } = makeBatchGatekeeper();
    results.push({ alreadyApplied: [2, 4] });
    let { decided, vetoRefused } = await makeDriver(storage, target)
        .applyThrough(a2, [a2], REJECTER);

    expect(calls).toEqual([{ actionId: 2, vetoes: [2] }]);
    expect(decided.toSorted((a, b) => a - b)).toEqual([a1, a2]);
    expect(vetoRefused).toBe(true);
    expect(getAction(storage, 1).state).toBe("approved");
    let refused = getAction(storage, 2);
    expect(refused.state).toBe("approved");
    expect(refused.vetoPending).toBeUndefined();
    // The approving pass never got to record who authorized it, and the vetoer did not. The
    // marker is what keeps the card from reading as a decision someone made.
    expect(refused.resolvedBy).toBeUndefined();
    expect(refused.failure).toBeUndefined();
    expect(refused.vetoRefused).toBe(true);
    // Action 4's veto sat beyond the boundary, so it was never sent and is not the gatekeeper's
    // to refuse.
    expect(getAction(storage, 4)).toMatchObject({ state: "rejected", vetoPending: true });
  });

  it("coalesces concurrent approvals into one follow-up pass at the highest frontier", async () => {
    let storage = makeStorage();
    putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });

    let { target, calls, release } = makeBatchGatekeeper({ parkAt: "every" });
    let driver = makeDriver(storage, target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });   // parks mid-RPC
    await flush();
    let second = driver.apply(GK, { action: 3, resolvedBy: APPROVER });  // staged
    let third = driver.apply(GK, { action: 2, resolvedBy: APPROVER });   // merged with second
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);

    release();  // finish pass 1
    await flush();
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }, { actionId: 3, vetoes: [] }]);

    release();  // finish pass 2
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
    let { target, calls, release } = makeBatchGatekeeper({ parkAt: 1 });
    let driver = makeDriver(storage, target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await flush();
    let batch = driver.applyThrough(
        getAction(storage, 2).id, [getAction(storage, 2).id], REJECTER);
    let later = driver.apply(GK, { action: 3, resolvedBy: APPROVER });

    release();
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
    let { target, calls, release } = makeBatchGatekeeper({ parkAt: 1 });
    let driver = makeDriver(storage, target);

    let first = driver.apply(GK, { action: 1, resolvedBy: APPROVER });
    await flush();
    let batch = driver.applyThrough(
        getAction(storage, 3).id, [getAction(storage, 2).id], REJECTER);
    storage.actions.delete(20);
    release();

    await first;
    await expect(batch).rejects.toThrow("No such action: 20");
    expect(calls).toEqual([{ actionId: 1, vetoes: [] }]);
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("ignores a selected veto the queue's earlier pass approved", async () => {
    let storage = makeStorage();
    putAction(storage, 2, { autoApprovable: false });
    putAction(storage, 3, { autoApprovable: false });
    let { target, calls, release } = makeBatchGatekeeper({ parkAt: 2 });
    let driver = makeDriver(storage, target);

    let click = driver.apply(GK, { action: 2, resolvedBy: APPROVER });
    await flush();
    let batch = driver.applyThrough(
        getAction(storage, 3).id, [getAction(storage, 2).id], REJECTER);
    release();
    await Promise.all([click, batch]);

    expect(calls).toEqual([{ actionId: 2, vetoes: [] }, { actionId: 3, vetoes: [] }]);
    expect(getAction(storage, 2)).toMatchObject({ state: "approved", resolvedBy: APPROVER });
    expect(getAction(storage, 3)).toMatchObject({ state: "approved", resolvedBy: REJECTER });
  });

  it("refuses a queued batch that was selected before an in-range action failed", async () => {
    let storage = makeStorage();
    for (let action of [1, 2, 3]) putAction(storage, action, { autoApprovable: false });
    let { target, calls, results, release } = makeBatchGatekeeper({ parkAt: 2 });
    results.push({ stopped: { at: 2, reason: new Error("the document was locked") } });
    let driver = makeDriver(storage, target);

    let first = driver.applyThrough(getAction(storage, 2).id, [], APPROVER);
    await flush();
    let second = driver.applyThrough(
        getAction(storage, 3).id, [getAction(storage, 3).id], REJECTER);
    release();

    expect((await first).stopped).toBe(true);
    // Selected before action 2 failed, so it is not authority to retry it -- and its own veto is
    // not staged, since the batch it belongs to never ran.
    expect(await second).toEqual({ decided: [], stopped: true });
    expect(calls).toEqual([{ actionId: 2, vetoes: [] }]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2)).toMatchObject({
      state: "pending", failure: "the document was locked" });
    expect(getAction(storage, 3).state).toBe("pending");
    expect(getAction(storage, 3).vetoPending).toBeUndefined();
  });

  it("runs a queued batch that vetoes the action a stop just failed on", async () => {
    let storage = makeStorage();
    for (let action of [1, 2, 3]) putAction(storage, action, { autoApprovable: false });
    let { target, calls, results, release } = makeBatchGatekeeper({ parkAt: 2 });
    results.push({ stopped: { at: 2, reason: new Error("the document was locked") } });
    let driver = makeDriver(storage, target);

    let first = driver.applyThrough(getAction(storage, 2).id, [], APPROVER);
    await flush();
    let second = driver.applyThrough(
        getAction(storage, 3).id, [getAction(storage, 2).id], REJECTER);
    release();
    await Promise.all([first, second]);

    // Rejecting what failed removes the barrier, so the rest of the batch is not cancelled along
    // with it. The reason stays on the record as the history of why it was rejected.
    expect(calls).toEqual([{ actionId: 2, vetoes: [] }, { actionId: 3, vetoes: [2] }]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2)).toMatchObject({
      state: "rejected", resolvedBy: REJECTER, failure: "the document was locked" });
    expect(getAction(storage, 2).vetoPending).toBeUndefined();
    expect(getAction(storage, 3).state).toBe("approved");
  });

  it("keeps a stop from freezing a queued retry on another connection", async () => {
    let storage = makeStorage();
    let other = GK + 1;
    let a1 = putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 0, { gatekeeperId: other, autoApprovable: false, id: 20 });
    let b1 = putAction(storage, 1, { gatekeeperId: other, autoApprovable: false, id: 30,
                                     failure: "an earlier attempt failed" });
    let a = makeBatchGatekeeper();
    a.results.push({ stopped: { at: 1, reason: new Error("A refused action one") } });
    let b = makeBatchGatekeeper({ parkAt: 0 });
    let driver = makeDriver(storage, id => id === GK ? a.target : b.target);

    let held = driver.apply(other, { action: 0, resolvedBy: APPROVER });
    await flush();
    // Queued on B, then A stops on the same gatekeeper-local action number. Stops are per
    // connection: A's failure is no reason to hold B's queue.
    let retry = driver.apply(other, { action: 1, resolvedBy: APPROVER });
    expect((await driver.apply(GK, { action: 1, resolvedBy: APPROVER })).stopped).toBe(true);
    b.release();
    await Promise.all([held, retry]);

    expect(b.calls).toEqual([{ actionId: 0, vetoes: [] }, { actionId: 1, vetoes: [] }]);
    expect(getRecord(storage, b1).state).toBe("approved");
    expect(getRecord(storage, b1).failure).toBeUndefined();
    expect(getRecord(storage, a1)).toMatchObject({
      state: "pending", failure: "A refused action one" });
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

    let { target, results, release } = makeBatchGatekeeper({ parkAt: 2 });
    results.push({ invalidatedByVeto: [{ action: 3, invalidatedBy: 2 }] });
    let pass = makeDriver(storage, target)
        .applyThrough(getAction(storage, 2).id, [], REJECTER);
    await flush();

    // Action 3 is published while the call is parked: the contract lets the gatekeeper report it
    // invalidated because its submission completed before the result returned -- but it arrived
    // too late for the pre-call snapshot.
    let a3 = putAction(storage, 3, { autoApprovable: false });
    release();
    let { decided } = await pass;

    expect(decided).toContain(a3);
    let invalidated = getAction(storage, 3);
    expect(invalidated.state).toBe("rejected");
    expect(invalidated.cascadedFrom).toBe(vetoId);
  });
});

describe("ActionSyncDriver legacy fallback", () => {
  it("recognizes workerd's real missing-method error", async () => {
    let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
    // The DO itself lacks the client interface's batch method; probe workerd's actual rejection.
    const receiver = stub as unknown as Fetcher<Pick<Overseer, "applyActionsThrough">>;
    using call = receiver.applyActionsThrough(1, []);

    expect(isMethodMissing(await rejectionOf(call))).toBe(true);
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
        getAction(storage, 3).id, [getAction(storage, 1).id, getAction(storage, 2).id], REJECTER))
        .rejects.toThrow("reject 2 failed");

    expect(getAction(storage, 1).vetoPending).toBeUndefined();
    expect(getAction(storage, 2).vetoPending).toBe(true);
    expect(legacy.calls).toEqual(["reject:1", "reject:2"]);
    expect(getAction(storage, 3).state).toBe("pending");

    failSecond = false;
    await makeDriver(storage, legacy.target)
        .applyThrough(getAction(storage, 3).id, [], APPROVER);

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

  it("tells the rejecting client its veto was refused as already applied", async () => {
    let storage = makeStorage();
    let boundary = putAction(storage, 1, { autoApprovable: false });
    let batch = makeBatchGatekeeper();
    batch.results.push({ alreadyApplied: [1] });
    let client = await makeClient(storage, batch.target);

    let error = await client.applyActionsThrough(boundary, [boundary]).catch(caught => caught);

    // Staging already showed the card denied, so the flip to approved has to be explained: the
    // caller hears it now, and the record carries it for everyone who only sees the card later.
    expect(getActionErrorCode(error)).toBe(ACTION_ERROR_CODES.vetoRefused);
    expect(storage.actions.get(boundary))
        .toMatchObject({ state: "approved", vetoRefused: true });
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
    let client = await openFakeOverseer({
      ...storage,
      chats: {
        list: ({ prefix }: { prefix: string }) => {
          if (prefix === `${keyString(7)}.`) throw new Error("chat storage unavailable");
          // Chat 8's turn also holds an awaitDecision action that never suspended it.
          if (prefix === `${keyString(8)}.`) {
            return [a2, a5].map(actionId => ({ type: "action", actionId }));
          }
          let actionId = a4;
          if (prefix === `${keyString(9)}.`) actionId = a3;
          else if (prefix === `${keyString(11)}.`) actionId = a6;
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
  });

  // The rule pass is the only decision this action will get: nothing later revisits the turn it
  // suspended.
  it("resumes a chat the newly enabled auto-approval rule unblocks", async () => {
    let storage = makeStorage();
    let action = putAction(storage, 1, { chatId: 7, awaitDecision: true, suspendedTurn: true });

    let notes = vi.fn();
    let waits: Promise<unknown>[] = [];
    let client = await openFakeOverseer({
      ...storage,
      gatekeepers: { get: () => ({ id: GK }) },
      chats: { list: () => [{ type: "action", actionId: action }] },
    }, {
      impl: {
        ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
        addChatMessages: notes,
        waitForChatMessagePreparation: () => undefined,
        applyDecidedActions: async () => {
          let record = getAction(storage, 1);
          record.state = "approved";
          storage.actions.put(record);
          return { decided: [action] };
        },
      },
    });

    await client.setAutoApprovedActionKind(GK, { tag: "edit", label: "Edits" });
    await Promise.all(waits);

    expect(notes.mock.calls).toEqual([
      [7, expect.anything(), [expect.objectContaining({
        type: "message", message: expect.stringContaining("Action 1"),
      })]],
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

  it("keeps immediate rejection on the legacy endpoint, leaving a failed one pending to retry",
     async () => {
    let storage = makeStorage();
    putAction(storage, 0);
    let id = putAction(storage, 1);
    putAction(storage, 2);
    let batch = makeBatchGatekeeper();
    let calls: number[] = [];
    async function reject(action: number): Promise<void> {
      calls.push(action);
      if (calls.length === 1) throw new Error("temporary RPC failure");
    }
    batch.target.rejectAction = reject as typeof batch.target.rejectAction;
    let client = await makeClient(storage, batch.target);

    await expect(client.rejectAction(id)).rejects.toThrow("temporary RPC failure");
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 1).appliedAt).toBeUndefined();
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

  it("reports the stop, not the gate, when both hold on one pass", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);                             // rule-authorized, below the gate
    putAction(storage, 2, { autoApprovable: false });  // undecided gate
    let clicked = putAction(storage, 3, { autoApprovable: false });
    let batch = makeBatchGatekeeper();
    batch.results.push({ stopped: { at: 1, reason: new Error("provider refused") } });
    let client = await makeClient(storage, batch.target);

    let error = await client.approveAction(clicked).catch(caught => caught);

    // The gate lowers the frontier, but the prefix under it still goes out -- so the pass is both
    // blocked and stopped. Naming the gate would send the user to approve action 2 and meet the
    // same failure again, never pointing at the card that explains it.
    expect(batch.calls).toEqual([{ actionId: 1, vetoes: [] }]);
    expect(getActionErrorCode(error)).toBe(ACTION_ERROR_CODES.stopped);
    expect(getAction(storage, 1)).toMatchObject({
      state: "pending", failure: "provider refused" });
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });

  it("refuses a queued approval that was requested before the action failed", async () => {
    let storage = makeStorage();
    let id = putAction(storage, 1, { autoApprovable: false });
    putAction(storage, 2, { autoApprovable: false });
    let held = Promise.withResolvers<void>();
    let applies = 0;
    let legacy = makeLegacyGatekeeper();
    legacy.target.applyAction = (async () => {
      applies++;
      await held.promise;
      throw new Error("the connection dropped before the response arrived");
    }) as typeof legacy.target.applyAction;
    let client = await makeClient(storage, legacy.target);

    let first = client.approveAction(id).catch(caught => caught);
    await flush();
    // Queued while the first attempt is still in flight, so it carries no authority to retry a
    // failure that did not exist when it was made: the outcome of the lost call is unknown, and
    // repeating it unasked could repeat a side effect that landed.
    let second = client.approveAction(id).catch(caught => caught);
    held.resolve();

    expect(getActionErrorCode(await first)).toBe(ACTION_ERROR_CODES.stopped);
    expect(getActionErrorCode(await second)).toBe(ACTION_ERROR_CODES.stopped);
    expect(applies).toBe(1);
    expect(getAction(storage, 1)).toMatchObject({
      state: "pending", failure: "the connection dropped before the response arrived",
    });
    expect(getAction(storage, 2).state).toBe("pending");

    // A request made after the stop was recorded is fresh authority, and does retry it.
    legacy.target.applyAction = (async () => { applies++; }) as typeof legacy.target.applyAction;
    await client.approveAction(id);

    expect(applies).toBe(2);
    expect(getAction(storage, 1)).toMatchObject({
      state: "approved", resolvedBy: { id: "profile-id" }, autoApproved: false,
    });
    expect(getAction(storage, 1).failure).toBeUndefined();
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("reports a stop at an earlier rule-authorized action on the clicked one", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    let clicked = putAction(storage, 2, { autoApprovable: false });
    let later = putAction(storage, 3, { autoApprovable: false });
    let held = Promise.withResolvers<void>();
    let legacy = makeLegacyGatekeeper();
    legacy.target.applyAction = (async (action: number) => {
      legacy.calls.push(`apply:${action}`);
      await held.promise;
      throw new Error("apply 1 failed");
    }) as typeof legacy.target.applyAction;
    let client = await makeClient(storage, legacy.target);

    let first = client.approveAction(clicked).catch(caught => caught);
    await flush();
    // Queued above the action that is about to fail. Once it has, this click reports that stop
    // rather than "approve the earlier action first": that gate was already rule-authorized.
    let second = client.approveAction(later).catch(caught => caught);
    held.resolve();

    expect(getActionErrorCode(await first)).toBe(ACTION_ERROR_CODES.stopped);
    expect(getActionErrorCode(await second)).toBe(ACTION_ERROR_CODES.stopped);
    expect(legacy.calls).toEqual(["apply:1"]);
    expect(getAction(storage, 1)).toMatchObject({ state: "pending", failure: "apply 1 failed" });
    // The reason lives on the action that stopped, so neither later action carries one of its own.
    for (let action of [2, 3]) {
      expect(getAction(storage, action).state).toBe("pending");
      expect(getAction(storage, action).failure).toBeUndefined();
    }
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

describe("Overseer auto-approval dispatch", () => {
  it("starts the apply pass only after submitAction returns", async () => {
    let applied: number[] = [];
    let dispatched = Promise.withResolvers<void>();
    let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());

    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      // Reaching the DO's own impl, which the class does not expose; the fake facet it receives
      // is deliberately narrower than the real one, so this stays untyped.
      let host = instance as unknown as { impl: any };
      let impl = host.impl;
      impl.getGatekeeperFacet = () => ({
        async applyActionsThrough(actionId: number) {
          applied.push(actionId);
          dispatched.resolve();
          return {};
        },
      });
      let actionKind = { tag: "push", label: "Push" };
      impl.storage.autoApproveTags.put({ gatekeeperId: GK, actionKind, enabledBy: APPROVER });

      await impl.submitAction(GK, 1, {
        title: "Push to main",
        description: "Pushes the listed commits.",
        implementsRevert: true,
        autoApprovable: true,
        actionKind,
      }, { from: "user" });

      // A gatekeeper reaches here with its submitAction() still in flight, so a pass dispatched
      // inline would ask it to apply an action it has not finished submitting.
      expect(applied).toStrictEqual([]);

      await dispatched.promise;
      expect(applied).toStrictEqual([1]);
    });
  });
});
