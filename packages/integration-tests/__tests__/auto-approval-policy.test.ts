// Tests for the auto-approval policy gate around sensitive data.
//
// A write outside any chat (a user's session on the connection) is staged, and applies at once
// as the workspace owner, unless the restricted-data latch makes staging hold it. A chat's write
// waits for the chat; one the agent waits on (every fixture write) applies as it is submitted only
// when the chat is in Auto and the author's `autoApprovable` verdict covers it and every earlier
// pending write on the chat's branch. Rules have no effect. (The web-fetch restriction has no
// client-reachable surface, so it is not asserted here.)
//
// The fixture gatekeeper's session drives this through the real ApprovalQueue funnel:
// `writeValue()` submits an awaited `set-value` action with the given verdict, and `applyAction`
// succeeds, so the submit -> apply round trip is the real one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
  withOwnerWorkspace, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { openAgentSession } from "../src/agent-session.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";

// The kind the fixture tags every write with (and advertises via getAutoApprovableActions).
const SET_VALUE = { tag: "set-value", label: "Set value" };

let harness: Harness;
let interceptor: NetworkInterceptor;
const models = scriptedModelRouter();

beforeAll(async () => {
  interceptor = new NetworkInterceptor({ handlers: [models.handler] });
  interceptor.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
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

const actionState = (label: string) => testActionState(harness, label);

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
  const overseer = await aliceApi.newWorkspace();
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

// An apply at submit runs via ctx.waitUntil, so "did not auto-approve" needs a settle window.
// One further RPC round trip plus a beat is far beyond its synchronous storage work.
async function settle(ws: Workspace): Promise<void> {
  await ws.overseer.listActions();
  await new Promise(resolve => setTimeout(resolve, 300));
}

describe("auto-approval policy", () => {
  it.concurrent("applies a staged action at once, with no human involved", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "auto-happy");
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

      // Staging now holds the write for a user's review, and the rule the user enabled before the
      // latch does not release it.
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

  it.concurrent("switching a chat to Review returns eligible writes to manual approval",
      async () => {
    const model = models.script([
      executeCode("await env.TEST_AMBIENT.readValue()"), { text: "Read." },
      executeCode("await env.TEST_AMBIENT.writeValue(1, {autoApprovable: true})"),
      { text: "Written." },
      executeCode("await env.TEST_AMBIENT.writeValue(2, {autoApprovable: true})"),
      { text: "Written again." },
    ]);
    await using agent = await openAgent(model, "autooff");
    const label = accountLabel(agent.connectedAccount(TEST_VENDOR_ID));
    await agent.runTurn("Read the test value.");
    await withOwnerWorkspace(harness.url, agent.username, async overseer => {
      await agent.runTurn("Set the test value to 1.");
      await waitFor("the first write to be applied", async () =>
        (await actionState(label)).applyCount === 1 || null);
      const [first] = await chatWrites(overseer);
      expect(first).toMatchObject({ state: "approved", autoApproved: true });

      await overseer.setChatMode(first.chatId!, "review");

      await agent.runTurn("Set the test value to 2.");
      const [, held] = await chatWrites(overseer);
      expect(held.state).toBe("pending");
      await expect(actionState(label)).resolves.toEqual(
          { pending: [{ id: 2, value: 2 }], value: 1, applyCount: 1 });

      await agent.approveActionsAndWait([held.id]);
      const [, approved] = await chatWrites(overseer);
      expect(approved.state).toBe("approved");
      expect(approved.autoApproved).toBeFalsy();
      await expect(actionState(label)).resolves.toEqual({ pending: [], value: 2, applyCount: 2 });
    });
  });

  it.concurrent("an eligible write waits behind a manual one, and enabling a rule applies neither",
      async () => {
    const model = models.script([
      executeCode(
          "await env.TEST_AMBIENT.writeValue(1), " +
          "await env.TEST_AMBIENT.writeValue(2, {autoApprovable: true})"),
    ]);
    await using agent = await openAgent(model, "autopending");
    const label = accountLabel(agent.connectedAccount(TEST_VENDOR_ID));
    await agent.runTurn("Set the test value to 1, then 2.");
    await withOwnerWorkspace(harness.url, agent.username, async overseer => {
      expect((await chatWrites(overseer)).map(write => write.state))
          .toEqual(["pending", "pending"]);
      await expect(actionState(label)).resolves.toEqual(
          { pending: [{ id: 1, value: 1 }, { id: 2, value: 2 }], applyCount: 0 });

      await overseer.setAutoApprovedActionKind((await chatWrites(overseer))[0].gatekeeperId!,
          SET_VALUE);

      await settle({ overseer } as Workspace);
      expect((await chatWrites(overseer)).map(write => write.state))
          .toEqual(["pending", "pending"]);
      await expect(actionState(label)).resolves.toEqual(
          { pending: [{ id: 1, value: 1 }, { id: 2, value: 2 }], applyCount: 0 });
    });
  });
});

const executeCode = (code: string): ChatCompletionStep => ({
  toolCall: {
    id: "run",
    name: "executeCode",
    arguments: { code: `export default async function(self, env) { console.log(${code}); }` },
  },
});

// An agent with the ambient test connection, whose writes are its chat's.
const openAgent = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
  });

async function chatWrites(overseer: RpcStub<Overseer>) {
  const { entries } = await overseer.listActions({ filter: "action" });
  return entries.filter((entry): entry is ActionLogEntry & { type: "action" } =>
    entry.type === "action").toSorted((a, b) => a.id - b.id);
}
