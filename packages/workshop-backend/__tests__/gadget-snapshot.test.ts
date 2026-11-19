// A static snapshot (Overseer.getGadgetSnapshot) is a copy of a gadget's facet storage, served by
// the gadget's code with nothing the gadget can reach: no env, and no use of capabilities the gadget
// stored. Since it reaches nothing, a "use" viewer granted only the gadget's snapshot opens one
// without observer verification; a viewer granted the gadget live gets no snapshot, only the live
// gadget through verification. Writes stay on their own side of the copy, a refresh takes a new
// one, and a copy is deleted with its session, its gadget, or the instance. While the deployment
// forbids snapshot sharing, nobody opens or refreshes a snapshot, makes a view grant or mints a view
// link's key, and the view grants already made open again once it is allowed.
//
// Runs real gadget code, loaded from a real commit, inside a real OverseerDurableObject; a forged
// UseOverseerInterface (openFakeOverseer) delegates to it, and gatekeeper facets and User DOs are
// the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  SNAPSHOT_SHARING_ERROR_CODES, getSnapshotSharingErrorCode,
  type GadgetSnapshotClient, type Overseer, type PermissionEdge,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
import { serializeAdminConfig } from "../src/admin-config.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

const OWNER = "owner";
// openFakeOverseer opens "use" sessions as this profile.
const VIEWER = "viewer-id-profile";
const GADGET_ID = 1;

const SERVER_JS = `
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async read(key) {
    return (await this.ctx.storage.get(key)) ?? null;
  }

  async write(key, value) {
    await this.ctx.storage.put(key, value);
  }

  envKeys() {
    return Object.keys(this.env);
  }

  async storeCallback() {
    await this.ctx.storage.put("callback", await this.ctx.restore({ type: "callback" }));
  }

  async pingStoredCallback() {
    let callback = await this.ctx.storage.get("callback");
    return await callback.ping();
  }

  [restore](params) {
    return new Callback();
  }
}

class Callback extends RpcTarget {
  ping() {
    return "pong";
  }
}
`;

// Tests replace the facet factory, so the stored class is never instantiated.
const fakeGatekeeperClass = {} as unknown as GatekeeperRecord["class"];

let doCounter = 0;

function workspace(): DurableObjectStub<OverseerDurableObject> {
  return env.TEST_OVERSEER.getByName(`gadget-snapshot-${++doCounter}`);
}

// The unit-test worker has no admin-config KV binding: the workspace reads `allowed` instead.
function allowSnapshotSharing(impl: Impl, allowed: boolean): void {
  let config = serializeAdminConfig({ ...DEFAULT_ADMIN_CONFIG, snapshotSharingEnabled: allowed });
  impl.env = { ...impl.env, BLUEPRINTS: { get: async () => config } as unknown as KVNamespace };
}

async function withImpl(stub: DurableObjectStub<OverseerDurableObject>,
                        fn: (impl: Impl) => Promise<void>): Promise<void> {
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field with its real type.)
    let impl = instance["impl"];
    impl.ownerProfileId = OWNER;
    allowSnapshotSharing(impl, true);
    await fn(impl);
  });
}

// Gadget `id` running SERVER_JS, shared with the viewer to view only, or live when `shared` is
// "live", or not at all when it is false, and binding connection `target` when given.
async function seedGadget(impl: Impl, id: number,
                          opts: { shared?: false | "view" | "live", target?: number } = {})
    : Promise<void> {
  let commitId = await impl.gitCache.writeFilesAsCommit(new Map([["server.js", SERVER_JS]]), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
  impl.storage.gadgets.put({
    type: "gadget", id, title: `Gadget ${id}`, created: new Date(0), bindingName: `G${id}`,
    bindings: opts.target === undefined ? {} : { DB: { target: opts.target } }, commitId,
  });
  if (opts.shared === false) return;
  let addedBy: PermissionEdge[] = [
    ...impl.storage.collaborators.get(VIEWER)?.addedBy ?? [],
    { type: "user", sharer: OWNER, created: new Date(0), role: "use", gadgetId: id,
      ...opts.shared === "live" ? {} : { mode: "view" as const } },
  ];
  impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Viewer" }, addedBy });
}

// A "use" session whose access check and snapshots are the real impl's.
function openViewer(impl: Impl): Promise<Overseer> {
  return openFakeOverseer(
      { gadgets: impl.storage.gadgets, gadgetSnapshots: impl.storage.gadgetSnapshots },
      { role: "use", access: { role: "use", gadgetIds: "all" }, impl: {
        gitCache: impl.gitCache,
        gadgetOpenMode: (...args: Parameters<Impl["gadgetOpenMode"]>) => impl.gadgetOpenMode(...args),
        authorizeGadget: (...args: Parameters<Impl["authorizeGadget"]>) => impl.authorizeGadget(...args),
        createGadgetSnapshot: (id: number) => impl.createGadgetSnapshot(id),
        requireSnapshotSharing: () => impl.requireSnapshotSharing(),
        deleteGadgetSnapshot: (facetName: string) => impl.deleteGadgetSnapshot(facetName),
        requireGadgetSnapshot: (...args: Parameters<Impl["requireGadgetSnapshot"]>) =>
            impl.requireGadgetSnapshot(...args),
        getSnapshotFacet: (...args: Parameters<Impl["getSnapshotFacet"]>) =>
            impl.getSnapshotFacet(...args),
        getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
      } });
}

// The owner's session, sharing through the real impl's sharing manager.
function openOwner(impl: Impl): Promise<Overseer> {
  return openFakeOverseer(
      { gadgets: impl.storage.gadgets, gadgetSnapshots: impl.storage.gadgetSnapshots },
      { role: "build", impl: {
        getSharingManager: () => impl.getSharingManager(),
        createGadgetSnapshot: (id: number) => impl.createGadgetSnapshot(id),
        requireSnapshotSharing: () => impl.requireSnapshotSharing(),
      } });
}

function snapshotNames(impl: Impl): string[] {
  return Array.from(impl.storage.gadgetSnapshots.list(), snapshot => snapshot.facetName);
}

// Await a facet call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise, and the leftover copy is reported as an unhandled rejection (see
// overseer-hooks.test.ts).
async function expectRejected(call: Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await call; } catch { rejected = true; }
  expect(rejected).toBe(true);
}

describe("gadget snapshots", () => {
  it("copy the gadget's state, and keep each side's later writes apart until refreshed", () =>
      withImpl(workspace(), async impl => {
    await seedGadget(impl, GADGET_ID);
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    await gadget.write("note", "original");
    using client = await openViewer(impl);
    using snapshot: GadgetSnapshotClient = await client.getGadgetSnapshot(GADGET_ID);
    let takenAt = await snapshot.getRefreshedAt();

    using copy = await snapshot.connectToGadget();
    expect(await copy.read("note")).toBe("original");
    await copy.write("note", "viewer's edit");
    await gadget.write("note", "owner's edit");
    expect(await gadget.read("note")).toBe("owner's edit");
    expect(await copy.read("note")).toBe("viewer's edit");

    // A refresh discards the viewer's edit for the gadget's current state, in a new copy.
    let refreshedAt = await snapshot.refresh();
    expect(refreshedAt.getTime()).toBeGreaterThanOrEqual(takenAt.getTime());
    expect(await snapshot.getRefreshedAt()).toEqual(refreshedAt);
    await expectRejected(copy.read("note"));
    using fresh = await snapshot.connectToGadget();
    expect(await fresh.read("note")).toBe("owner's edit");
    expect(snapshotNames(impl)).toHaveLength(1);
  }));

  it("reach nothing the gadget can: no env, and no capability the gadget stored", () =>
      withImpl(workspace(), async impl => {
    await seedGadget(impl, GADGET_ID);
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    await gadget.storeCallback();
    expect(await gadget.pingStoredCallback()).toBe("pong");
    expect(await gadget.envKeys()).toContain("GADGET");
    using client = await openViewer(impl);
    using snapshot = await client.getGadgetSnapshot(GADGET_ID);

    using copy = await snapshot.connectToGadget();
    expect(await copy.envKeys()).toEqual([]);
    await expectRejected(copy.pingStoredCallback());
    await expect(snapshot.connectToGadget(1)).rejects.toThrow(/can only be viewed/);
  }));

  it("open for a gadget the viewer's view grant includes without verifying anyone, and no other", () =>
      withImpl(workspace(), async impl => {
    impl.storage.gatekeepers.put({
      id: 7, resourceTitle: "Connection 7", class: fakeGatekeeperClass,
      creationSpec: {
        type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7",
        typeUrlPattern: "https://*",
      },
    });
    // The gadget never ran, so it has no stored state yet.
    await seedGadget(impl, GADGET_ID, { target: 7 });
    await seedGadget(impl, 2, { shared: false });
    await seedGadget(impl, 3, { shared: "live" });
    let observed: number[] = [];
    impl.getGatekeeperFacet = (async (id: number) => ({
      addObserver: async () => { observed.push(id); },
    })) as unknown as Impl["getGatekeeperFacet"];
    using client = await openViewer(impl);

    using snapshot = await client.getGadgetSnapshot(GADGET_ID);
    using copy = await snapshot.connectToGadget();
    expect(await copy.read("note")).toBeNull();
    expect(observed).toEqual([]);
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();

    expect(await client.isViewOnly(GADGET_ID)).toBe(true);
    await expect(client.isViewOnly(2)).rejects.toThrow("No such gadget: 2");

    // Exactly the error a missing gadget gets, for one not shared and one shared live.
    await expect(client.getGadgetSnapshot(2)).rejects.toThrow("No such gadget: 2");
    await expect(client.getGadgetSnapshot(3)).rejects.toThrow("No such gadget: 3");
    await expect(client.getGadgetSnapshot(999)).rejects.toThrow("No such gadget: 999");

    // A refresh re-reads live access, so one revoked since keeps the copy already taken.
    impl.storage.collaborators.delete(VIEWER);
    await expect(snapshot.refresh()).rejects.toThrow(`No such gadget: ${GADGET_ID}`);
    expect(snapshotNames(impl)).toHaveLength(1);
  }));

  it.each(["bound", "historical"] as const)(
      "open snapshots of gadgets with a %s legacy connection, which refuse live admission", source =>
      withImpl(workspace(), async impl => {
    impl.storage.gatekeepers.put({
      id: 7, resourceTitle: "Legacy connection", class: fakeGatekeeperClass,
    });
    await seedGadget(impl, GADGET_ID, { shared: "live", ...source === "bound" ? { target: 7 } : {} });
    if (source === "historical") {
      let id = impl.storage.nextActionId.get();
      impl.storage.nextActionId.put(id + 1);
      impl.storage.actions.put({
        id, gatekeeperId: 7, caller: { from: "gadget", gadgetId: GADGET_ID },
        createdAt: new Date(0), state: "approved", type: "observation",
        description: { title: "Read", description: "Cached data", subresources: ["document"] },
      });
    }
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    await gadget.write("note", "cached data");
    using client = await openViewer(impl);

    // Held live, the gadget is refused, with no snapshot to fall back to.
    await expect(client.getGadget(GADGET_ID)).rejects.toThrow();
    await expect(client.getGadgetSnapshot(GADGET_ID)).rejects.toThrow();
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();
    // Held as a view, it opens with what the gadget stored.
    let record = impl.storage.collaborators.get(VIEWER)!;
    record.addedBy = record.addedBy.map(edge => ({ ...edge, mode: "view" as const }));
    impl.storage.collaborators.put(record);
    using snapshot = await client.getGadgetSnapshot(GADGET_ID);
    using copy = await snapshot.connectToGadget();
    expect(await copy.read("note")).toBe("cached data");
  }));

  it("open only as snapshots for a view grant, refusing live admission unverified", () =>
      withImpl(workspace(), async impl => {
    impl.storage.gatekeepers.put({
      id: 7, resourceTitle: "Connection 7", class: fakeGatekeeperClass,
      creationSpec: {
        type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7",
        typeUrlPattern: "https://*",
      },
    });
    await seedGadget(impl, GADGET_ID, { target: 7, shared: "view" });
    let observed: number[] = [];
    impl.getGatekeeperFacet = (async (id: number) => ({
      addObserver: async () => { observed.push(id); },
    })) as unknown as Impl["getGatekeeperFacet"];
    using client = await openViewer(impl);

    expect(await client.isViewOnly(GADGET_ID)).toBe(true);
    // Exactly the error a missing gadget gets, before verifying anyone.
    await expect(client.getGadget(GADGET_ID)).rejects.toThrow(`No such gadget: ${GADGET_ID}`);
    expect(observed).toEqual([]);
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();
    using snapshot = await client.getGadgetSnapshot(GADGET_ID);
    using copy = await snapshot.connectToGadget();
    expect(await copy.read("note")).toBeNull();

    // A live grant from anyone covers the view grant, and then opens no snapshot: not a new
    // one, nor a refresh of one taken before.
    let record = impl.storage.collaborators.get(VIEWER)!;
    record.addedBy.push({ type: "user", sharer: OWNER, created: new Date(0), role: "use",
      gadgetId: GADGET_ID });
    impl.storage.collaborators.put(record);
    expect(await client.isViewOnly(GADGET_ID)).toBe(false);
    await expect(client.getGadgetSnapshot(GADGET_ID)).rejects.toThrow(`No such gadget: ${GADGET_ID}`);
    await expect(snapshot.refresh()).rejects.toThrow(`No such gadget: ${GADGET_ID}`);
  }));

  it("are refused everyone while the deployment forbids them, and open again once allowed", () =>
      withImpl(workspace(), async impl => {
    await seedGadget(impl, GADGET_ID);
    using gadget = await impl.getGadgetFacet(GADGET_ID);
    await gadget.write("note", "original");
    using viewer = await openViewer(impl);
    using owner = await openOwner(impl);
    using snapshot = await viewer.getGadgetSnapshot(GADGET_ID);
    let takenAt = await snapshot.getRefreshedAt();
    let view = { gadgetId: GADGET_ID, mode: "view" } as const;
    let viewLink = await owner.createShareLink(view);
    let useLink = await owner.createShareLink({ gadgetId: GADGET_ID });

    allowSnapshotSharing(impl, false);
    let refused = "Sharing gadget snapshots is disabled on this deployment by an administrator.";
    let refusal = await viewer.getGadgetSnapshot(GADGET_ID).catch((error: unknown) => error);
    expect(getSnapshotSharingErrorCode(refusal)).toBe(SNAPSHOT_SHARING_ERROR_CODES.disabled);
    await expect(owner.getGadgetSnapshot(GADGET_ID)).rejects.toThrow(refused);
    // An open snapshot keeps the copy it took, and takes no new one.
    await expect(snapshot.refresh()).rejects.toThrow(refused);
    expect(await snapshot.getRefreshedAt()).toEqual(takenAt);
    expect(snapshotNames(impl)).toHaveLength(1);

    // No view grant is made, nor is anyone narrowed to one: refused before anything is severed.
    // A view link mints no key a new recipient could redeem, while a live link still does.
    let grants = impl.storage.collaborators.get(VIEWER);
    let keys = Array.from(impl.storage.shareKeys.list());
    await expect(owner.addCollaborator("someone", view)).rejects.toThrow(refused);
    await expect(owner.createShareLink(view)).rejects.toThrow(refused);
    await expect(owner.newShareLinkKey(viewLink.linkId)).rejects.toThrow(refused);
    await expect(owner.removeCollaborator(VIEWER, [], GADGET_ID, true)).rejects.toThrow(refused);
    expect(impl.storage.collaborators.get(VIEWER)).toEqual(grants);
    expect(Array.from(impl.storage.shareKeys.list())).toEqual(keys);
    await owner.newShareLinkKey(useLink.linkId);
    expect(Array.from(impl.storage.shareKeys.list())).toHaveLength(keys.length + 1);

    // The view grant is kept, and opens what the gadget now holds once allowed again.
    expect(await viewer.isViewOnly(GADGET_ID)).toBe(true);
    await gadget.write("note", "later");
    allowSnapshotSharing(impl, true);
    using reopened = await viewer.getGadgetSnapshot(GADGET_ID);
    using copy = await reopened.connectToGadget();
    expect(await copy.read("note")).toBe("later");
  }));

  it("are deleted when disposed, and with their gadget", () => withImpl(workspace(), async impl => {
    await seedGadget(impl, GADGET_ID);
    using client = await openViewer(impl);
    let disposed = await client.getGadgetSnapshot(GADGET_ID);
    let copy = await disposed.connectToGadget();
    await copy.write("note", "viewer's edit");

    disposed[Symbol.dispose]();
    expect(snapshotNames(impl)).toEqual([]);
    // A stub that outlived its snapshot reaches nothing.
    await expectRejected(copy.read("note"));
    copy[Symbol.dispose]();

    using kept = await client.getGadgetSnapshot(GADGET_ID);
    expect(snapshotNames(impl)).toHaveLength(1);
    await impl.removeWorkpiece(GADGET_ID);
    expect(snapshotNames(impl)).toEqual([]);
    await expect(kept.connectToGadget()).rejects.toThrow("This snapshot is no longer available.");
  }));

  it("are deleted by the next instance, storage and all", async () => {
    let stub = workspace();
    let facetName = "";
    await withImpl(stub, async impl => {
      await seedGadget(impl, GADGET_ID);
      using gadget = await impl.getGadgetFacet(GADGET_ID);
      await gadget.write("note", "original");
      facetName = impl.createGadgetSnapshot(GADGET_ID).facetName;
      await impl.ctx.storage.sync();
    });
    await expect(runInDurableObject(stub, (_instance, ctx) => { ctx.abort("Injected reset"); }))
        .rejects.toThrow("Injected reset");

    await withImpl(env.TEST_OVERSEER.get(stub.id), async impl => {
      expect(snapshotNames(impl)).toEqual([]);
      // Re-recording it starts the facet afresh: its copied storage is gone.
      impl.storage.gadgetSnapshots.put({ facetName, gadgetId: GADGET_ID });
      using copy = impl.getSnapshotFacet({
        facetName, gadgetId: GADGET_ID, commitId: impl.getGadgetHead(GADGET_ID)!,
        refreshedAt: new Date(),
      });
      expect(await copy.read("note")).toBeNull();
    });
  });
});
