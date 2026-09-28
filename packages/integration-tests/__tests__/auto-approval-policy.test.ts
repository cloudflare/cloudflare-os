// Tests for the auto-approval policy gate around sensitive data.
//
// Auto-approval requires the author's per-action `autoApprovable` verdict AND a user-enabled rule
// for the action's kind. The restricted-data latch must additionally force manual approval no
// matter what -- even when the rule was enabled before the data was read. (The web-fetch
// restriction has no client-reachable surface, so it is not asserted here.)
//
// The fixture gatekeeper's session drives this through the real ApprovalQueue funnel:
// `writeValue()` submits a `set-value` action with the given verdict and resolves once the action
// is decided, and `applyAction` succeeds, so the drain's submit -> auto-approve -> apply round
// trip is the real one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import { z } from "zod";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
  type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

// The kind the fixture tags every write with (and advertises via getAutoApprovableActions).
const SET_VALUE = { tag: "set-value", label: "Set value" };

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

const TEST_ACTION_STATE = z.object({
  pending: z.array(z.object({ id: z.number(), value: z.number() })),
  value: z.number().optional(),
  applyCount: z.number(),
});

async function actionState(label: string) {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state",
      { method: "POST", body: JSON.stringify({ label }) });
  if (response.status !== 200) {
    throw new Error(`Reading test action state failed with ${response.status}: ${await response.text()}`);
  }
  return TEST_ACTION_STATE.parse(await response.json());
}

type Workspace = {
  overseer: RpcStub<Overseer>;
  session: RpcStub<TestSession>;
  gatekeeperId: number;
  label: string;
};

async function newWorkspace(publicApi: RpcStub<PublicApi>, thingName: string): Promise<Workspace> {
  const [alice] = nextUsernames("alice");
  const aliceApi = await signUp(publicApi, alice);
  const account = await provisionAccount(aliceApi);
  const overseer = await aliceApi.newGadget();
  const gatekeeper = await overseer.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${thingName}`);
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  return {
    overseer,
    session: await gatekeeper.openSession() as RpcStub<TestSession>,
    gatekeeperId: await gatekeeper.getId(),
    label: accountLabel(account),
  };
}

async function listWrites(ws: Workspace): Promise<Array<ActionLogEntry & { type: "action" }>> {
  // listActions pages newest-first; sort back to creation order, which the tests reason in.
  const { entries } = await ws.overseer.listActions();
  return entries.filter(
      (a): a is ActionLogEntry & { type: "action" } =>
          a.type === "action" && a.gatekeeperId === ws.gatekeeperId)
      .toSorted((a, b) => a.id - b.id);
}

// The drain runs via ctx.waitUntil after submit, so "did not auto-approve" needs a settle window.
// One further RPC round trip plus a beat is far beyond the drain's synchronous storage work.
async function settle(ws: Workspace): Promise<void> {
  await ws.overseer.listActions();
  await new Promise(resolve => setTimeout(resolve, 300));
}

describe("auto-approval policy", () => {
  it.concurrent("auto-approves a rule-enabled, author-approvable action", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "auto-happy");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      // Resolves once the action is decided -- here, by the drain, with no human involved.
      await expect(ws.session.writeValue(1, { autoApprovable: true }))
          .resolves.toEqual(expect.any(Number));

      const applied = await waitFor("the write to be auto-approved", async () => {
        const [write] = await listWrites(ws);
        return write?.state === "approved" ? write : null;
      });
      expect(applied.autoApproved).toBe(true);
    });
  });

  it.concurrent("a pre-latch auto-approval rule stops firing once the workspace reads sensitive data",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "pre-latch");
      // The catalog lists only connections some gadget binds (pure storage writes; no gadget code
      // runs), so bind this one to make its rule visible below. Unshared, so no restart.
      using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
      await gadget.bind("TEST_THING", ws.gatekeeperId);
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      await ws.session.readValue(true);

      // Actions still pend, but the rule the user enabled before the latch must not fire.
      // The write resolves only once decided, so it is held rather than awaited here.
      const write = ws.session.writeValue(2, { autoApprovable: true });
      await settle(ws);
      const [held] = await listWrites(ws);
      expect(held.state).toBe("pending");

      // The catalog still names each existing rule's connection so it stays identifiable and
      // revocable in the UI.
      await expect(ws.overseer.listPreApprovableActions()).resolves.toEqual([
        expect.objectContaining({
          gatekeeperId: ws.gatekeeperId, actionKind: SET_VALUE, alreadyEnabled: true,
        }),
      ]);

      // Manual approval still works: the human is the intended path.
      await ws.overseer.approveAction(held.id);
      await expect(write).resolves.toEqual(expect.any(Number));
      const [approved] = await listWrites(ws);
      expect(approved.state).toBe("approved");
      expect(approved.autoApproved).toBeFalsy();
    });
  });

  it.concurrent("removing an auto-approval rule returns eligible writes to manual approval",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "auto-off");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE);
      await ws.session.writeValue(1, { autoApprovable: true });
      await waitFor("the first write to be applied", async () =>
        (await actionState(ws.label)).applyCount === 1 || null);
      await expect(actionState(ws.label)).resolves.toEqual({ pending: [], value: 1, applyCount: 1 });
      const [first] = await listWrites(ws);
      expect(first).toMatchObject({ state: "approved", autoApproved: true });

      await ws.overseer.removeAutoApprovedActionKind(ws.gatekeeperId, SET_VALUE.tag);
      await expect(ws.overseer.listAutoApprovedActionKinds()).resolves.toEqual([]);

      const write = ws.session.writeValue(2, { autoApprovable: true });
      await waitFor("the second write to be submitted", async () =>
        (await listWrites(ws)).length === 2 || null);
      await settle(ws);
      const [, held] = await listWrites(ws);
      expect(held.state).toBe("pending");
      expect(held.autoApproved).toBeFalsy();
      await expect(actionState(ws.label)).resolves.toEqual(
          { pending: [{ id: 2, value: 2 }], value: 1, applyCount: 1 });

      await ws.overseer.approveAction(held.id);
      await expect(write).resolves.toBe(2);
      const [, approved] = await listWrites(ws);
      expect(approved.state).toBe("approved");
      expect(approved.autoApproved).toBeFalsy();
      await expect(actionState(ws.label)).resolves.toEqual({ pending: [], value: 2, applyCount: 2 });
    });
  });
});
