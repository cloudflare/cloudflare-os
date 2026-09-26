// `excludeObservers` blocks an observation only for a current collaborator whose role's
// verification scope covers the producing connection.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi, CollaboratorRole, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
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

const BLOCKED = "This observation was blocked because it contains data that a current " +
    "collaborator is not permitted to see.";

const thingUrl = (name: string) => `https://gadgets-test.example/things/${name}`;

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  return await body(publicApi);
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

type Workspace = Disposable & {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
  alice: string;
  session: RpcStub<TestSession>;
  gatekeeperId: number;
  account: ConnectedAccount;
};

async function newWorkspace(publicApi: RpcStub<PublicApi>, thingName: string): Promise<Workspace> {
  const [alice] = nextUsernames("alice");
  const aliceApi = await signUp(publicApi, alice);
  const account = await provisionAccount(aliceApi);
  const overseer = await aliceApi.newGadget();
  using gatekeeper = await overseer.newGatekeeper(account.id, thingUrl(thingName));
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const gatekeeperId = await gatekeeper.getId();
  const session = await gatekeeper.openSession() as RpcStub<TestSession>;
  const { id: gadgetId } = await overseer.getMetadata();
  return {
    gadgetId, overseer, alice, session, gatekeeperId, account,
    [Symbol.dispose]() {
      for (const stub of [session, overseer, aliceApi]) stub[Symbol.dispose]();
    },
  };
}

// The restart fells every client of the workspace, so reconnect on a fresh connection.
async function reopenAfterRestart(ws: Workspace) {
  await waitFor("the restart to fell the old workspace instance", () =>
    ws.session.readValue().then(() => null, () => true));
  return waitFor("the workspace to come back after the restart", async () => {
    const publicApi = connect(harness.url);
    try {
      using api = await logIn(publicApi, ws.alice);
      using overseer = await api.openGadget(ws.gadgetId);
      using gatekeeper = await overseer.getGatekeeperById(ws.gatekeeperId);
      const session = await gatekeeper.openSession() as RpcStub<TestSession>;
      await session.readValue();
      return { session, [Symbol.dispose]: () => publicApi[Symbol.dispose]() };
    } catch {
      publicApi[Symbol.dispose]();
      return null;
    }
  });
}

type ObserverEvent = { resourceUrl: string; type: "add" | "remove"; id: string };

/** The addObserver()/removeObserver() calls one binding's gatekeeper has seen, in order. */
async function observerEvents(resourceUrl: string): Promise<ObserverEvent[]> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/observer-events",
    { method: "POST", body: JSON.stringify({ resourceUrl }) });
  if (res.status !== 200) {
    throw new Error(`Reading observer events failed with ${res.status}: ${await res.text()}`);
  }
  return (await res.json() as { events: ObserverEvent[] }).events;
}

/**
 * Share the workspace with a fresh collaborator and verify them at open. Their observer id is the
 * one addObserver() their open produced at `resourceUrl` (the owner is never registered).
 */
async function verifiedCollaborator(
    publicApi: RpcStub<PublicApi>, ws: Workspace, role: CollaboratorRole, resourceUrl: string) {
  const [name] = nextUsernames(role === "build" ? "bob" : "carol");
  using api = await signUp(publicApi, name);
  const account = await provisionAccount(api);
  const added = await ws.overseer.addCollaborator(name, role);
  if (!added) throw new Error(`Failed to share the workspace with ${name}`);
  const before = await observerEvents(resourceUrl);
  const callback =
      stubFor(new ObserverConfigRecorder().alwaysChoose(account.id, MAX_OBSERVER_PROMPTS));
  using _ws = await api.openGadget(ws.gadgetId, undefined, callback)
      .finally(() => callback[Symbol.dispose]());
  const events = (await observerEvents(resourceUrl)).slice(before.length);
  expect(events).toMatchObject([{ type: "add" }]);
  return { profileId: added.profile.id, observerId: events[0]!.id };
}

it("an excluded build collaborator blocks the observation until removed", async () => {
  await withSession(async publicApi => {
    using ws = await newWorkspace(publicApi, "exclude-build");
    const url = thingUrl("exclude-build");
    const bob = await verifiedCollaborator(publicApi, ws, "build", url);

    await expect(ws.session.readValue(true, true, [bob.observerId])).rejects.toThrow(BLOCKED);
    expect((await ws.overseer.listActions({ filter: "observation" })).entries).toEqual([]);
    const metadata = await ws.overseer.getMetadata();
    expect(metadata.containsRestrictedData).toBeFalsy();
    expect(metadata.ownerInvitesOnly).toBeFalsy();
    expect(await observerEvents(url)).toEqual([{ resourceUrl: url, type: "add", id: bob.observerId }]);

    await ws.overseer.removeCollaborator(bob.profileId, []);
    using reopened = await reopenAfterRestart(ws);
    await expect(reopened.session.readValue(false, false, [bob.observerId])).resolves.toBe(42);
  });
});

it("a use collaborator blocks only observations from connections in their scope", async () => {
  await withSession(async publicApi => {
    using ws = await newWorkspace(publicApi, "exclude-use-unbound");
    const unboundUrl = thingUrl("exclude-use-unbound");
    const boundUrl = thingUrl("exclude-use-bound");
    // Bound before sharing, so the widening restarts nothing.
    using bound = await ws.overseer.newGatekeeper(ws.account.id, boundUrl);
    if (!bound) throw new Error("Failed to create the bound connection");
    using gadget = await ws.overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
    await gadget.bind("TEST_THING", await bound.getId());
    using boundSession = await bound.openSession() as RpcStub<TestSession>;
    const carol = await verifiedCollaborator(publicApi, ws, "use", boundUrl);

    await expect(ws.session.readValue(false, false, [carol.observerId])).resolves.toBe(42);
    expect(await observerEvents(unboundUrl))
        .toEqual([{ resourceUrl: unboundUrl, type: "remove", id: carol.observerId }]);
    await expect(boundSession.readValue(false, false, [carol.observerId])).rejects.toThrow(BLOCKED);
  });
});
