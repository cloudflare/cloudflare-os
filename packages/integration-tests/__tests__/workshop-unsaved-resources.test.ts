// Unsaved resources (plans/forking-reality.md, part 2): accepting a chat's changes to a resource
// it created moves them to staging, where every session sees them, and saving the resource
// applies them. Driven through the fixture's KitTestGatekeeper, which simulates a thing named
// `kit-...` by view and stages through gatekeeper-kit (Gatekeeper.stageActions()).

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { ActionLogEntry, Overseer } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, waitFor, withOwnerWorkspace,
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

type Action = ActionLogEntry & { type: "action" };

/**
 * An agent in Review that creates a kit thing and writes each of `values` to it, in one call
 * each: the creation and the writes are left pending on its chat.
 */
async function createAndWrite(usernamePrefix: string, values: number[]) {
  const title = `kit-${crypto.randomUUID()}`;
  const model = models.script([
    { toolCall: { id: "create", name: "createExternalResource", arguments: {
      vendorId: TEST_VENDOR_ID, resourceTypeId: "thing", title, bindingName: "NOTES",
    } } },
    ...values.map((value, i) => ({ toolCall: { id: `write-${i}`, name: "executeCode", arguments: {
      code: `export default async function(self, env) { await env.NOTES.writeValue(${value}); }`,
    } } })),
    { text: "Written." },
  ]);
  const session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, mode: "review", userModel: model.userModel, usernamePrefix,
  });
  expect((await session.runTurn("Create a thing and write to it.")).outcome)
      .toEqual({ status: "completed" });
  const [creation, ...writes] = await pendingActions(session, values.length + 1);
  expect(creation).toMatchObject({ creation: true });
  return {
    session, creation: creation!, writes,
    resourceUrl: `https://gadgets-test.example/things/${title}`,
  };
}

async function pendingActions(session: WorkshopAgentSession, count: number): Promise<Action[]> {
  return waitFor(`${count} pending actions`, async () => {
    const { entries } = await session.listActions({ filter: "pending" });
    const actions = entries.filter((entry): entry is Action => entry.type === "action");
    return actions.length === count ? actions.toSorted((a, b) => a.id - b.id) : null;
  });
}

async function entry(ws: RpcStub<Overseer>, id: number): Promise<Action> {
  const { entries } = await ws.listActions({ filter: "action" });
  return entries.find((found): found is Action => found.id === id && found.type === "action")!;
}

/** What a session outside any chat reads from the connection: its view is staging's. */
async function stagedValue(ws: RpcStub<Overseer>, gatekeeperId: number): Promise<number> {
  using gatekeeper = await ws.getGatekeeperById(gatekeeperId);
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  return await session.readValue();
}

const stageLists = async (resourceUrl: string) =>
  (await testControl<{ lists: { branch: string | null; actions: number[] }[] }>(
      harness, "stage-lists", { resourceUrl })).lists;

/** Saves the resource `creation` made into an account of `username`'s, returning its label. */
async function save(username: string, ws: RpcStub<Overseer>, creation: Action): Promise<string> {
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, username);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  await ws.approveAction(creation.id, { accountId: account.id });
  return accountLabel(account);
}

it.concurrent("stages what an accept took, which every session sees, and applies it on saving",
    async () => {
  const { session, creation, writes: [first, second], resourceUrl } =
      await createAndWrite("unsavedaccept", [7, 8]);
  await using _session = session;
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const gatekeeperId = creation.gatekeeperId!;
    const chatId = (await ws.listChats())[0]!.id;
    expect(await stagedValue(ws, gatekeeperId)).toBe(0);

    // Accepting up to the first write moves the creation and that write, and leaves the second.
    expect(await ws.mergeChanges(chatId, { through: first!.id })).toEqual({ outcome: "merged" });
    expect(await stageLists(resourceUrl)).toEqual([{ branch: `chat:${chatId}`, actions: [1] }]);
    expect(await stagedValue(ws, gatekeeperId)).toBe(7);
    expect(await entry(ws, first!.id)).toMatchObject(
        { state: "pending", accepted: { autoApproved: false } });
    expect((await entry(ws, second!.id)).accepted).toBeUndefined();
    expect((await ws.listChats()).find(chat => chat.id === chatId)?.pendingActions).toBe(1);
    expect((await ws.getMetadata()).stagedActions).toBeUndefined();

    const label = await save(session.username, ws, creation);
    expect(await testActionState(harness, label)).toEqual({ pending: [], value: 7, applyCount: 1 });
    expect(await entry(ws, first!.id)).toMatchObject({ state: "approved", autoApproved: false });

    // Saved, the chat's remaining write applies when it is accepted, as any does.
    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    expect(await testActionState(harness, label)).toEqual({ pending: [], value: 8, applyCount: 2 });
  });
});

it.concurrent.each([
  ["before", "fail"],
  ["after", "lose"],
] as const)("tells the gatekeeper again, before the next session, after a throw %s its write",
    async (_, how) => {
  const { session, creation, writes: [write], resourceUrl } =
      await createAndWrite(`unsaved${how}`, [7]);
  await using _session = session;
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const chatId = (await ws.listChats())[0]!.id;
    await testControl(harness, "fail-next-stage", { resourceUrl, how });
    await expect(ws.mergeChanges(chatId)).rejects.toThrow();
    // Still on the chat's branch.
    expect((await entry(ws, write!.id)).accepted).toBeUndefined();
    expect((await ws.listChats()).find(chat => chat.id === chatId)?.pendingActions).toBe(2);

    // The next session's start repeats the call, which brings the two into agreement.
    expect(await stagedValue(ws, creation.gatekeeperId!)).toBe(7);
    const call = { branch: `chat:${chatId}`, actions: [1] };
    expect(await stageLists(resourceUrl)).toEqual([call, call]);
    expect(await entry(ws, write!.id)).toMatchObject({ accepted: { autoApproved: false } });
    expect((await ws.listChats()).find(chat => chat.id === chatId)?.pendingActions).toBeUndefined();
  });
});

it.concurrent("replays in ID order a chat's action accepted after a later staged one", async () => {
  const { session, creation, writes: [write] } = await createAndWrite("unsavedorder", [7]);
  await using _session = session;
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const gatekeeperId = creation.gatekeeperId!;
    const chatId = (await ws.listChats())[0]!.id;
    // A session outside any chat writes after the agent did: staged, and accepted at once.
    {
      using gatekeeper = await ws.getGatekeeperById(gatekeeperId);
      using staged = await gatekeeper.openSession() as RpcStub<TestSession>;
      await staged.writeValue(9);
    }
    const [, , later] = await pendingActions(session, 3);
    await waitFor("the staged write to be accepted", async () =>
      (await entry(ws, later!.id)).accepted ?? null);
    expect(later!.id).toBeGreaterThan(write!.id);

    // Accepted after it, the chat's write still replays first.
    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    expect(await stagedValue(ws, gatekeeperId)).toBe(9);

    const label = await save(session.username, ws, creation);
    expect(await testActionState(harness, label)).toEqual({ pending: [], value: 9, applyCount: 2 });
    expect([await entry(ws, write!.id), await entry(ws, later!.id)]).toMatchObject([
      { state: "approved", autoApproved: false }, { state: "approved", autoApproved: true },
    ]);
  });
});
