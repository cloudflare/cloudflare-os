// A published blueprint's whole record is in its publisher's User DO, which serves it through
// listOwnBlueprints() and subscribeToOwnBlueprints(), with whether its gadget has changes to
// release, pushed there by the workspace as the gadget's head moves. Runs against real DOs.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { expect, it, vi } from "vitest";
import type { BlueprintUserSummary, Overseer, OwnBlueprintsSubscriber } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];

// Stands in for the BLUEPRINTS namespace, which the suites' Worker does not bind.
const kv = new Map<string, string>();
const BLUEPRINTS = {
  get: async (key: string) => kv.get(key) ?? null,
  put: async (key: string, value: string) => { kv.set(key, value); },
  delete: async (key: string) => { kv.delete(key); },
} as unknown as KVNamespace;

class OwnBlueprints extends RpcTarget implements OwnBlueprintsSubscriber {
  readonly snapshots: BlueprintUserSummary[][] = [];
  readonly updates: [string, BlueprintUserSummary | null][] = [];
  async snapshot(blueprints: BlueprintUserSummary[]) { this.snapshots.push(blueprints); }
  async updated(blueprintId: string, blueprint: BlueprintUserSummary | null) { this.updates.push([blueprintId, blueprint]); }
}

const commit = async (impl: Impl, files: Record<string, string>) => {
  let record = impl.storage.gadgets.get(1);
  let commitId = await impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: record?.type === "gadget" && record.commitId ? [record.commitId] : [],
    author: {name: "Olive", email: "olive@example.com"},
    message: "Keep",
    timestamp: new Date(1700000000_000),
  });
  impl.storage.gadgets.put(record?.type === "gadget" ? {...record, commitId}
    : {type: "gadget", id: 1, title: "App", created: new Date(0), bindingName: "APP", bindings: {}, commitId});
};

// An owner with one workspace, opened by them, whose gadget 1 has committed files, given to `fn`
// while the session is open.
const withPublisher = async (fn: (fixture: {
  user: DurableObjectStub<UserDurableObject>; client: Overseer; workspaceId: string;
  inWorkspace: <T>(act: (impl: Impl) => Promise<T> | T) => Promise<T>;
}) => Promise<void>) => {
  const id = crypto.randomUUID();
  const user = env.TEST_USER.getByName(id);
  await runInDurableObject(user, (_instance, ctx) =>
    makeUserStorage(ctx.storage).profile.put({type: "user", id, name: "Olive"}));
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = stub.id.toString();
  await user.newWorkspace(workspaceId, "Workspace");
  await user.setWorkspaceLastActive(workspaceId, new Date(), undefined);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = instance.impl;
    impl.env = {...impl.env, BLUEPRINTS};
    impl.ensureAmbientCapsules = async () => {};
    await commit(impl, {"client.js": "one\n"});
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(user.id.toString(), id, notifyClosed);
    // A stub of the account made here: one made outside can't be used inside the workspace's DO.
    await fn({user: env.TEST_USER.get(user.id), client, workspaceId, inWorkspace: act => act(impl)});
  });
};

// What the account's record of a blueprint says of its changes.
const changes = async (user: DurableObjectStub<UserDurableObject>, blueprintId: string) =>
  (await user.getBlueprint(blueprintId))?.unpublishedChanges;

it("lists the user's own blueprints with their whole record", () => withPublisher(async ({user, client, workspaceId}) => {
  const {id} = await (await client.getGadget(1)).createBlueprint("Starter", "A starter");
  const published = JSON.parse(kv.get(id)!).metadata;
  const [own] = await user.listBlueprints();
  expect(own).toMatchObject({id, title: "Starter", version: 1,
    source: {type: "workspace", workspaceId, workspaceTitle: "Workspace"}});
  expect(JSON.parse(JSON.stringify(own.metadata))).toEqual(published);
  expect(own.unpublishedChanges).toBeUndefined();
}));

it("names the gadget a blueprint is published from, an old record's being the default gadget",
    () => withPublisher(async ({user, client, inWorkspace, workspaceId}) => {
  const {id, gadgetId} = await (await client.getGadget(1)).createBlueprint("Starter", "A starter");
  expect(gadgetId).toBe(1);
  expect((await user.getBlueprint(id))?.source).toEqual({type: "workspace", workspaceId, workspaceTitle: "Workspace", gadgetId: 1});

  // Records from before either side stored it: the workspace's resolves to its default gadget,
  // and the account's is brought it when the workspace pushes its changes on the owner's open.
  await runInDurableObject(user, (_instance, ctx) => {
    const blueprints = makeUserStorage(ctx.storage).blueprints;
    const {workpieceId: _gone, ...old} = blueprints.get(id)!;
    blueprints.put(old);
  });
  expect((await user.getBlueprint(id))?.source).not.toHaveProperty("gadgetId");
  await inWorkspace(impl => {
    const {gadgetId: _gone, ...old} = impl.storage.blueprints.get(id)!;
    impl.storage.blueprints.put(old);
    impl.storage.defaultGadgetId.put(1);
    impl.defaultGadgetId = 1;
    impl.resyncListingTo(impl.ownerId!);
  });
  expect((await client.listBlueprints()).map(({id, gadgetId}) => [id, gadgetId])).toEqual([[id, 1]]);
  await vi.waitFor(async () => expect((await user.getBlueprint(id))?.source).toMatchObject({gadgetId: 1}));
}));

it("flips a blueprint's changes in its publisher's account as its gadget's head moves, and clears them on release",
    () => withPublisher(async ({user, client, inWorkspace, workspaceId}) => {
  const {id} = await (await client.getGadget(1)).createBlueprint("Starter", "A starter");
  const own = new OwnBlueprints();
  using ownCallback = new RpcStub(own);
  using _own = await user.subscribeToOwnBlueprints(ownCallback);
  await vi.waitFor(() => expect(own.snapshots.map(blueprints => blueprints.map(({id}) => id))).toEqual([[id]]));

  await inWorkspace(impl => commit(impl, {"client.js": "two\n"}));
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({code: true}));
  await vi.waitFor(() => expect(own.updates.at(-1)).toMatchObject([id, {unpublishedChanges: {code: true}, version: 1}]));

  using failedPublish = vi.spyOn(BLUEPRINTS, "put").mockRejectedValueOnce(new Error("KV unavailable"));
  await expect(client.updateBlueprint(id, {updateCode: true})).rejects.toThrow("KV unavailable");
  expect(failedPublish).toHaveBeenCalledTimes(1);
  await inWorkspace(async impl => {
    // Cross the deferred projection's scheduling boundary before checking the flag.
    impl.resyncListingTo(impl.ownerId!);
    await scheduler.wait(50);
  });
  expect(await changes(user, id)).toEqual({code: true});
  expect(JSON.parse(kv.get(id)!).metadata.version).toBe(1);

  await client.updateBlueprint(id, {updateCode: true});
  await vi.waitFor(async () => expect(await changes(user, id)).toBeUndefined());
  await vi.waitFor(() => {
    const [, latest] = own.updates.at(-1)!;
    expect(latest).toMatchObject({version: 2});
    expect(latest!.unpublishedChanges).toBeUndefined();
  });

  await inWorkspace(impl => commit(impl, {"client.js": "three\n"}));
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({code: true}));
  await user.workspaceRemoved(workspaceId);
  await vi.waitFor(() => {
    expect(own.updates.at(-1)).toMatchObject([id, {source: {type: "deletedWorkspace"}}]);
    expect(own.updates.at(-1)?.[1]?.unpublishedChanges).toBeUndefined();
  });
  expect((await user.listBlueprints())[0]?.unpublishedChanges).toBeUndefined();

  await client.deleteBlueprint(id);
  await vi.waitFor(() => expect(own.updates.at(-1)).toEqual([id, null]));
}));

// Gives gadget 1 these bindings, each to a connection made here if it is not yet.
const bind = (impl: Impl, bindings: Record<string, {target: number, annotation?: {title: string, description: string}}>) => {
  for (let {target} of Object.values(bindings)) {
    if (impl.storage.gatekeepers.get(target)) continue;
    impl.storage.gatekeepers.put({id: target, resourceTitle: `Connection ${target}`, class: {} as never,
      creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: `https://example.com/${target}`,
        typeUrlPattern: "https://*"}});
  }
  setBindings(impl, Object.fromEntries(Object.entries(bindings).map(([name, {target, annotation}]) =>
    [name, {target, ...annotation && {blueprintAnnotation: annotation}}])));
};

const setBindings = (impl: Impl, bindings: GadgetRecord["bindings"]) => {
  const record = impl.storage.gadgets.get(1);
  if (record?.type !== "gadget") throw new Error("Gadget 1 is not there.");
  impl.storage.gadgets.put({...record, bindings});
};

it("flags a gadget's binding changes apart from its code, which releasing either clears",
    () => withPublisher(async ({user, client, inWorkspace}) => {
  await inWorkspace(impl => bind(impl, {DOCS: {target: 100}}));
  const {id} = await (await client.getGadget(1)).createBlueprint("Starter", "A starter");
  expect(await changes(user, id)).toBeUndefined();

  // A rename alone is a change to the bindings, not the code.
  await inWorkspace(impl => bind(impl, {NOTES: {target: 100}}));
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({bindings: true}));
  expect((await client.listBlueprints())[0]?.unpublishedChanges).toEqual({bindings: true});

  await client.updateBlueprint(id, {updateBindings: true});
  await vi.waitFor(async () => expect(await changes(user, id)).toBeUndefined());
  expect(Object.keys(JSON.parse(kv.get(id)!).metadata.bindings)).toEqual(["NOTES"]);

  // So are rebinding it and giving it a note.
  await inWorkspace(impl => bind(impl, {NOTES: {target: 101}}));
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({bindings: true}));
  await client.updateBlueprint(id, {updateBindings: true});
  await vi.waitFor(async () => expect(await changes(user, id)).toBeUndefined());
  await inWorkspace(impl => bind(impl, {NOTES: {target: 101, annotation: {title: "Notes", description: "Where they go"}}}));
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({bindings: true}));

  // A code release takes the bindings with it.
  await inWorkspace(impl => commit(impl, {"client.js": "two\n"}));
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({code: true, bindings: true}));
  await client.updateBlueprint(id, {updateCode: true});
  await vi.waitFor(async () => expect(await changes(user, id)).toBeUndefined());
}));

it("flags the bindings when a connection a binding names changes, an agent spawner's own bindings among them",
    () => withPublisher(async ({user, client, inWorkspace}) => {
  // The spawner's bindings are published as bindings of the blueprint, under the gadget's edge.
  await inWorkspace(impl => {
    bind(impl, {DOCS: {target: 100}});
    impl.storage.gatekeepers.put({id: 7, resourceTitle: "Spawner", class: {} as never,
      creationSpec: {type: "agentSpawner", config: {displayName: "Helper", modelId: null}},
      bindings: {DOCS: {target: 100}}});
    setBindings(impl, {...(impl.storage.gadgets.get(1) as GadgetRecord).bindings, HELPER: {target: 7}});
  });
  const {id} = await (await client.getGadget(1)).createBlueprint("Starter", "A starter");
  expect(await changes(user, id)).toBeUndefined();

  // Only the spawner's record changes: no gadget edge, head or blueprint is written.
  await inWorkspace(impl => {
    impl.storage.gatekeepers.put({...impl.storage.gatekeepers.get(7)!, bindings: {NOTES: {target: 100}}});
  });
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({bindings: true}));
  await client.updateBlueprint(id, {updateBindings: true});
  await vi.waitFor(async () => expect(await changes(user, id)).toBeUndefined());

  // So does a connection's spec, which the blueprint describes it by.
  await inWorkspace(impl => {
    const record = impl.storage.gatekeepers.get(100)!;
    impl.storage.gatekeepers.put({...record, creationSpec: {type: "gatekeeper", vendorId: "testvendor",
      resourceUrl: "https://example.com/100", typeUrlPattern: "https://example.com/*"}});
  });
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({bindings: true}));
}));

it("counts bindings that cannot be collected as no binding changes, and still flags the code",
    () => withPublisher(async ({user, client, inWorkspace}) => {
  const {id} = await (await client.getGadget(1)).createBlueprint("Starter", "A starter");
  await inWorkspace(async impl => {
    // A connection from before blueprints, with no creation spec to describe it by.
    impl.storage.gatekeepers.put({id: 100, resourceTitle: "Legacy", class: {} as never});
    setBindings(impl, {LEGACY: {target: 100}});
    await commit(impl, {"client.js": "two\n"});
  });
  await vi.waitFor(async () => expect(await changes(user, id)).toEqual({code: true}));
  expect((await client.listBlueprints())[0]?.unpublishedChanges).toEqual({code: true});
}));
