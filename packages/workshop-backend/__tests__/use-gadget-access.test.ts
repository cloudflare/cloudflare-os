// A "use" collaborator is admitted to a restricted workspace shell that lists only the gadgets
// their access includes, and is verified for each gadget as they get it: getGadget re-reads their
// live access, refuses anything it does not include exactly like a gadget that doesn't exist, and
// verifies them against that one gadget's scope -- so a failure on one gadget leaves the others
// alone. Their Outputs index is filtered the same way.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) with the real sharing
// graph; a forged UseOverseerInterface (openFakeOverseer) delegates to it, and gatekeeper facets
// and User DOs are the only fakes.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  CollaboratorAccess, GadgetClient, PermissionEdge, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
import type { WorkspaceListing } from "../src/workspace-listing.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type ObserverImpl = OverseerDurableObject["impl"];

const OWNER = "owner";
// openFakeOverseer opens "use" sessions as this User DO and profile.
const VIEWER_USER = "viewer-id";
const VIEWER = `${VIEWER_USER}-profile`;

// Tests replace the facet factory, so the stored class is never instantiated.
const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

let doCounter = 0;

async function withImpl(fn: (impl: ObserverImpl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`use-gadget-access-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field with its real type.)
    let impl = instance["impl"];
    impl.ownerProfileId = OWNER;
    await fn(impl);
  });
}

function seedGatekeeper(impl: ObserverImpl, id: number): void {
  impl.storage.gatekeepers.put({
    id, resourceTitle: `Connection ${id}`, class: fakeGatekeeperClass,
    creationSpec: {
      type: "gatekeeper", vendorId: "testvendor", resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

// A gadget binding `target` when given; `pending` keeps it provisional to chat 1.
function seedGadget(impl: ObserverImpl, id: number,
                    opts: { target?: number, pending?: boolean } = {}): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title: `Gadget ${id}`, created: new Date(0), bindingName: `G${id}`,
    bindings: opts.target === undefined ? {} : { DB: { target: opts.target } },
    ...(opts.pending ? { pending: { chatId: 1 } } : {}),
  });
}

// The owner's grants of single gadgets to the viewer.
function shareGadgets(impl: ObserverImpl, gadgetIds: number[]): void {
  let addedBy: PermissionEdge[] = gadgetIds.map(gadgetId => ({
    type: "user", sharer: OWNER, created: new Date(0), role: "use", gadgetId,
  }));
  impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Viewer" }, addedBy });
}

// Legacy-protocol facets recording which connections the viewer was registered on, refusing
// those in `refuse`.
function legacyFacets(impl: ObserverImpl, refuse: ReadonlySet<number> = new Set()): number[] {
  let adds: number[] = [];
  const getFacet = async (id: number) => ({
    describe: async () => ({
      url: `https://example.com/${id}`, title: `Connection ${id}`, snippet: "",
      suggestedBindingName: "C", tsType: "C",
    }),
    addObserver: async () => {
      if (refuse.has(id)) throw new Error("access revoked upstream");
      adds.push(id);
    },
    removeObserver: async () => {},
  });
  // These direct-DO tests exercise only the legacy observer methods, not the full RPC facet.
  impl.getGatekeeperFacet = getFacet as unknown as ObserverImpl["getGatekeeperFacet"];
  return adds;
}

// The viewer's User DO: always has the account and always mints a verifier.
const viewerUser = {
  id: { toString: () => VIEWER_USER },
  getVerifier: async () => ({}),
  describeConnectedAccount: async () => null,
  whoami: async () => ({ type: "user", id: VIEWER, name: "Viewer" }),
  recordSharedWorkspaceOpen: async () => {},
};

// A "use" session over the real impl's access check, verification and session counting.
function openViewer(impl: ObserverImpl, access: CollaboratorAccess, extra: object = {}) {
  return openFakeOverseer({ gadgets: impl.storage.gadgets }, { role: "use", access, impl: {
    users: { idFromString: (id: string) => id, get: () => viewerUser },
    joinSession: (holder: unknown, gadgetId?: number) => impl.joinSession(holder as never, gadgetId),
    authorizeGadget: (...args: Parameters<ObserverImpl["authorizeGadget"]>) =>
        impl.authorizeGadget(...args),
    ...extra,
  } });
}

function dispose(value: unknown): void {
  (value as Disposable)[Symbol.dispose]();
}

describe("UseOverseerInterface.getGadget", () => {
  it("refuses a gadget the viewer's access doesn't include, revealing nothing", () =>
      withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGadget(impl, 100);
    seedGadget(impl, 101, { target: 1 });
    shareGadgets(impl, [100]);
    let adds = legacyFacets(impl);
    let client = await openViewer(impl, { role: "use", gadgetIds: [100] });

    // Exactly the error a missing gadget gets, and nobody is verified for it.
    await expect(client.getGadget(101)).rejects.toThrow("No such gadget: 101");
    await expect(client.getGadget(999)).rejects.toThrow("No such gadget: 999");
    expect(adds).toEqual([]);
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();
    dispose(client);
  }));

  it("refuses a still-provisional gadget even when a grant names it", () =>
      withImpl(async impl => {
    seedGadget(impl, 100, { pending: true });
    shareGadgets(impl, [100]);
    legacyFacets(impl);
    let client = await openViewer(impl, { role: "use", gadgetIds: [100] });

    await expect(client.getGadget(100)).rejects.toThrow("No such gadget: 100");
    dispose(client);
  }));

  it("re-reads live access rather than trusting what the shell was opened with", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    shareGadgets(impl, [100]);
    legacyFacets(impl);
    // The shell's snapshot still lists 101, but the grant for it is gone.
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 101] });

    await expect(client.getGadget(101)).rejects.toThrow("No such gadget: 101");
    dispose(await client.getGadget(100));
    dispose(client);
  }));

  it("verifies the viewer for only the gadget they get", () => withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGatekeeper(impl, 2);
    seedGadget(impl, 100, { target: 1 });
    seedGadget(impl, 101, { target: 2 });
    shareGadgets(impl, [100, 101]);
    impl.storage.observers.put(
        { profileId: VIEWER, observerId: "obs-v", accountChoices: { 1: { accountId: 10 }, 2: { accountId: 20 } } });
    let adds = legacyFacets(impl);
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 101] });

    let gadget = await client.getGadget(100);

    expect(adds).toEqual([1]);
    dispose(gadget);
    dispose(client);
  }));

  it("a failure on one gadget leaves the viewer's other gadgets alone", () =>
      withImpl(async impl => {
    seedGatekeeper(impl, 1);
    seedGatekeeper(impl, 2);
    seedGadget(impl, 100, { target: 1 });
    seedGadget(impl, 101, { target: 2 });
    shareGadgets(impl, [100, 101]);
    let record = { profileId: VIEWER, observerId: "obs-v", accountChoices: { 1: { accountId: 10 }, 2: { accountId: 20 } } };
    impl.storage.observers.put(record);
    let adds = legacyFacets(impl, new Set([2]));
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 101] });

    let first: GadgetClient = await client.getGadget(100);
    await expect(client.getGadget(101)).rejects.toThrow(/could not confirm/);

    // Her record (account choices, not a verification result) is untouched, nothing restarted,
    // and the gadget she already holds -- and a fresh get of it -- still work.
    expect(impl.storage.observers.get(VIEWER)).toEqual(record);
    expect(restarts).toEqual([]);
    let again = await client.getGadget(100);
    expect(adds).toEqual([1, 1]);
    dispose(again);
    dispose(first);
    dispose(client);
  }));
});

describe("what a use session lists", () => {
  it("subscribeToWorkpieces lists only the gadgets the viewer's access includes", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    seedGadget(impl, 102, { pending: true });
    let client = await openViewer(impl, { role: "use", gadgetIds: [100, 102] }, {
      subscribeToWorkpieces: (...args: Parameters<ObserverImpl["subscribeToWorkpieces"]>) =>
          impl.subscribeToWorkpieces(...args),
    });
    let listed: number[] = [];
    let ready = Promise.withResolvers<void>();
    let subscriber: WorkpiecesSubscriber = {
      entry: async (summary: WorkpieceSummary) => { listed.push(summary.id); },
      removed: async () => {},
      ready: async () => { ready.resolve(); },
    };
    // (onRpcBroken must exist on the mock: a native stub over a plain object forwards it.)
    using stub = new NativeRpcStub({ ...subscriber, onRpcBroken: () => {} });

    let sub = await client.subscribeToWorkpieces(
        stub as unknown as Parameters<typeof client.subscribeToWorkpieces>[0]);
    await ready.promise;

    // 101 isn't hers, and 102 is still provisional to a chat.
    expect(listed).toEqual([100]);
    dispose(sub);
    dispose(client);
  }));

  it("open() pushes the viewer's Outputs index with only their gadgets", () => withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    shareGadgets(impl, [101]);
    impl.ownerId = "owner-user";
    let pushed = Promise.withResolvers<WorkspaceListing>();
    impl.users = {
      idFromString: (id: string) => id,
      idFromName: (name: string) => name === VIEWER ? VIEWER_USER : name,
      get: (id: string) => ({
        syncWorkspaceListing: (_workspace: string, listing: WorkspaceListing) => {
          // The first may come before the session joins the fan-out, with the title alone.
          if (id === VIEWER_USER && listing.outputs) pushed.resolve(listing);
        },
      }),
    } as unknown as ObserverImpl["users"];
    let client = await openViewer(impl, { role: "use", gadgetIds: [101] }, {
      joinOutputsFanout: (userId: string) => impl.joinOutputsFanout(userId),
      resyncListingTo: (userId: string, profileId?: string) => impl.resyncListingTo(userId, profileId),
    });

    let listing = await pushed.promise;
    expect(listing.outputs?.map(entry => entry.workpieceId)).toEqual([101]);
    // A "use" collaborator lists the workspace under its title, but is told nothing of what waits
    // there or its hooks.
    expect(listing.title?.title).toBe(impl.storage.title.get());
    expect(listing.attention).toBeUndefined();
    expect(listing.hooks).toBeUndefined();
    dispose(client);
  }));

  it("the Outputs fan-out filters each watcher by their access", () => withImpl(async impl => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    shareGadgets(impl, [100]);
    impl.storage.collaborators.put({ profile: { id: "other-user", name: "Other" }, addedBy: [{
      type: "user", sharer: OWNER, created: new Date(0), role: "use", gadgetId: 101,
    }] });
    impl.ownerId = "owner-user";
    let pushes = new Map<string, PromiseWithResolvers<number[] | undefined>>(
        ["owner-user", VIEWER_USER, "other-user"].map(id => [id, Promise.withResolvers()]));
    impl.users = {
      idFromString: (id: string) => id,
      idFromName: (name: string) => name === VIEWER ? VIEWER_USER : name,
      get: (id: string) => ({
        syncWorkspaceListing: (_workspace: string, listing: WorkspaceListing) => {
          pushes.get(id)!.resolve(listing.outputs?.map(entry => entry.workpieceId));
        },
      }),
    } as unknown as ObserverImpl["users"];
    let leaveViewer = impl.joinOutputsFanout(VIEWER_USER);
    let leaveOther = impl.joinOutputsFanout("other-user");

    impl.markListingDirty("outputs");

    expect(await pushes.get("owner-user")!.promise).toEqual([100, 101]);
    expect(await pushes.get(VIEWER_USER)!.promise).toEqual([100]);
    expect(await pushes.get("other-user")!.promise).toEqual([101]);
    leaveViewer();
    leaveOther();
  }));

  it("sends a part until its recipient acknowledges its value, and every part on a resync", () =>
      withImpl(async impl => {
    seedGadget(impl, 100);
    impl.ownerId = "owner-user";
    let listings: WorkspaceListing[] = [];
    let failing = false;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        syncWorkspaceListing: async (_workspace: string, listing: WorkspaceListing) => {
          listings.push(listing);
          if (failing) throw new Error("User unavailable");
        },
      }),
    } as unknown as ObserverImpl["users"];
    let parts = () => listings.splice(0).map(listing =>
        Object.keys(listing).filter(part => part !== "listingRev").toSorted());

    impl.resyncListingTo("owner-user");
    await vi.waitFor(() => expect(listings).toHaveLength(1));
    expect(parts()).toEqual([["attention", "outputs", "title"]]);

    // A commit that rebinds the gadget leaves the outputs as acknowledged.
    seedGadget(impl, 100, { target: 7 });
    await impl.deliverUserUpdates();
    expect(parts()).toEqual([]);

    // A new gadget, whose send fails.
    failing = true;
    seedGadget(impl, 101);
    await vi.waitFor(() => expect(listings).toHaveLength(1));
    expect(parts()).toEqual([["outputs"]]);
    failing = false;

    // Sent again by the alarm, though the next change leaves the outputs as the failed send had
    // them.
    seedGadget(impl, 100);
    await impl.deliverUserUpdates();
    expect(listings).toEqual([]);
    await impl.runAlarmTasks();
    await vi.waitFor(() => expect(listings).toHaveLength(1));
    expect(listings.splice(0).map(listing => listing.outputs?.map(entry => entry.workpieceId)))
        .toEqual([[100, 101]]);

    impl.resyncListingTo("owner-user");
    await vi.waitFor(() => expect(listings).toHaveLength(1));
    expect(parts()).toEqual([["attention", "outputs", "title"]]);
  }));
});

describe("recording a shared open", () => {
  it("records nothing once the collaborator is removed while the owner's profile is fetched",
      async () => {
    let release = Promise.withResolvers<void>();
    let asked = Promise.withResolvers<void>();
    let record = vi.fn(async () => {});
    let access: CollaboratorAccess | undefined = { role: "use", gadgetIds: [] };
    let storage = {};
    using _client = await openFakeOverseer(storage, { role: "use", access, impl: {
      getSharingManager: async () => ({ getEffectiveAccess: () => access }),
      users: { idFromString: (id: string) => id, get: () => ({
        whoami: async () => { asked.resolve(); await release.promise; return { type: "user", id: OWNER, name: "Owner" }; },
        recordSharedWorkspaceOpen: record,
      }) },
    } }) as unknown as Disposable;
    await asked.promise;

    // Removed, then the workspace renamed, before whoami() resolves.
    access = undefined;
    Object.assign(storage, { title: { get: () => "Renamed" }, titleRev: { get: () => 1 } });
    release.resolve();
    await scheduler.wait(10);

    expect(record).not.toHaveBeenCalled();
  });

  // The starting points carry chat heads, which a "use" collaborator never holds.
  it("takes no starting points for a role narrowed to use while the owner's profile is fetched",
      async () => {
    let release = Promise.withResolvers<void>();
    let asked = Promise.withResolvers<void>();
    let record = vi.fn(async (..._args: unknown[]) => {});
    let access: CollaboratorAccess = { role: "build" };
    let meta = { id: 1, title: "Chat", started: new Date(1), lastActive: new Date(1) };
    using _client = await openFakeOverseer({
      chatMeta: { list: () => [meta] },
      nextChatSequences: { get: () => ({ visibleThroughSequence: 3 }) },
    }, { role: "build", access, userId: VIEWER_USER, impl: {
      authorizeCollaborator: async () => access,
      getSharingManager: async () => ({ getEffectiveAccess: () => access }),
      // Admits anyone, so the role alone must withhold them.
      mayReadChatState: async () => true,
      nextChatSequencePeek: () => 4,
      chatHead: () => undefined,
      chatParticipationDefault: () => true,
      users: { idFromString: (id: string) => id, get: () => ({
        whoami: async () => { asked.resolve(); await release.promise; return { type: "user", id: OWNER, name: "Owner" }; },
        recordSharedWorkspaceOpen: record,
      }) },
    } }) as unknown as Disposable;
    await asked.promise;

    access = { role: "use", gadgetIds: [] };
    release.resolve();
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    let [, , , role, baselines] = record.mock.calls[0];
    expect({ role, baselines }).toEqual({ role: "use", baselines: null });
  });

  // Their User DO ignored the removal queued before the listing existed, so it is queued again.
  it("queues a removal that lands while the open is recorded, after the resync", async () => {
    let recording = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    let access: CollaboratorAccess | undefined = { role: "use", gadgetIds: [] };
    let calls: unknown[][] = [];
    using _client = await openFakeOverseer({}, { role: "use", access, userId: VIEWER_USER, impl: {
      getSharingManager: async () => ({ getEffectiveAccess: () => access }),
      resyncListingTo: (...args: unknown[]) => { calls.push(["resync", ...args]); },
      queueCollaboratorRole: (...args: unknown[]) => { calls.push(["role", ...args]); },
      users: { idFromString: (id: string) => id, get: () => ({
        whoami: async () => ({ type: "user", id: OWNER, name: "Owner" }),
        recordSharedWorkspaceOpen: async () => { recording.resolve(); await release.promise; },
      }) },
    } }) as unknown as Disposable;
    await recording.promise;

    access = undefined;
    release.resolve();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map(([kind, , , role]) => [kind, role])).toEqual([["resync", undefined], ["role", null]]);
  });
});
