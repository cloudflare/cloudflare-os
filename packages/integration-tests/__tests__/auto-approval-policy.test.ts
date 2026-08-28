// Tests for the auto-approval policy gates around sensitive data and operator warnings.
//
// Auto-approval requires the author's per-action `autoApprovable` verdict AND a user-enabled rule
// for the action's kind. Two things must additionally force manual approval no matter what:
// `operatorWarnings` on the action (a warning exists to be read by a human), and the
// restricted-data latch -- even when the rule was enabled before the data was read. (The
// web-fetch restriction has no client-reachable surface, so it is not asserted here.)
//
// The fixture gatekeeper's session drives this through the real ApprovalQueue funnel: `doThing()`
// submits a "poke" action with the given verdict/warnings, and `applyAction` succeeds, so the
// drain's submit -> auto-approve -> apply round trip is the real one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const POKE = { tag: "poke", label: "Pokes" };

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

type Workspace = {
  overseer: RpcStub<Overseer>;
  session: any;
  gatekeeperId: number;
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
    session: await gatekeeper.openSession(),
    gatekeeperId: await gatekeeper.getId(),
  };
}

async function listPokes(ws: Workspace): Promise<Array<ActionLogEntry & { type: "action" }>> {
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
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, POKE);
      await ws.session.doThing({ autoApprovable: true });

      const applied = await waitFor("the poke to be auto-approved", async () => {
        const [poke] = await listPokes(ws);
        return poke?.state === "approved" ? poke : null;
      });
      expect(applied.autoApproved).toBe(true);
    });
  });

  it.concurrent("a warned action holds the queue until a human approves it", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "warned");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, POKE);

      // The warned action is fully rule-covered and author-approved -- only the warning stands
      // between it and auto-application. A clean eligible action behind it must not be applied
      // either (the drain never skips ahead of a manual gate).
      await ws.session.doThing({ autoApprovable: true, warnings: ["Cross-account data risk."] });
      await ws.session.doThing({ autoApprovable: true });
      await settle(ws);

      const pokes = await listPokes(ws);
      expect(pokes.map(p => p.state)).toEqual(["pending", "pending"]);
      expect(pokes[0].description.operatorWarnings).toEqual(["Cross-account data risk."]);

      // A human approving the warned action clears the gate; the one behind it then auto-applies.
      await ws.overseer.approveAction(pokes[0].id);
      const drained = await waitFor("the queued poke to auto-apply", async () => {
        const [first, second] = await listPokes(ws);
        return first.state === "approved" && second?.state === "approved" ? [first, second] : null;
      });
      expect(drained[0].autoApproved).toBeFalsy();
      expect(drained[1].autoApproved).toBe(true);
    });
  });

  it.concurrent("a pre-latch auto-approval rule stops firing once the workspace reads sensitive data",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "pre-latch");
      await ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, POKE);
      await ws.session.readThing(true);

      // Writes-to-self still pend, but the rule the user enabled before the latch must not fire.
      await ws.session.doThing({ autoApprovable: true });
      await settle(ws);
      const [poke] = await listPokes(ws);
      expect(poke.state).toBe("pending");

      // The rule surface refuses a latched workspace outright.
      await expect(ws.overseer.setAutoApprovedActionKind(ws.gatekeeperId, POKE))
          .rejects.toThrow(/cannot be auto-approved/i);
      await expect(ws.overseer.listPreApprovableActions()).resolves.toEqual([]);

      // Manual approval still works: the human is the intended path.
      await ws.overseer.approveAction(poke.id);
      const approved = await waitFor("the poke to be applied after manual approval", async () => {
        const [fresh] = await listPokes(ws);
        return fresh.state === "approved" ? fresh : null;
      });
      expect(approved.autoApproved).toBeFalsy();
    });
  });
});
