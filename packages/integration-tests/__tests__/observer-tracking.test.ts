// Kernel-checked observer subresources (docs/observers.md §10), against the fixture gatekeeper. A
// binding reports each read's `subresources` on `authorizeObservation()` once
// `/control/report-subresources` says so, and its `verifyObserverAccess()` asks each observer's
// verifier for the outcomes `/control/verify-outcome` sets per subresource. Admission is additive:
// every collaborator must pass every connection's `addObserver()` and the kernel's check of what
// was reported.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi, CollaboratorGrant, GadgetClient, Overseer, PublicApi, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, restartWorkspace, signUp, stubFor, waitFor, WorkpieceRecorder,
  type ConnectedAccount, RpcTarget,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

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

/** The Workshop's refusal at admission, for a reported subresource the account can't read. */
const DENIED =
    "This account can't access some of the data this workspace read through this service.";
/** The Workshop's refusal of a read, for a reported subresource a collaborator can't read. */
const READ_REFUSED = "blocked because it contains data that a current collaborator";

/** A resource URL no other test (or earlier run against the same storage) has used. */
function freshThingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}-${crypto.randomUUID().slice(0, 8)}`;
}

function reportSubresources(resourceUrl: string): Promise<void> {
  return testControl(harness, "report-subresources", { resourceUrl });
}

/** Refuse (or re-admit) `label` for one subresource of the binding at `resourceUrl`. */
function setSubresourceAccess(
    label: string, resourceUrl: string, subresource: string, allow: boolean): Promise<void> {
  return testControl(harness, "verify-outcome",
      { label, resourceUrl, subresource, allow, reason: "The test refused this subresource." });
}

type ObserverEvent = { resourceUrl: string; type: "add" | "remove"; id: string };

async function observerEvents(resourceUrl: string): Promise<ObserverEvent[]> {
  return (await testControl<{ events: ObserverEvent[] }>(harness, "observer-events", { resourceUrl }))
    .events;
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

type Workspace = Disposable & {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
  account: ConnectedAccount;
};

async function newWorkspace(publicApi: RpcStub<PublicApi>): Promise<Workspace> {
  const [alice] = nextUsernames("trackalice");
  const api = await signUp(publicApi, alice);
  const account = await provisionAccount(api);
  const overseer = await api.newWorkspace();
  const { id: gadgetId } = await overseer.getMetadata();
  return {
    gadgetId, overseer, account,
    [Symbol.dispose]() {
      overseer[Symbol.dispose]();
      api[Symbol.dispose]();
    },
  };
}

/** Connect `resourceUrl` in the owner's workspace and read it once, depending on `subresources`. */
async function connectAndRead(ws: Workspace, resourceUrl: string, subresources: string[])
    : Promise<number> {
  using gatekeeper = await ws.overseer.newGatekeeper(ws.account.id, resourceUrl);
  if (!gatekeeper) throw new Error(`Failed to connect ${resourceUrl}`);
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  await expect(session.readValue(false, false, undefined, subresources)).resolves.toBe(42);
  return gatekeeper.getId();
}

type Collaborator = Disposable & {
  name: string;
  profileId: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  label: string;
};

/**
 * Share `grant` with a fresh collaborator, with an account of their own. They get their own
 * connection, which a restart of the owner's workspace doesn't sever.
 */
async function addCollaborator(ws: Workspace, grant: CollaboratorGrant = "build")
    : Promise<Collaborator> {
  const [bob] = nextUsernames("trackbob");
  const connection = connect(harness.url);
  const api = await signUp(connection, bob);
  const account = await provisionAccount(api);
  const added = await ws.overseer.addCollaborator(bob, grant);
  if (!added) throw new Error(`Failed to share the workspace with ${bob}`);
  return {
    name: bob, profileId: added.profile.id, api, account, label: accountLabel(account),
    [Symbol.dispose]() {
      api[Symbol.dispose]();
      connection[Symbol.dispose]();
    },
  };
}

/**
 * The collaborator opens the workspace, and gets `gadgetId` when given -- where a collaborator
 * granted individual gadgets is verified -- choosing their account at every prompt.
 */
async function collaboratorOpens(bob: Collaborator, workspaceId: string, gadgetId?: WorkpieceId)
    : Promise<{ recorder: ObserverConfigRecorder; error?: Error }> {
  const recorder = new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS);
  const callback = stubFor(recorder);
  try {
    using opened = await bob.api.openWorkspace(workspaceId, undefined, callback);
    if (gadgetId !== undefined) (await opened.getGadget(gadgetId, callback))[Symbol.dispose]();
    return { recorder };
  } catch (error) {
    return { recorder, error: error as Error };
  } finally {
    callback[Symbol.dispose]();
  }
}

it.concurrent("a binding reporting subresources from creation checks reads and admission against them",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("reporting");
  const legacyUrl = freshThingUrl("reporting-legacy");
  await reportSubresources(url);
  using reporting = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!reporting) throw new Error(`Failed to connect ${url}`);
  const reportingId = await reporting.getId();
  using session = await reporting.openSession() as RpcStub<TestSession>;
  await expect(session.readValue(false, false, undefined, ["doc-1"])).resolves.toBe(42);
  await connectAndRead(ws, legacyUrl, []);
  using bob = await addCollaborator(ws);

  const first = await collaboratorOpens(bob, ws.gadgetId);
  expect(first.error).toBeUndefined();
  // The reporting connection is asked about under the same connection ID used by its binding.
  expect(first.recorder.calls[0]!.map(need => need.gatekeeperId)).toContain(reportingId);
  // Admission is additive: both connections' addObserver() admitted him.
  expect(await observerEvents(url)).toMatchObject([{ type: "add" }]);
  expect(await observerEvents(legacyUrl)).toMatchObject([{ type: "add" }]);

  // Bob is now a current collaborator, so a read depending on what he can't access is refused...
  await setSubresourceAccess(bob.label, url, "secret-2", false);
  await expect(session.readValue(false, false, undefined, ["secret-2"]))
      .rejects.toThrow(READ_REFUSED);
  // ...while one he can access goes through.
  await expect(session.readValue(false, false, undefined, ["doc-1"])).resolves.toBe(42);
  // The refused read recorded nothing, so it doesn't refuse him at his next open.
  expect((await collaboratorOpens(bob, ws.gadgetId)).error).toBeUndefined();

  // Losing access to a recorded requirement refuses him at open, naming only that connection.
  await setSubresourceAccess(bob.label, url, "doc-1", false);
  const refused = await collaboratorOpens(bob, ws.gadgetId);
  expect(refused.error?.message).toContain(DENIED);
  expect(refused.error?.message).toContain(bob.label);
  // His persisted choices are re-verified first, so the opening prompt carries the failure.
  const failed = refused.recorder.calls[0]!.filter(need => need.failure);
  expect(failed).toEqual([expect.objectContaining({ gatekeeperId: reportingId })]);
  expect(failed[0]!.failure!.reason).toContain(DENIED);

  // A collaborator who can read everything recorded is admitted.
  using carol = await addCollaborator(ws);
  expect((await collaboratorOpens(carol, ws.gadgetId)).error).toBeUndefined();
});

it.concurrent("the same local subresource ID is checked independently in different resources",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const firstUrl = freshThingUrl("scope-first");
  const secondUrl = freshThingUrl("scope-second");
  const localId = 'same/local#id:"雪"';
  await reportSubresources(firstUrl);
  await reportSubresources(secondUrl);
  const firstId = await connectAndRead(ws, firstUrl, [localId]);
  const secondId = await connectAndRead(ws, secondUrl, [localId]);
  using bob = await addCollaborator(ws);
  expect((await collaboratorOpens(bob, ws.gadgetId)).error).toBeUndefined();

  await setSubresourceAccess(bob.label, firstUrl, localId, false);
  const firstDenied = await collaboratorOpens(bob, ws.gadgetId);
  expect(firstDenied.error?.message).toContain(DENIED);
  expect(firstDenied.recorder.calls[0]!.filter(need => need.failure)).toEqual([
    expect.objectContaining({ gatekeeperId: firstId, resourceUrl: firstUrl }),
  ]);

  await setSubresourceAccess(bob.label, firstUrl, localId, true);
  await setSubresourceAccess(bob.label, secondUrl, localId, false);
  const secondDenied = await collaboratorOpens(bob, ws.gadgetId);
  expect(secondDenied.error?.message).toContain(DENIED);
  expect(secondDenied.recorder.calls[0]!.filter(need => need.failure)).toEqual([
    expect.objectContaining({ gatekeeperId: secondId, resourceUrl: secondUrl }),
  ]);

  await setSubresourceAccess(bob.label, secondUrl, localId, true);
  expect((await collaboratorOpens(bob, ws.gadgetId)).error).toBeUndefined();
});

it.concurrent("addObserver() still refuses a collaborator of a binding that reports subresources",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("baseline");
  await reportSubresources(url);
  // `[]`: nothing restricts the read, so nothing is recorded for the Workshop to check.
  const connectionId = await connectAndRead(ws, url, []);
  using bob = await addCollaborator(ws);
  const reason = "The test refused this account at this binding.";
  await testControl(harness, "verify-outcome",
      { label: bob.label, resourceUrl: url, allow: false, reason });

  const refused = await collaboratorOpens(bob, ws.gadgetId);
  expect(refused.error?.message).toContain(reason);
  expect(refused.recorder.calls.at(-1)!.filter(need => need.failure)).toEqual([
    expect.objectContaining({ gatekeeperId: connectionId }),
  ]);

  await testControl(harness, "verify-outcome", { label: bob.label, resourceUrl: url, allow: true });
  expect((await collaboratorOpens(bob, ws.gadgetId)).error).toBeUndefined();
});

it.concurrent("disconnect drops reported permission checks but keeps the observation audit",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("removed");
  await reportSubresources(url);
  const connectionId = await connectAndRead(ws, url, ["kept-1"]);
  using bob = await addCollaborator(ws);
  const audit = await ws.overseer.listActions({ filter: "observation" });
  expect(audit.entries).toMatchObject([
    { description: { title: "Read the test value" } },
  ]);
  await setSubresourceAccess(bob.label, url, "kept-1", false);
  expect((await collaboratorOpens(bob, ws.gadgetId)).error?.message).toContain(DENIED);

  {
    using gatekeeper = await ws.overseer.getGatekeeperById(connectionId);
    await gatekeeper.remove();
  }
  expect(await ws.overseer.listActions({ filter: "observation" })).toEqual(audit);
  const afterDisconnect = await collaboratorOpens(bob, ws.gadgetId);
  expect(afterDisconnect.error).toBeUndefined();
  expect(afterDisconnect.recorder.calls).toEqual([]);
  let restarted = false;
  ws.overseer.onRpcBroken(() => { restarted = true; });
  await restartWorkspace(harness.url, ws.overseer);
  await waitFor("the workspace restart", async () => restarted || null);

  // The denied resource is still denied at the vendor, but no longer belongs to this workspace.
  const afterRestart = await collaboratorOpens(bob, ws.gadgetId);
  expect(afterRestart.error).toBeUndefined();
  expect(afterRestart.recorder.calls).toEqual([]);
});

// Author a new gadget's server code through the same human-only edit/merge API as the code editor.
async function installServer(ws: Workspace, gadgetId: WorkpieceId, server: string): Promise<void> {
  const workpieces = new WorkpieceRecorder();
  using subscriber = stubFor(workpieces);
  using _subscription = await ws.overseer.subscribeToWorkpieces(subscriber);
  await workpieces.loaded;
  const summary = workpieces.summaries.get(gadgetId);
  if (summary?.type !== "gadget" || summary.commitId === undefined) {
    throw new Error("The new gadget has no committed head");
  }
  const chatId = await ws.overseer.newChat("Implement the server", null);
  await ws.overseer.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "observer-subresources", seq: 1,
    pins: [{ gadgetId, baseCommit: summary.commitId }],
    change: diffFiles(new Map(), new Map([[gadgetId, new Map([["server.js", server]])]])),
  });
  expect(await ws.overseer.mergeChanges(chatId)).toEqual({ outcome: "merged" });
}

interface ReadingGadget extends RpcTarget {
  read(subresource: string): Promise<{ value: number; subresource: string }>;
}

const READING_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async read(subresource) {
    const value = await this.env.THING.readValue(false, false, undefined, [subresource]);
    return { value, subresource };
  }
}`;

/** A permanent reading gadget using the connection under the fixture's THING binding. */
async function newReadingGadget(
    ws: Workspace, connectionId: number, title: string, bindingName: string)
    : Promise<RpcStub<GadgetClient>> {
  using stack = new DisposableStack();
  const gadget = stack.use(await ws.overseer.createGadget(title, undefined, bindingName));
  const gadgetId = await gadget.getId();
  await gadget.bind("THING", connectionId);
  await installServer(ws, gadgetId, READING_SERVER);
  stack.move();
  return gadget;
}

it.concurrent("a gadget's reported reads enforce use collaborator admission and live access",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("gadget-reporting");
  await reportSubresources(url);
  using reporting = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!reporting) throw new Error("Failed to create the reporting connection");
  const connectionId = await reporting.getId();
  using gadget = await ws.overseer.createGadget("Reading Gadget", undefined, "READING_GADGET");
  const gadgetId = await gadget.getId();
  await gadget.bind("THING", connectionId);
  await installServer(ws, gadgetId, READING_SERVER);

  using facet = await gadget.connectToGadget() as RpcStub<ReadingGadget>;
  await expect(facet.read("gadget-1")).resolves.toEqual({ value: 42, subresource: "gadget-1" });
  using viewer = await addCollaborator(ws, { gadgetId });
  await setSubresourceAccess(viewer.label, url, "gadget-1", false);
  const refused = await collaboratorOpens(viewer, ws.gadgetId, gadgetId);
  expect(refused.error?.message).toContain(DENIED);
  expect(refused.recorder.calls[0]).toContainEqual(expect.objectContaining({
    gatekeeperId: connectionId, resourceUrl: url,
  }));

  await setSubresourceAccess(viewer.label, url, "gadget-1", true);
  const recorder = new ObserverConfigRecorder().alwaysChoose(viewer.account.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  using viewerWorkspace = await viewer.api.openWorkspace(ws.gadgetId, undefined, callback);
  using viewerGadget = await viewerWorkspace.getGadget(gadgetId, callback);
  using viewerFacet = await viewerGadget.connectToGadget() as RpcStub<ReadingGadget>;
  await expect(viewerFacet.read("gadget-1"))
      .resolves.toEqual({ value: 42, subresource: "gadget-1" });

  // A new subresource is checked before the binding can return its value to gadget code.
  await setSubresourceAccess(viewer.label, url, "live-2", false);
  await expect(viewerFacet.read("live-2")).rejects.toThrow(READ_REFUSED);
  // A refused read did not add the inaccessible ID to the gadget's admission history.
  expect((await collaboratorOpens(viewer, ws.gadgetId, gadgetId)).error).toBeUndefined();
  await setSubresourceAccess(viewer.label, url, "live-2", true);
  await expect(viewerFacet.read("live-2")).resolves.toEqual({ value: 42, subresource: "live-2" });

  // The successful live read joined gadget history, so revocation also denies the next admission.
  await setSubresourceAccess(viewer.label, url, "live-2", false);
  expect((await collaboratorOpens(viewer, ws.gadgetId, gadgetId)).error?.message)
      .toContain(DENIED);
  expect(await observerEvents(url)).toContainEqual(expect.objectContaining({ type: "add" }));
});

it.concurrent("a collaborator granted one gadget is listed, verified, and revoked for it alone",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("one-gadget");
  await reportSubresources(url);
  using reporting = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!reporting) throw new Error("Failed to create the reporting connection");
  const connectionId = await reporting.getId();
  using gadgetA = await newReadingGadget(ws, connectionId, "Gadget A", "GADGET_A");
  using gadgetB = await newReadingGadget(ws, connectionId, "Gadget B", "GADGET_B");
  const a = await gadgetA.getId();
  const b = await gadgetB.getId();
  // Both gadgets read through the same connection, each a subresource of its own.
  using ownerA = await gadgetA.connectToGadget() as RpcStub<ReadingGadget>;
  using ownerB = await gadgetB.connectToGadget() as RpcStub<ReadingGadget>;
  await expect(ownerA.read("doc-a")).resolves.toEqual({ value: 42, subresource: "doc-a" });
  await expect(ownerB.read("doc-b")).resolves.toEqual({ value: 42, subresource: "doc-b" });

  using viewer = await addCollaborator(ws, { gadgetId: a });
  await setSubresourceAccess(viewer.label, url, "doc-b", false);
  const choose = () => stubFor(
      new ObserverConfigRecorder().alwaysChoose(viewer.account.id, MAX_OBSERVER_PROMPTS));

  // Opening the workspace verifies nothing and shows only the gadget granted.
  const openRecorder = new ObserverConfigRecorder();
  using openCallback = stubFor(openRecorder);
  using viewerWorkspace = await viewer.api.openWorkspace(ws.gadgetId, undefined, openCallback);
  expect(openRecorder.calls).toEqual([]);
  const listing = new WorkpieceRecorder();
  using listingStub = stubFor(listing);
  using _listing = await viewerWorkspace.subscribeToWorkpieces(listingStub);
  await listing.loaded;
  expect([...listing.summaries.keys()]).toEqual([a]);

  // Getting A verifies the viewer against A's history, which never held "doc-b".
  const aRecorder = new ObserverConfigRecorder()
      .alwaysChoose(viewer.account.id, MAX_OBSERVER_PROMPTS);
  using aCallback = stubFor(aRecorder);
  using viewerA = await viewerWorkspace.getGadget(a, aCallback);
  expect(aRecorder.calls.map(call => call.map(need => need.gatekeeperId)))
      .toEqual([[connectionId]]);
  using viewerFacetA = await viewerA.connectToGadget() as RpcStub<ReadingGadget>;
  await expect(viewerFacetA.read("doc-a")).resolves.toEqual({ value: 42, subresource: "doc-a" });
  {
    using bCallback = choose();
    await expect(viewerWorkspace.getGadget(b, bCallback)).rejects.toThrow(`No such gadget: ${b}`);
  }

  // The viewer joined A's audience, not B's: the ID they cannot see is blocked from A
  // and still readable by B, though both read it through the same connection.
  await expect(ownerB.read("doc-b")).resolves.toEqual({ value: 42, subresource: "doc-b" });
  await expect(ownerA.read("doc-b"))
      .rejects.toThrow(/blocked because it contains data that a current collaborator/);

  // A grant of B is not a verification of it: B's history holds "doc-b", so getting B fails,
  // and that failure leaves the A capability the viewer already holds working.
  await ws.overseer.addCollaborator(viewer.name, { gadgetId: b });
  {
    using bCallback = choose();
    const failure = await viewerWorkspace.getGadget(b, bCallback)
        .then(() => null, (error: unknown) => error as Error);
    expect(failure?.message).toContain(DENIED);
  }
  await expect(viewerFacetA.read("doc-a")).resolves.toEqual({ value: 42, subresource: "doc-a" });
  await expect(viewerA.getTitle()).resolves.toBe("Gadget A");

  await setSubresourceAccess(viewer.label, url, "doc-b", true);
  {
    using bCallback = choose();
    using _viewerB = await viewerWorkspace.getGadget(b, bCallback);
  }

  // Revoking only A narrows the viewer to B, restarting the workspace to end the A capability.
  const narrowed = [expect.objectContaining({
    profile: expect.objectContaining({ id: viewer.profileId }),
    oldAccess: { role: "use", gadgetIds: [a, b].toSorted((x, y) => x - y) },
    newAccess: { role: "use", gadgetIds: [b] },
  })];
  expect(await ws.overseer.previewRemoveCollaborator(viewer.profileId, a)).toEqual(narrowed);
  expect(await ws.overseer.removeCollaborator(viewer.profileId, [], a)).toEqual(narrowed);
  await waitFor("the restart to end the viewer's A capability", () =>
    viewerA.getTitle().then(() => null, () => true));

  // The restart ends every API session that held the workspace, the viewer's among them.
  const reopened = await waitFor("the viewer to reopen after the restart", async () => {
    try {
      using freshPublic = connect(harness.url);
      using freshApi = await logIn(freshPublic, viewer.name);
      using workspace = await freshApi.openWorkspace(ws.gadgetId);
      const relisted = new WorkpieceRecorder();
      using relistedStub = stubFor(relisted);
      using _relisted = await workspace.subscribeToWorkpieces(relistedStub);
      await relisted.loaded;
      using bCallback = choose();
      using _viewerB = await workspace.getGadget(b, bCallback);
      return {
        listed: [...relisted.summaries.keys()],
        a: await workspace.getGadget(a).then(
            () => null, (error: unknown) => (error as Error).message),
      };
    } catch {
      return null;
    }
  });
  expect(reopened).toEqual({ listed: [b], a: `No such gadget: ${a}` });
});

interface HookGadget extends RpcTarget {
  watch(key: string): Promise<void>;
  deliveredValues(): Promise<number[]>;
}

const HOOK_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "value-hook") throw new TypeError("Unknown hook type");
    return new ValueHook(this.ctx.storage);
  }
  async watch(key) {
    await this.env.THING.watch(key, await this.ctx.restore({ type: "value-hook" }));
  }
  async deliveredValues() { return (await this.ctx.storage.get("values")) ?? []; }
}
class ValueHook extends RpcTarget {
  constructor(storage) { super(); this.storage = storage; }
  async onValueRequested(value) {
    const values = (await this.storage.get("values")) ?? [];
    await this.storage.put("values", [...values, value]);
  }
}`;

it.concurrent("reported hook deliveries are authorized, check both collaborator roles, and retain history after deletion",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("hook-reporting");
  const hookKey = `reporting-hook-${crypto.randomUUID()}`;
  await reportSubresources(url);
  using reporting = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!reporting) throw new Error("Failed to create the reporting connection");
  const connectionId = await reporting.getId();
  using gadget = await ws.overseer.createGadget("Reporting Hook", undefined, "REPORTING_HOOK");
  const gadgetId = await gadget.getId();
  await gadget.bind("THING", connectionId);
  await installServer(ws, gadgetId, HOOK_SERVER);

  using registrationFacet = await gadget.connectToGadget() as RpcStub<HookGadget>;
  await registrationFacet.watch(hookKey);
  const [hook] = await ws.overseer.listHooks();
  expect(hook).toMatchObject({ gatekeeperId: connectionId, gadgetId, enabled: false });
  if (!hook) throw new Error("The gadget did not register its hook");
  // The temporary binding is only needed to register. Delivery and later admission must work
  // without a gadget binding keeping this connection in scope.
  await gadget.unbind("THING");
  await ws.overseer.enableHook(hook.id);
  expect(await ws.overseer.listHooks()).toMatchObject([{ id: hook.id, enabled: true }]);
  using facet = await gadget.connectToGadget() as RpcStub<HookGadget>;

  using builder = await addCollaborator(ws, "build");
  using viewer = await addCollaborator(ws, { gadgetId });
  using observers = new DisposableStack();
  for (const [collaborator, held] of [[builder, undefined], [viewer, gadgetId]] as const) {
    const recorder = new ObserverConfigRecorder()
        .alwaysChoose(collaborator.account.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(recorder);
    const opened =
        observers.use(await collaborator.api.openWorkspace(ws.gadgetId, undefined, callback));
    // The enabled hook wakes the gadget, so the connection is in its scope though unbound.
    if (held !== undefined) observers.use(await opened.getGadget(held, callback));
    expect(recorder.calls[0]).toContainEqual(expect.objectContaining({ gatekeeperId: connectionId }));
  }

  // No session read has seeded these IDs: the hook must authorize them before invoking the
  // persistent callback, which records the delivered data in the actual gadget's storage.
  const subresources = ["hook-doc-1", 'hook/local#id:"雪"'];
  expect(await testControl(harness, "fire-hook",
      { key: hookKey, value: 71, resourceUrl: url, subresources })).toEqual({ fired: true });
  expect(await facet.deliveredValues()).toEqual([71]);
  const audit = await ws.overseer.listActions({ filter: "observation" });
  expect(audit.entries).toMatchObject([{
    type: "observation", gatekeeperId: connectionId,
    description: {
      title: `Hook ${hookKey} requested 71`,
    },
  }]);

  for (const [index, [collaborator, held]] of
      ([[builder, undefined], [viewer, gadgetId]] as const).entries()) {
    const deniedId = `denied-hook-${index}`;
    await setSubresourceAccess(collaborator.label, url, deniedId, false);
    expect(await testControl(harness, "fire-hook", {
      key: hookKey, value: 80 + index, resourceUrl: url, subresources: [deniedId],
    })).toEqual({ error: expect.stringContaining(READ_REFUSED) });
    expect(await facet.deliveredValues()).toEqual([71]);
    expect(await ws.overseer.listActions({ filter: "observation" })).toEqual(audit);
    // A failed delivery must not commit an admission requirement for its denied subresource.
    expect((await collaboratorOpens(collaborator, ws.gadgetId, held)).error).toBeUndefined();
  }

  await ws.overseer.deleteHook(hook.id);
  expect(await ws.overseer.listHooks()).toEqual([]);
  expect(await testControl(harness, "fire-hook",
      { key: hookKey, value: 99, resourceUrl: url, subresources }))
      .toEqual({ error: "Hook has been deleted or disabled." });
  expect(await facet.deliveredValues()).toEqual([71]);
  expect(await ws.overseer.listActions({ filter: "observation" })).toEqual(audit);

  // Hook removal does not erase data the callback already brought into the workspace, so build
  // collaborators are still verified against it. So is whoever holds the gadget the hook woke:
  // its firings were attributed to that gadget, whose recorded requirements keep the connection
  // in its verification scope though nothing binds or hooks it any more.
  for (const [collaborator, held, subresource] of
      [[builder, undefined, subresources[0]!], [viewer, gadgetId, subresources[1]!]] as const) {
    await setSubresourceAccess(collaborator.label, url, subresource, false);
    const refused = await collaboratorOpens(collaborator, ws.gadgetId, held);
    expect(refused.error?.message).toContain(DENIED);
    expect(refused.recorder.calls[0]).toContainEqual(expect.objectContaining({
      gatekeeperId: connectionId,
      failure: expect.objectContaining({ reason: expect.stringContaining(DENIED) }),
    }));
  }
});
