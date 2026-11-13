// A static snapshot (Overseer.getGadgetSnapshot) is a copy of a gadget's facet storage, served by
// the gadget's code with nothing the gadget can reach: no env, and no use of capabilities the gadget
// stored. Since it reaches nothing, a "use" viewer opens one without observer verification, but
// only for a gadget their live access includes. Writes stay on their own side of the copy, a
// refresh takes a new one, and a copy is deleted with its session, its gadget, or the instance.
//
// Runs real gadget code, loaded from a real commit, inside a real OverseerDurableObject; a forged
// UseOverseerInterface (openFakeOverseer) delegates to it, and gatekeeper facets and User DOs are
// the only fakes.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  GadgetSnapshotClient, Overseer, PermissionEdge, PresenceParticipant,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
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

async function withImpl(stub: DurableObjectStub<OverseerDurableObject>,
                        fn: (impl: Impl) => Promise<void>): Promise<void> {
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field with its real type.)
    let impl = instance["impl"];
    impl.ownerProfileId = OWNER;
    await fn(impl);
  });
}

// Gadget `id` running SERVER_JS, shared with the viewer unless `shared` is false, and binding
// connection `target` when given.
async function seedGadget(impl: Impl, id: number,
                          opts: { shared?: boolean, target?: number } = {}): Promise<void> {
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
    { type: "user", sharer: OWNER, created: new Date(0), role: "use", gadgetId: id },
  ];
  impl.storage.collaborators.put({ profile: { id: VIEWER, name: "Viewer" }, addedBy });
}

// A "use" session whose access check and snapshots are the real impl's.
function openViewer(impl: Impl): Promise<Overseer> {
  return openFakeOverseer(
      { gadgets: impl.storage.gadgets, gadgetSnapshots: impl.storage.gadgetSnapshots },
      { role: "use", access: { role: "use", gadgetIds: "all" }, impl: {
        gitCache: impl.gitCache,
        mayOpenGadget: (...args: Parameters<Impl["mayOpenGadget"]>) => impl.mayOpenGadget(...args),
        authorizeGadget: (...args: Parameters<Impl["authorizeGadget"]>) => impl.authorizeGadget(...args),
        createGadgetSnapshot: (id: number) => impl.createGadgetSnapshot(id),
        deleteGadgetSnapshot: (facetName: string) => impl.deleteGadgetSnapshot(facetName),
        getSnapshotFacet: (...args: Parameters<Impl["getSnapshotFacet"]>) =>
            impl.getSnapshotFacet(...args),
        gadgetRequiresAccounts: (id: number) => impl.gadgetRequiresAccounts(id),
        joinSnapshotView: (profileId: string) => impl.joinSnapshotView(profileId),
        getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
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

  it("open for a gadget the viewer's access includes without verifying anyone, and no other", () =>
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
    await seedGadget(impl, 3);
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

    // The Workshop opens a gadget as a snapshot by default when its connections require accounts.
    expect(await client.gadgetRequiresAccounts(GADGET_ID)).toBe(true);
    expect(await client.gadgetRequiresAccounts(3)).toBe(false);
    await expect(client.gadgetRequiresAccounts(2)).rejects.toThrow("No such gadget: 2");
    expect(observed).toEqual([]);

    // Exactly the error a missing gadget gets.
    await expect(client.getGadgetSnapshot(2)).rejects.toThrow("No such gadget: 2");
    await expect(client.getGadgetSnapshot(999)).rejects.toThrow("No such gadget: 999");

    // A refresh re-reads live access, so one revoked since keeps the copy already taken.
    impl.storage.collaborators.delete(VIEWER);
    await expect(snapshot.refresh()).rejects.toThrow(`No such gadget: ${GADGET_ID}`);
    expect(snapshotNames(impl)).toHaveLength(1);
  }));

  it.each(["bound", "historical"] as const)(
      "open snapshots of gadgets with a %s legacy connection, but refuse live admission", source =>
      withImpl(workspace(), async impl => {
    impl.storage.gatekeepers.put({
      id: 7, resourceTitle: "Legacy connection", class: fakeGatekeeperClass,
    });
    await seedGadget(impl, GADGET_ID, source === "bound" ? { target: 7 } : {});
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

    expect(await client.gadgetRequiresAccounts(GADGET_ID)).toBe(true);
    await expect(client.getGadget(GADGET_ID)).rejects.toThrow();
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();
    using snapshot = await client.getGadgetSnapshot(GADGET_ID);
    using copy = await snapshot.connectToGadget();
    expect(await copy.read("note")).toBe("cached data");
  }));

  it("opens account-free gadgets live despite an unrelated legacy connection", () =>
      withImpl(workspace(), async impl => {
    impl.storage.gatekeepers.put({
      id: 7, resourceTitle: "Legacy connection", class: fakeGatekeeperClass,
    });
    impl.storage.gatekeepers.put({
      id: 8, resourceTitle: "Model", class: fakeGatekeeperClass,
      creationSpec: {
        type: "aiModel", modelId: "model", provider: "anthropic", modelName: "claude",
      },
    });
    await seedGadget(impl, GADGET_ID, { target: 8 });
    await seedGadget(impl, 2, { target: 7, shared: false });
    using client = await openViewer(impl);

    expect(await client.gadgetRequiresAccounts(GADGET_ID)).toBe(false);
    let user = impl.users.get(impl.users.idFromName(VIEWER));
    expect(await impl.authorizeGadget(VIEWER, user, GADGET_ID)).toBe(true);
    expect(impl.storage.observers.get(VIEWER)).toBeUndefined();
  }));

  it("requires accounts only after a simulated connection's creation is approved", () =>
      withImpl(workspace(), async impl => {
    impl.storage.gatekeepers.put({
      id: 7, resourceTitle: "Connection", class: fakeGatekeeperClass,
      creationSpec: { type: "gatekeeper", vendorId: "testvendor", typeUrlPattern: "https://*" },
    });
    await seedGadget(impl, GADGET_ID, { target: 7 });
    let id = impl.storage.nextActionId.get();
    impl.storage.nextActionId.put(id + 1);
    impl.storage.actions.put({
      id, gatekeeperId: 7, caller: { from: "agent", chatId: 1 }, createdAt: new Date(0),
      state: "pending", type: "action", action: "create",
      description: {
        title: "Create connection", description: "Create resource", implementsRevert: false,
        autoApprovable: false,
      },
    });
    using client = await openViewer(impl);

    expect(await client.gadgetRequiresAccounts(GADGET_ID)).toBe(false);
    let creation = impl.storage.actions.get(id)!;
    creation.state = "approved";
    impl.storage.actions.put(creation);
    expect(await client.gadgetRequiresAccounts(GADGET_ID)).toBe(true);
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

  it("show in their viewer's presence until the last one is disposed", () =>
      withImpl(workspace(), async impl => {
    await seedGadget(impl, GADGET_ID);
    let roster = new Map<string, PresenceParticipant>();
    let subscriber = {
      dup: () => subscriber,
      onRpcBroken: () => {},
      [Symbol.dispose]: () => {},
      init: async (list: PresenceParticipant[]) => { for (let p of list) roster.set(p.key, p); },
      add: async (p: PresenceParticipant) => { roster.set(p.key, p); },
      remove: async (key: string) => { roster.delete(key); },
    };
    using _subscription = impl.addPresenceSubscriber(subscriber as never);
    let leave = impl.joinPresence(VIEWER, { type: "user", id: VIEWER, name: "Viewer" }, "use");
    let viewing = () => Array.from(roster.values(), p => p.viewingSnapshot);
    expect(viewing()).toEqual([false]);

    using client = await openViewer(impl);
    let first = await client.getGadgetSnapshot(GADGET_ID);
    let second = await client.getGadgetSnapshot(GADGET_ID);
    expect(viewing()).toEqual([true]);
    await first.refresh();
    first[Symbol.dispose]();
    expect(viewing()).toEqual([true]);
    second[Symbol.dispose]();
    expect(viewing()).toEqual([false]);
    leave();
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
