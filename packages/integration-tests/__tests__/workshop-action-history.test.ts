import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import {
  actionChangeTime, type ActionHistoryFilter, type ActionLogEntry, type ActionsSubscriber,
  type Overseer,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

class ActionRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  readonly #ready = Promise.withResolvers<void>();
  readonly loaded = this.#ready.promise;
  entry(record: ActionLogEntry) { this.entries.push(record); }
  ready() { this.#ready.resolve(); }
}

async function listAll(ws: RpcStub<Overseer>, filter: ActionHistoryFilter, beforeId?: number) {
  const entries: ActionLogEntry[] = [];
  let pages = 0;
  do {
    const page = await ws.listActions({ filter, beforeId });
    entries.push(...page.entries);
    beforeId = page.nextBeforeId;
    pages++;
  } while (beforeId !== undefined);
  return { entries, pages };
}

async function approveWrite(ws: RpcStub<Overseer>, value: number): Promise<number> {
  const { entries } = await listAll(ws, "pending");
  const write = entries.find(e => e.description.title === `Set the test value to ${value}`);
  if (!write) throw new Error(`No pending write of ${value}`);
  await ws.approveAction(write.id);
  return write.id;
}

async function writeValues(session: RpcStub<TestSession>, from: number, to: number) {
  // Sequential, so action ids follow the values.
  for (let value = from; value < to; value++) await session.writeValue(value);
}

const ids = (entries: ActionLogEntry[]) => entries.map(e => e.id);
const idsDown = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => from - i);

it("pages, filters, streams and replays a workspace's action history", async () => {
  const [owner] = nextUsernames("historyowner");
  let workspaceId: string;
  let gatekeeperId: number;
  let watermark: Date;

  {
    using publicApi = connect(harness.url);
    using api = await signUp(publicApi, owner);
    await api.provisionAmbientAccount(TEST_VENDOR_ID);
    const account = await waitFor("the test account", async () =>
      (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
    using ws = await api.newGadget();
    workspaceId = (await ws.getMetadata()).id;
    using gatekeeper = await ws.newGatekeeper(
        account.id, "https://gadgets-test.example/things/action-history");
    if (!gatekeeper) throw new Error("Failed to create the test connection");
    gatekeeperId = await gatekeeper.getId();
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    await writeValues(session, 1000, 1055);

    const live = new ActionRecorder();
    using liveStub = stubFor(live);
    using _subscription = await ws.subscribeToActions(liveStub);
    await live.loaded;
    expect(live.entries).toEqual([]);
    await session.readValue();
    await waitFor("the live observation", async () => live.entries[0] ?? null);
    expect(live.entries).toMatchObject([{ id: 55, type: "observation" }]);

    const firstPending = await ws.listActions({ filter: "pending" });
    expect(firstPending.nextBeforeId).toBeDefined();
    const approvedId = await approveWrite(ws, 1000);
    const approved = await waitFor("the live approval", async () =>
      live.entries.find(e => e.id === approvedId && e.state === "approved") ?? null);
    const restPending = await listAll(ws, "pending", firstPending.nextBeforeId);
    expect(ids([...firstPending.entries, ...restPending.entries])).toEqual(idsDown(54, 1));

    const [all, actions, observations, pending] = await Promise.all(
        (["all", "action", "observation", "pending"] as const).map(filter => listAll(ws, filter)));
    expect(ids(all.entries)).toEqual(idsDown(55, 0));
    expect(all.pages).toBeGreaterThan(1);
    expect(ids([...observations.entries, ...actions.entries])).toEqual(ids(all.entries));
    expect(observations.entries).toMatchObject(
        [{ state: "approved", description: { title: "Read the test value" } }]);
    expect(actions.entries.map(e => e.state)).toEqual([...Array(54).fill("pending"), "approved"]);
    expect(pending.entries).toEqual(actions.entries.filter(e => e.state === "pending"));

    watermark = actionChangeTime(approved);
  }

  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, owner);
  using ws = await api.openGadget(workspaceId);
  using gatekeeper = await ws.getGatekeeperById(gatekeeperId);
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  await writeValues(session, 1055, 1058);
  await approveWrite(ws, 1001);

  const replay = new ActionRecorder();
  using replayStub = stubFor(replay);
  const subscribing = ws.subscribeToActions(replayStub, watermark);
  const { entries } = await listAll(ws, "all");
  using _subscription = await subscribing;
  await replay.loaded;

  const replayed = new Map(replay.entries.map(e => [e.id, e]));
  expect(replayed.size).toBe(replay.entries.length);
  expect(replayed).toEqual(new Map(entries
      .filter(e => actionChangeTime(e) >= watermark)
      .map(e => [e.id, e])));
  expect([...replayed.keys()]).toEqual(expect.arrayContaining([0, 1, 56, 57, 58]));
  // Unchanged since long before the watermark; also fails if approval stops stamping appliedAt.
  expect(replayed.has(2)).toBe(false);
  const times = replay.entries.map(e => actionChangeTime(e).getTime());
  expect(times).toEqual(times.toSorted((a, b) => a - b));
});
