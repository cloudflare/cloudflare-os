// Kernel-owned observer tracking (docs/observers.md §10), against the fixture gatekeeper's tracked
// mode: a binding advertises `supportsObserverTracking` once `/control/observer-tracking` says so,
// reports each read's `subresources`, and its verifier answers `verifyObserverAccess()` from the
// outcomes `/control/verify-outcome` sets per subresource.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, restartWorkspace, signUp, stubFor, waitFor, WorkpieceRecorder,
  type ConnectedAccount, type RpcTarget,
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

const DENIED =
    "This account can't access some of the data this workspace read through this service.";

/** A resource URL no other test (or earlier run against the same storage) has used. */
function freshThingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}-${crypto.randomUUID().slice(0, 8)}`;
}

function setObserverTracking(resourceUrl: string, enabled: boolean): Promise<void> {
  return testControl(harness, "observer-tracking", { resourceUrl, enabled });
}

/** Refuse (or re-admit) `label` for one subresource of the tracked binding at `resourceUrl`. */
function setSubresourceAccess(
    label: string, resourceUrl: string, subresource: string, allow: boolean): Promise<void> {
  return testControl(harness, "verify-outcome",
      { label, resourceUrl, subresource, allow, reason: "The test refused this subresource." });
}

async function historyExportCount(resourceUrl: string): Promise<number> {
  return (await testControl<{ count: number }>(harness, "history-export-count", { resourceUrl }))
    .count;
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
  const overseer = await api.newGadget();
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
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  label: string;
};

/**
 * Share the workspace with a fresh collaborator, with an account of their own. They get their
 * own connection, which a restart of the owner's workspace doesn't sever.
 */
async function addCollaborator(ws: Workspace, role: "build" | "use" = "build")
    : Promise<Collaborator> {
  const [bob] = nextUsernames("trackbob");
  const connection = connect(harness.url);
  const api = await signUp(connection, bob);
  const account = await provisionAccount(api);
  if (!await ws.overseer.addCollaborator(bob, role)) {
    throw new Error(`Failed to share the workspace with ${bob}`);
  }
  return {
    api, account, label: accountLabel(account),
    [Symbol.dispose]() {
      api[Symbol.dispose]();
      connection[Symbol.dispose]();
    },
  };
}

/** The collaborator opens the workspace, choosing their account at every prompt. */
async function collaboratorOpens(bob: Collaborator, gadgetId: string)
    : Promise<{ recorder: ObserverConfigRecorder; error?: Error }> {
  const recorder = new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS);
  const callback = stubFor(recorder);
  try {
    (await bob.api.openGadget(gadgetId, undefined, callback))[Symbol.dispose]();
    return { recorder };
  } catch (error) {
    return { recorder, error: error as Error };
  } finally {
    callback[Symbol.dispose]();
  }
}

it.concurrent("legacy and tracked connections coexist, each verified its own way", async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const legacyUrl = freshThingUrl("coexist-legacy");
  const trackedUrl = freshThingUrl("coexist-tracked");
  await setObserverTracking(trackedUrl, true);
  await connectAndRead(ws, legacyUrl, []);
  const trackedId = await connectAndRead(ws, trackedUrl, ["doc-1"]);
  using bob = await addCollaborator(ws);

  const first = await collaboratorOpens(bob, ws.gadgetId);
  expect(first.error).toBeUndefined();
  // The tracked connection is asked about under the same connection ID used by its binding.
  expect(first.recorder.calls[0]!.map(need => need.gatekeeperId)).toContain(trackedId);
  // The legacy connection registered Bob as an observer; the tracked one never hears of him.
  expect(await observerEvents(legacyUrl)).toMatchObject([{ type: "add" }]);
  expect(await observerEvents(trackedUrl)).toEqual([]);

  // Only the tracked connection's verifier check can refuse him for what it recorded.
  await setSubresourceAccess(bob.label, trackedUrl, "doc-1", false);
  const second = await collaboratorOpens(bob, ws.gadgetId);
  expect(second.error?.message).toContain(DENIED);
  expect(second.error?.message).toContain(bob.label);
  // His persisted choices are re-verified first, so the opening prompt carries the failure.
  const failed = second.recorder.calls[0]!.filter(need => need.failure);
  expect(failed).toEqual([expect.objectContaining({ gatekeeperId: trackedId })]);
  expect(failed[0]!.failure!.reason).toContain(DENIED);
});

it.concurrent("the same local subresource ID is checked independently in different resources",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const firstUrl = freshThingUrl("scope-first");
  const secondUrl = freshThingUrl("scope-second");
  const localId = 'same/local#id:"雪"';
  await setObserverTracking(firstUrl, true);
  await setObserverTracking(secondUrl, true);
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

it.concurrent("a legacy connection's history is imported before the next admission is checked",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("import");
  using gatekeeper = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!gatekeeper) throw new Error(`Failed to connect ${url}`);
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  // Read under the legacy protocol: only the binding itself remembers what it depended on.
  await expect(session.readValue(false, false, undefined, ["hist-1"])).resolves.toBe(42);
  using bob = await addCollaborator(ws);

  // The gatekeeper upgrades. Its first report of subresources, through a session minted under
  // the legacy protocol, is refused and tells the Workshop to set the connection up again.
  await setObserverTracking(url, true);
  await expect(session.readValue(false, false, undefined, ["new-1"]))
      .rejects.toThrow(/now supports the Workshop's observer tracking/);
  expect(await historyExportCount(url)).toBe(0);

  await setSubresourceAccess(bob.label, url, "hist-1", false);
  const refused = await collaboratorOpens(bob, ws.gadgetId);
  // The refusal can only come from the imported ID: no tracked read has succeeded.
  expect(refused.error?.message).toContain(DENIED);
  expect(await historyExportCount(url)).toBe(1);
  expect(await observerEvents(url)).toEqual([]);

  // The import restarted the workspace's collaborator sessions (Bob's refused open among them):
  // let that land before he opens again.
  await settleRestart();
  await setSubresourceAccess(bob.label, url, "hist-1", true);
  expect((await collaboratorOpens(bob, ws.gadgetId)).error).toBeUndefined();
  // The import committed, so the history is never exported again.
  expect(await historyExportCount(url)).toBe(1);
});

it.concurrent("disconnect drops tracked permission checks but keeps the observation audit",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("removed");
  await setObserverTracking(url, true);
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

interface TrackedGadget extends RpcTarget {
  read(subresource: string): Promise<{ value: number; subresource: string }>;
}

const TRACKED_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async read(subresource) {
    const value = await this.env.TRACKED_THING.readValue(false, false, undefined, [subresource]);
    return { value, subresource };
  }
}`;

it.concurrent("a gadget's tracked reads enforce use collaborator admission and live access",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("gadget-tracked");
  await setObserverTracking(url, true);
  using tracked = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!tracked) throw new Error("Failed to create the tracked connection");
  const connectionId = await tracked.getId();
  using gadget = await ws.overseer.createGadget("Tracked Gadget", undefined, "TRACKED_GADGET");
  const gadgetId = await gadget.getId();
  await gadget.bind("TRACKED_THING", connectionId);

  // Author real server code through the same human-only edit/merge API as the code editor.
  const workpieces = new WorkpieceRecorder();
  using subscriber = stubFor(workpieces);
  using _subscription = await ws.overseer.subscribeToWorkpieces(subscriber);
  await workpieces.loaded;
  const summary = workpieces.summaries.get(gadgetId);
  if (summary?.type !== "gadget" || summary.commitId === undefined) {
    throw new Error("The new gadget has no committed head");
  }
  const chatId = await ws.overseer.newChat("Implement the tracked reader", null);
  await ws.overseer.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "tracked-reader", seq: 1,
    pins: [{ gadgetId, baseCommit: summary.commitId }],
    change: diffFiles(new Map(), new Map([[gadgetId, new Map([["server.js", TRACKED_SERVER]])]])),
  });
  expect(await ws.overseer.mergeChanges(chatId)).toEqual({ outcome: "merged" });

  using facet = await gadget.connectToGadget() as RpcStub<TrackedGadget>;
  await expect(facet.read("gadget-1")).resolves.toEqual({ value: 42, subresource: "gadget-1" });
  using viewer = await addCollaborator(ws, "use");
  await setSubresourceAccess(viewer.label, url, "gadget-1", false);
  const refused = await collaboratorOpens(viewer, ws.gadgetId);
  expect(refused.error?.message).toContain(DENIED);
  expect(refused.recorder.calls[0]).toContainEqual(expect.objectContaining({
    gatekeeperId: connectionId, resourceUrl: url,
  }));

  await setSubresourceAccess(viewer.label, url, "gadget-1", true);
  const recorder = new ObserverConfigRecorder().alwaysChoose(viewer.account.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  using viewerWorkspace = await viewer.api.openGadget(ws.gadgetId, undefined, callback);
  using viewerGadget = await viewerWorkspace.getGadget(gadgetId);
  using viewerFacet = await viewerGadget.connectToGadget() as RpcStub<TrackedGadget>;
  await expect(viewerFacet.read("gadget-1"))
      .resolves.toEqual({ value: 42, subresource: "gadget-1" });

  // A new subresource is checked before the binding can return its value to gadget code.
  await setSubresourceAccess(viewer.label, url, "live-2", false);
  await expect(viewerFacet.read("live-2"))
      .rejects.toThrow(/blocked because it contains data that a current collaborator/);
  // A refused read did not add the inaccessible ID to the gadget's admission history.
  expect((await collaboratorOpens(viewer, ws.gadgetId)).error).toBeUndefined();
  await setSubresourceAccess(viewer.label, url, "live-2", true);
  await expect(viewerFacet.read("live-2")).resolves.toEqual({ value: 42, subresource: "live-2" });

  // The successful live read joined gadget history, so revocation also denies the next admission.
  await setSubresourceAccess(viewer.label, url, "live-2", false);
  expect((await collaboratorOpens(viewer, ws.gadgetId)).error?.message).toContain(DENIED);
  expect(await observerEvents(url)).toEqual([]);
});

interface TrackedHookGadget extends RpcTarget {
  watch(key: string): Promise<void>;
  deliveredValues(): Promise<number[]>;
}

const TRACKED_HOOK_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "tracked-hook") throw new TypeError("Unknown hook type");
    return new TrackedHook(this.ctx.storage);
  }
  async watch(key) {
    await this.env.TRACKED_THING.watch(key, await this.ctx.restore({ type: "tracked-hook" }));
  }
  async deliveredValues() { return (await this.ctx.storage.get("values")) ?? []; }
}
class TrackedHook extends RpcTarget {
  constructor(storage) { super(); this.storage = storage; }
  async onValueRequested(value) {
    const values = (await this.storage.get("values")) ?? [];
    await this.storage.put("values", [...values, value]);
  }
}`;

it.concurrent("tracked hooks deliver authorized data, check both collaborator roles, and retain history after deletion",
    async () => {
  using publicApi = connect(harness.url);
  using ws = await newWorkspace(publicApi);
  const url = freshThingUrl("hook-tracked");
  const hookKey = `tracked-hook-${crypto.randomUUID()}`;
  await setObserverTracking(url, true);
  using tracked = await ws.overseer.newGatekeeper(ws.account.id, url);
  if (!tracked) throw new Error("Failed to create the tracked connection");
  const connectionId = await tracked.getId();
  using gadget = await ws.overseer.createGadget("Tracked Hook", undefined, "TRACKED_HOOK");
  const gadgetId = await gadget.getId();
  await gadget.bind("TRACKED_THING", connectionId);

  const workpieces = new WorkpieceRecorder();
  using subscriber = stubFor(workpieces);
  using _subscription = await ws.overseer.subscribeToWorkpieces(subscriber);
  await workpieces.loaded;
  const summary = workpieces.summaries.get(gadgetId);
  if (summary?.type !== "gadget" || summary.commitId === undefined) {
    throw new Error("The new gadget has no committed head");
  }
  const chatId = await ws.overseer.newChat("Implement the tracked hook", null);
  await ws.overseer.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "tracked-hook", seq: 1,
    pins: [{ gadgetId, baseCommit: summary.commitId }],
    change: diffFiles(new Map(), new Map([[gadgetId, new Map([["server.js", TRACKED_HOOK_SERVER]])]])),
  });
  expect(await ws.overseer.mergeChanges(chatId)).toEqual({ outcome: "merged" });

  using registrationFacet = await gadget.connectToGadget() as RpcStub<TrackedHookGadget>;
  await registrationFacet.watch(hookKey);
  const [hook] = await ws.overseer.listHooks();
  expect(hook).toMatchObject({ gatekeeperId: connectionId, gadgetId, enabled: false });
  if (!hook) throw new Error("The gadget did not register its tracked hook");
  // The temporary binding is only needed to register. Delivery and later admission must work
  // without a gadget binding keeping this connection in scope.
  await gadget.unbind("TRACKED_THING");
  await ws.overseer.enableHook(hook.id);
  expect(await ws.overseer.listHooks()).toMatchObject([{ id: hook.id, enabled: true }]);
  using facet = await gadget.connectToGadget() as RpcStub<TrackedHookGadget>;

  using builder = await addCollaborator(ws, "build");
  using viewer = await addCollaborator(ws, "use");
  using observers = new DisposableStack();
  for (const collaborator of [builder, viewer]) {
    const recorder = new ObserverConfigRecorder()
        .alwaysChoose(collaborator.account.id, MAX_OBSERVER_PROMPTS);
    using callback = stubFor(recorder);
    observers.use(await collaborator.api.openGadget(ws.gadgetId, undefined, callback));
    expect(recorder.calls[0]).toContainEqual(expect.objectContaining({ gatekeeperId: connectionId }));
  }

  // No session read has seeded these IDs: the hook must authorize them before invoking the
  // persistent callback, which records the delivered data in the actual gadget's storage.
  const subresources = ["hook-doc-1", 'hook/local#id:"雪"'];
  expect(await testControl(harness, "fire-hook", { key: hookKey, value: 71, subresources }))
      .toEqual({ fired: true });
  expect(await facet.deliveredValues()).toEqual([71]);
  const audit = await ws.overseer.listActions({ filter: "observation" });
  expect(audit.entries).toMatchObject([{
    type: "observation", gatekeeperId: connectionId,
    description: {
      title: `Hook ${hookKey} requested 71`,
    },
  }]);

  for (const [index, collaborator] of [builder, viewer].entries()) {
    const deniedId = `denied-hook-${index}`;
    await setSubresourceAccess(collaborator.label, url, deniedId, false);
    expect(await testControl(harness, "fire-hook", {
      key: hookKey, value: 80 + index, subresources: [deniedId],
    })).toEqual({ error: expect.stringContaining(
      "blocked because it contains data that a current collaborator") });
    expect(await facet.deliveredValues()).toEqual([71]);
    expect(await ws.overseer.listActions({ filter: "observation" })).toEqual(audit);
    // A failed delivery must not commit an admission requirement for its denied subresource.
    expect((await collaboratorOpens(collaborator, ws.gadgetId)).error).toBeUndefined();
  }

  await ws.overseer.deleteHook(hook.id);
  expect(await ws.overseer.listHooks()).toEqual([]);
  expect(await testControl(harness, "fire-hook", { key: hookKey, value: 99, subresources }))
      .toEqual({ error: "Hook has been deleted or disabled." });
  expect(await facet.deliveredValues()).toEqual([71]);
  expect(await ws.overseer.listActions({ filter: "observation" })).toEqual(audit);

  // Hook removal does not erase data the callback already brought into the workspace, so build
  // collaborators are still verified against it. Nothing binds or hooks the connection any more,
  // so as under the legacy protocol it has left "use" collaborators' verification scope.
  await setSubresourceAccess(builder.label, url, subresources[0]!, false);
  const refused = await collaboratorOpens(builder, ws.gadgetId);
  expect(refused.error?.message).toContain(DENIED);
  expect(refused.recorder.calls[0]).toContainEqual(expect.objectContaining({
    gatekeeperId: connectionId, failure: expect.objectContaining({ reason: expect.stringContaining(DENIED) }),
  }));
  await setSubresourceAccess(viewer.label, url, subresources[1]!, false);
  const admitted = await collaboratorOpens(viewer, ws.gadgetId);
  expect(admitted.error).toBeUndefined();
  expect(admitted.recorder.calls).toEqual([]);
  expect(await observerEvents(url)).toEqual([]);
});
