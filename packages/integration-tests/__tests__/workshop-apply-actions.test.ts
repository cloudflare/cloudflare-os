// Applying a branch (plans/forking-reality.md) against a real gatekeeper Worker: how the Workshop
// reads Gatekeeper.applyActions() off the facet stub, the lists it hands a gatekeeper that has
// adopted branches, and what it records from each call's result. The fixture's
// BranchTestGatekeeper applies one action at a time until a session switches it to lists
// (TestSession.setApplyMode()), as a gatekeeper upgraded with actions pending would; the kernel's
// own unit tests cover the reconciliation cases one by one.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor, withOwnerWorkspace,
  type ConnectedAccount,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const control = <T>(route: string, body: object) => testControl<T>(harness, route, body);
const actionState = (label: string) => testActionState(harness, label);
const applyLists = async (label: string) =>
  (await control<{ lists: { branch: string | null; actions: number[] }[] }>("apply-lists", { label }))
      .lists;

type Workspace = {
  publicApi: RpcStub<PublicApi>;
  overseer: RpcStub<Overseer>;
  gatekeeperId: number;
  label: string;
  /** A user's session on the connection: outside any chat, so its actions are staged. */
  openSession(): Promise<RpcStub<TestSession>>;
  [Symbol.dispose](): void;
};

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

// A workspace connected to the thing `name`: through BranchTestGatekeeper for a `branches-` name,
// and through TestGatekeeper, which has no `applyActions` member, otherwise.
async function newWorkspace(name: string): Promise<Workspace> {
  const publicApi = connect(harness.url);
  const [user] = nextUsernames("branches");
  const api = await signUp(publicApi, user);
  const account = await provisionAccount(api);
  const overseer = await api.newWorkspace();
  const gatekeeper = await overseer.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${name}-${crypto.randomUUID()}`);
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  return {
    publicApi, overseer, gatekeeperId: await gatekeeper.getId(), label: accountLabel(account),
    openSession: async () => await gatekeeper.openSession() as RpcStub<TestSession>,
    [Symbol.dispose]: () => publicApi[Symbol.dispose](),
  };
}

async function writes(ws: Pick<Workspace, "overseer">, gatekeeperId: number) {
  const { entries } = await ws.overseer.listActions({ filter: "action" });
  return entries.filter((entry): entry is ActionLogEntry & { type: "action" } =>
    entry.type === "action" && entry.gatekeeperId === gatekeeperId).toSorted((a, b) => a.id - b.id);
}

it.concurrent("reads applyActions off the facet stub, absent, undefined or implemented", async () => {
  for (const [name, mode] of [["legacy", null], ["branches", null], ["branches", "branches"]] as const) {
    using ws = await newWorkspace(name);
    using session = await ws.openSession();
    await session.setApplyMode(mode);
    await session.writeValue(1);
    const [write] = await writes(ws, ws.gatekeeperId);
    await ws.overseer.approveAction(write.id);
    expect(await actionState(ws.label)).toEqual({ pending: [], value: 1, applyCount: 1 });
    // Only a gatekeeper that implements it is handed a list.
    expect(await applyLists(ws.label)).toEqual(mode ? [{ branch: null, actions: [1] }] : []);
  }
});

it.concurrent("refuses a submission when reading applyActions fails for another reason", async () => {
  using ws = await newWorkspace("branches");
  using session = await ws.openSession();
  await session.setApplyMode("broken");
  await expect(session.writeValue(1)).rejects.toThrow("cannot say how it applies actions");
  expect(await writes(ws, ws.gatekeeperId)).toEqual([]);
  expect(await actionState(ws.label)).toEqual({ pending: [], applyCount: 0 });
});

it.concurrent("hands a list, again with what is left, and stops at a failure until retried",
    async () => {
  using ws = await newWorkspace("branches");
  using session = await ws.openSession();
  await session.setApplyMode("branches");
  for (const value of [1, 2, 3, 4]) await session.writeValue(value);
  const ids = (await writes(ws, ws.gatekeeperId)).map(write => write.id);

  await control("apply-limit", { label: ws.label, limit: 1 });
  await control("fail-list", { label: ws.label, action: 3, message: "Three is locked.", retryable: true });
  await expect(ws.overseer.approveAction(ids[3])).rejects.toThrow("Three is locked.");
  // The second call applies 2 and then stops at 3.
  expect(await applyLists(ws.label)).toEqual(
      [{ branch: null, actions: [1, 2, 3, 4] }, { branch: null, actions: [2, 3, 4] }]);
  const failed = await writes(ws, ws.gatekeeperId);
  expect(failed.map(write => write.state)).toEqual(["approved", "approved", "pending", "pending"]);
  expect(failed[2].applyError).toEqual({ message: "Three is locked.", retryable: true });

  await control("apply-limit", { label: ws.label, limit: null });
  await ws.overseer.approveAction(ids[3]);
  expect((await applyLists(ws.label)).at(-1)).toEqual({ branch: null, actions: [3, 4] });
  const applied = await writes(ws, ws.gatekeeperId);
  expect(applied.map(write => [write.state, write.applyError])).toEqual(
      [["approved", undefined], ["approved", undefined], ["approved", undefined], ["approved", undefined]]);
  expect(await actionState(ws.label)).toEqual({ pending: [], value: 4, applyCount: 4 });
});

it.concurrent("rejects what a denial reports rejected with it, so the retry carries on", async () => {
  using ws = await newWorkspace("branches");
  using session = await ws.openSession();
  await session.setApplyMode("branches");
  for (const value of [1, 2, 3]) await session.writeValue(value);
  const ids = (await writes(ws, ws.gatekeeperId)).map(write => write.id);

  await control("fail-list", { label: ws.label, action: 1, message: "One is gone.", retryable: false });
  await expect(ws.overseer.approveAction(ids[2])).rejects.toThrow("One is gone.");
  await control("reject-also", { label: ws.label, actions: [2] });
  await ws.overseer.rejectAction(ids[0]);
  expect((await writes(ws, ws.gatekeeperId)).map(write => write.state))
      .toEqual(["rejected", "rejected", "pending"]);

  await ws.overseer.approveAction(ids[2]);
  expect((await applyLists(ws.label)).at(-1)).toEqual({ branch: null, actions: [3] });
  expect(await actionState(ws.label)).toEqual({ pending: [], value: 3, applyCount: 1 });
});

it.concurrent("settles a lost submitAction() reply and a lost apply result", async () => {
  using ws = await newWorkspace("branches");
  using session = await ws.openSession();
  await session.setApplyMode("branches");
  const forgotten = await session.writeValue(1, { forget: true });
  await session.writeValue(2);
  // The Workshop holds the action the gatekeeper forgot, until an apply shows it was not kept.
  await expect(session.holdsAction(forgotten)).resolves.toBe(true);
  let ids = (await writes(ws, ws.gatekeeperId)).map(write => write.id);
  await ws.overseer.approveAction(ids[1]);

  // An apply whose result is lost, then a later one that finds its action gone: applied.
  const lost = await session.writeValue(3);
  await control("lose-next-list", { label: ws.label });
  ids = (await writes(ws, ws.gatekeeperId)).map(write => write.id);
  await expect(ws.overseer.approveAction(ids[2])).rejects.toThrow("lost this apply's result");
  await session.writeValue(4);
  ids = (await writes(ws, ws.gatekeeperId)).map(write => write.id);
  await ws.overseer.approveAction(ids[3]);

  expect(await applyLists(ws.label)).toEqual([
    { branch: null, actions: [1, 2] }, { branch: null, actions: [3] },
    { branch: null, actions: [3, 4] },
  ]);
  const settled = await writes(ws, ws.gatekeeperId);
  expect(settled.map(write => write.state)).toEqual(["rejected", "approved", "approved", "approved"]);
  expect(settled[0].applyError?.retryable).toBe(false);
  await expect(session.holdsAction(forgotten)).resolves.toBe(false);
  await expect(session.holdsAction(lost)).resolves.toBe(false);
  expect(await actionState(ws.label)).toEqual({ pending: [], value: 4, applyCount: 3 });
});

it.concurrent("applies leftovers by name, first, once the gatekeeper adopts branches", async () => {
  using ws = await newWorkspace("branches");
  using before = await ws.openSession();
  await before.writeValue(1);
  await before.writeValue(2);
  await before.setApplyMode("branches");
  // A gatekeeper adopts branches by being upgraded, which starts every session anew.
  using after = await ws.openSession();
  await after.writeValue(3);
  const ids = (await writes(ws, ws.gatekeeperId)).map(write => write.id);

  // applyAction() refuses now, so all three go through the list.
  await ws.overseer.approveAction(ids[2]);
  expect(await applyLists(ws.label)).toEqual([{ branch: null, actions: [1, 2, 3] }]);
  expect(await actionState(ws.label)).toEqual({ pending: [], value: 3, applyCount: 3 });
});

it.concurrent("approving a chat's action applies staging first, in one list read through the chat",
    async () => {
  const executeCode = (id: string, code: string) =>
    ({ toolCall: { id, name: "executeCode", arguments: {
      code: `export default async function(self, env) { console.log(await ${code}); }`,
    } } });
  const model = models.script([
    executeCode("read", "env.TEST_AMBIENT.readValue()"), { text: "Read." },
    executeCode("write", "env.TEST_AMBIENT.writeValue(7)"), { text: "Written." },
  ]);
  await using agent = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "branchchat",
  });
  const label = accountLabel(agent.connectedAccount(TEST_VENDOR_ID));

  // The first turn's read names the ambient connection, which a user's session then switches to
  // applying lists before the chat writes through it.
  await agent.runTurn("Read the test value.");
  await withOwnerWorkspace(harness.url, agent.username, async overseer => {
    const { entries } = await overseer.listActions({ filter: "observation" });
    const gatekeeperId = entries[0].gatekeeperId!;
    using connection = await overseer.getGatekeeperById(gatekeeperId);
    using staging = await connection.openSession() as RpcStub<TestSession>;
    await staging.setApplyMode("branches");

    await agent.runTurn("Set the test value to 7.");
    await staging.writeValue(8);  // staged after the chat's write
    const [chatWrite, stagedWrite] = await writes({ overseer }, gatekeeperId);
    expect([chatWrite.chatId, stagedWrite.chatId]).toEqual([expect.any(Number), undefined]);

    await overseer.approveAction(chatWrite.id);
    expect(await applyLists(label)).toEqual([{ branch: `chat:${chatWrite.chatId}`, actions: [2, 1] }]);
    expect(await actionState(label)).toEqual({ pending: [], value: 7, applyCount: 2 });
    await waitFor("the resumed turn to finish", async () =>
      model.remainingSteps() === 0 && !(await overseer.listChats())[0]?.activeAgent || null);
  });
});
