import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import type {
  AiChatAuthorInfo, BlueprintGadgetSummary, BlueprintMetadata, Overseer,
} from "@gadgets/workshop-shared/api";
import {
  blueprintContentKey, buildBlueprintArchiveStream, parseBlueprintArchive,
} from "../src/blueprint-archive";
import { buildSnapshotRelease, listReleaseFiles, readReleasePack } from "../src/blueprint-release";
import { buildPackBytes, concatBytes, encodeGitCommit, encodeGitTree, gitObjectOid }
  from "../src/git-codec";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { parseBlueprintKvRecord } from "../src/storage-schema/blueprints-kv";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// Exercises publishing a blueprint as a chain of release commits, and reading one back to
// instantiate it, against the real Overseer in workerd over real storage, a real git object
// store and the pool's R2 bucket. The owner's user DO is faked, and so is the KV namespace
// (below). Each test gets fresh Durable Objects and its own blueprint ids.

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = {
  type: "user", id: "olive@example.com", name: "Olive", commitEmail: "olive@commits.example",
};

const V1 = { "client.js": "one\n", "lib/util.js": "export const answer = 42;\n" };
const V2 = { ...V1, "client.js": "two\n" };
const V3 = { ...V1, "client.js": "three\n" };

// Stands in for the BLUEPRINTS namespace, which the suites' Worker does not bind. Given a real
// one, the agent turns other suites run read the deployment's admin config from it, which the
// spans agent-tracing.test.ts expects do not survive.
const kv = new Map<string, string>();
const BLUEPRINTS = {
  get: async (key: string) => kv.get(key) ?? null,
  put: async (key: string, value: string) => { kv.set(key, value); },
  delete: async (key: string) => { kv.delete(key); },
} as unknown as KVNamespace;

interface Workspace {
  instance: OverseerDurableObject;
  impl: any;
  client: Overseer;

  /** The fake user DO standing in for the workspace's owner. */
  owner: { updateBlueprint: (...args: unknown[]) => Promise<boolean> };
}

let counter = 0;

// Opens the real OverseerClientInterface (as the owner, build role) over a fresh Overseer. The
// owner id is planted directly rather than going through open()'s first-open initialization,
// and the two open()-time side effects that call out to the owner's user DO are stubbed.
async function withWorkspace(fn: (workspace: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`blueprints-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.env = { ...impl.env, BLUEPRINTS };
    impl.ownerId = OWNER_USER_ID;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => OWNER,
      updateBlueprint: async () => false,  // not featured
      deleteBlueprint: async () => {},
      setGadgetLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    let client = await instance.open(
        OWNER_USER_ID, OWNER.id, new NativeRpcStub<() => void>(() => {}));
    await fn({ instance, impl, client, owner });
  });
}

async function commitFiles(
    impl: any, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents,
    author: { name: "Carl Collaborator", email: "carl@example.com" },
    message: "Accept chat: a private chat title",
    timestamp: new Date(1700000000_000),
  });
}

/** Adds gadget 1 with `files` committed, or moves its head to a new commit of them. */
async function commitToGadget(impl: any, files: Record<string, string>): Promise<string> {
  let record = impl.storage.gadgets.get(1);
  let commitId = await commitFiles(impl, files, record ? [record.commitId] : []);
  impl.storage.gadgets.put(record
      ? { ...record, commitId }
      : { type: "gadget", id: 1, title: "App", created: new Date(0), bindingName: "APP",
          bindings: {}, commitId });
  return commitId;
}

async function createBlueprint(client: Overseer, title = "Starter")
    : Promise<BlueprintGadgetSummary> {
  let gadget = await client.getGadget(1);
  return await gadget.createBlueprint(title, "A starter");
}

async function publishedMetadata(blueprintId: string): Promise<BlueprintMetadata | undefined> {
  let raw = kv.get(blueprintId);
  return raw === undefined ? undefined : parseBlueprintKvRecord(raw).metadata;
}

async function storedKeys(blueprintId: string): Promise<string[]> {
  let listing = await env.BLUEPRINT_CONTENT.list({ prefix: `${blueprintId}/` });
  return listing.objects.map(object => object.key).toSorted();
}

async function storedContent(key: string): Promise<Uint8Array> {
  let object = await env.BLUEPRINT_CONTENT.get(key);
  if (object === null) throw new Error(`no content at ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

/** Stores a blueprint as publishing or importing would: content first, then metadata. */
async function storeBlueprint(
    blueprintId: string, metadata: BlueprintMetadata, content: Uint8Array): Promise<void> {
  await env.BLUEPRINT_CONTENT.put(blueprintContentKey(blueprintId, metadata), content);
  kv.set(blueprintId, JSON.stringify({ metadata }));
}

function metadataFor(title: string, extra: Partial<BlueprintMetadata> = {}): BlueprintMetadata {
  return {
    title, description: "", author: OWNER, created: new Date(0), version: 1,
    lastUpdated: new Date(0), bindings: {}, ...extra,
  };
}

/** Content in the form blueprints took before releases were commits. */
async function snapshotContent(files: Record<string, string>): Promise<Uint8Array> {
  let doc = new Y.Doc();
  let map = doc.getMap<Y.Text>();
  for (let [path, text] of Object.entries(files)) map.set(path, new Y.Text(text));
  let compressed = new Response(Y.encodeStateAsUpdateV2(doc) as BufferSource).body!
      .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

/** A `.gadget` archive of `content`, as downloading the blueprint would build it. */
function archiveOf(metadata: BlueprintMetadata, content: Uint8Array): ReadableStream<Uint8Array> {
  return buildBlueprintArchiveStream(
      metadata, new Response(content as BufferSource).body!, content.byteLength);
}

/** The archive, with the container version in its header replaced. */
async function withArchiveVersion(archive: ReadableStream<Uint8Array>, version: number)
    : Promise<ReadableStream<Uint8Array>> {
  let bytes = new Uint8Array(await new Response(archive).arrayBuffer());
  new DataView(bytes.buffer).setUint32(8, version);
  return new Response(bytes).body!;
}

async function archiveVersion(archive: ReadableStream<Uint8Array>): Promise<number> {
  return new DataView(await new Response(archive).arrayBuffer()).getUint32(8);
}

/** Does what importing an archive does with it (see AuthenticatedApi.importBlueprint). */
async function uploadArchive(blueprintId: string, archive: ReadableStream<Uint8Array>)
    : Promise<BlueprintMetadata> {
  let { metadata, contentLength, content } = await parseBlueprintArchive(archive);
  let bytes = new Uint8Array(await new Response(content).arrayBuffer());
  expect(bytes.byteLength).toBe(contentLength);
  await storeBlueprint(blueprintId, metadata, bytes);
  return metadata;
}

/**
 * Instantiates a blueprint in the workspace as AuthenticatedApi.newGadgetFromBlueprint() has the
 * Overseer do it: from the metadata that it read, which is what is published unless given.
 */
async function instantiate(
    instance: OverseerDurableObject, blueprintId: string, metadata?: BlueprintMetadata)
    : Promise<void> {
  await instance.initializeFromBlueprint(
      blueprintId, metadata ?? (await publishedMetadata(blueprintId))!);
}

/** The files of the workspace's one gadget, with the commit that holds them. */
async function instantiated(impl: any)
    : Promise<{ files: Record<string, string>, parents: string[] }> {
  let [gadget, ...others] = [...impl.storage.gadgets.list()];
  expect(others).toEqual([]);
  let files = Object.fromEntries(await impl.gitStore.readCommitFiles(gadget.commitId));
  let [{ parents }] = await impl.gitStore.readCommitLog(gadget.commitId, { depth: 1 });
  return { files, parents };
}

// Publishes V2 as the blueprint's second release, but for a failure that leaves the record dirty
// and the first release published, as if the upload of the second's content had failed. Returns
// that content, the key it belongs under, and the record.
async function failUpdate(
    impl: any, client: Overseer, owner: Workspace["owner"], blueprintId: string)
    : Promise<{ key: string, sent: Uint8Array, record: any }> {
  await commitToGadget(impl, V2);
  let updateBlueprint = owner.updateBlueprint;
  owner.updateBlueprint = async () => { throw new Error("user DO unreachable"); };
  await expect(client.updateBlueprint(blueprintId, { updateCode: true }))
      .rejects.toThrow("user DO unreachable");
  owner.updateBlueprint = updateBlueprint;

  expect((await publishedMetadata(blueprintId))!.version).toBe(1);
  let record = impl.storage.blueprints.get(blueprintId);
  expect(record).toMatchObject({ dirty: true, metadata: { version: 2 } });
  let key = `${blueprintId}/${record.metadata.commitId}`;
  let sent = await storedContent(key);
  await env.BLUEPRINT_CONTENT.delete(key);
  return { key, sent, record };
}

describe("publishing a blueprint", () => {
  it("mints a release per version of the code, each the parent of the next",
      () => withWorkspace(async ({ impl, client }) => {
    let source1 = await commitToGadget(impl, V1);
    let blueprint = await createBlueprint(client);
    expect(blueprint.version).toBe(1);

    let first = (await publishedMetadata(blueprint.id))!;
    let release1 = first.commitId!;
    expect(first.version).toBe(1);
    expect(await storedKeys(blueprint.id)).toEqual([`${blueprint.id}/${release1}`]);

    // The release is a commit of its own. It takes the gadget's tree, but nothing of its
    // history, whose messages and authors are not the publisher's to share.
    let [commit] = await impl.gitStore.readCommitLog(release1, { depth: 1 });
    expect(commit).toMatchObject({
      parents: [],
      message: "Release 1: Starter\n",
      author: { name: "Olive", email: "olive@commits.example" },
    });
    expect(await impl.gitStore.commitTree(release1)).toBe(await impl.gitStore.commitTree(source1));
    let pack1 = await readReleasePack(await storedContent(`${blueprint.id}/${release1}`), release1);
    expect(Object.fromEntries(listReleaseFiles(pack1, release1))).toEqual(V1);
    expect(pack1.has(source1)).toBe(false);

    let source2 = await commitToGadget(impl, V2);
    await client.updateBlueprint(blueprint.id, { updateCode: true });

    let second = (await publishedMetadata(blueprint.id))!;
    let release2 = second.commitId!;
    expect(second.version).toBe(2);
    expect(release2).not.toBe(release1);
    expect((await impl.gitStore.readCommitLog(release2, { depth: 1 }))[0]).toMatchObject({
      parents: [release1],
      message: "Release 2: Starter\n",
    });

    // The pack carries the release's files and its whole history, but no older release's files.
    let pack2 = await readReleasePack(await storedContent(`${blueprint.id}/${release2}`), release2);
    expect(Object.fromEntries(listReleaseFiles(pack2, release2))).toEqual(V2);
    expect([...pack2].filter(([, object]) => object.type === "commit").map(([oid]) => oid)
        .toSorted()).toEqual([release1, release2].toSorted());
    expect(pack2.has(await impl.gitStore.commitTree(release1))).toBe(false);

    // The earlier release stays where an instantiation already under way will look for it.
    expect(await storedKeys(blueprint.id))
        .toEqual([`${blueprint.id}/${release1}`, `${blueprint.id}/${release2}`].toSorted());

    expect(impl.storage.blueprints.get(blueprint.id)).toMatchObject({
      commitId: source2,
      releases: [
        { version: 1, releaseCommit: release1, sourceCommit: source1 },
        { version: 2, releaseCommit: release2, sourceCommit: source2 },
      ],
    });
  }));

  it("mints nothing when the code has not changed since the last release",
      () => withWorkspace(async ({ impl, client }) => {
    let source = await commitToGadget(impl, V1);
    let blueprint = await createBlueprint(client);
    let before = (await publishedMetadata(blueprint.id))!;

    // A new head, but of the same files: say, a change that was then undone.
    await commitToGadget(impl, V2);
    expect(await commitToGadget(impl, V1)).not.toBe(source);
    await client.updateBlueprint(blueprint.id, { updateCode: true, title: "Renamed" });

    // The rest of the update still goes out.
    let after = (await publishedMetadata(blueprint.id))!;
    expect(after).toMatchObject({ title: "Renamed", version: 1, commitId: before.commitId });
    expect(await storedKeys(blueprint.id)).toEqual([`${blueprint.id}/${before.commitId}`]);
    expect(impl.storage.blueprints.get(blueprint.id)).toMatchObject({
      commitId: source,
      releases: [{ version: 1, releaseCommit: before.commitId, sourceCommit: source }],
      dirty: false,
    });
  }));

  it("chains the first release of an older record to the snapshot it published",
      () => withWorkspace(async ({ impl, client }) => {
    // A record as publishing wrote it before releases were commits, with the content it stored.
    let source = await commitToGadget(impl, V1);
    let metadata = metadataFor("Older", { version: 3 });
    impl.storage.blueprints.put({ id: "older-record", metadata, gadgetId: 1, commitId: source });
    await storeBlueprint("older-record", metadata, await snapshotContent(V1));

    // The code is unchanged, but this release is what replaces the snapshot with a pack.
    await client.updateBlueprint("older-record", { updateCode: true });

    let published = (await publishedMetadata("older-record"))!;
    let release = published.commitId!;
    expect(published.version).toBe(4);

    // Its parent is the release that everyone who read the snapshot derived from it.
    let snapshot = await buildSnapshotRelease(new Map(Object.entries(V1)));
    expect((await impl.gitStore.readCommitLog(release, { depth: 1 }))[0]).toMatchObject({
      parents: [snapshot.commitId],
      message: "Release 4: Older\n",
    });
    let pack = await readReleasePack(await storedContent(`older-record/${release}`), release);
    expect(pack.has(snapshot.commitId)).toBe(true);
    expect(impl.storage.blueprints.get("older-record").releases)
        .toEqual([{ version: 4, releaseCommit: release, sourceCommit: source }]);

    // From here on it is a chain like any other.
    await commitToGadget(impl, V2);
    await client.updateBlueprint("older-record", { updateCode: true });
    let next = (await publishedMetadata("older-record"))!.commitId!;
    expect((await impl.gitStore.readCommitLog(next, { depth: 1 }))[0].parents).toEqual([release]);
  }));

  it("re-sends the identical pack when a failed publish is retried",
      () => withWorkspace(async ({ impl, client, owner }) => {
    await commitToGadget(impl, V1);
    let blueprint = await createBlueprint(client);
    let { key, sent, record } = await failUpdate(impl, client, owner, blueprint.id);

    // The gadget has moved on since, but the retry publishes what the update was publishing.
    await commitToGadget(impl, V3);
    await client.retryBlueprintPublish(blueprint.id);

    expect(await storedContent(key)).toEqual(sent);
    expect(await publishedMetadata(blueprint.id))
        .toMatchObject({ version: 2, commitId: record.metadata.commitId });
    expect(impl.storage.blueprints.get(blueprint.id))
        .toMatchObject({ dirty: false, releases: record.releases });
  }));

  it("re-sends the pack of a failed publish with the next update, though it mints nothing",
      () => withWorkspace(async ({ impl, client, owner }) => {
    await commitToGadget(impl, V1);
    let blueprint = await createBlueprint(client);
    let { key, sent, record } = await failUpdate(impl, client, owner, blueprint.id);

    // Otherwise the metadata published here would name a release whose content never arrived.
    await client.updateBlueprint(blueprint.id, { updateCode: true });

    expect(await storedContent(key)).toEqual(sent);
    expect(await publishedMetadata(blueprint.id))
        .toMatchObject({ version: 2, commitId: record.metadata.commitId });
    expect(impl.storage.blueprints.get(blueprint.id))
        .toMatchObject({ dirty: false, releases: record.releases });
  }));

  it("refuses to retry a record that has no release to re-send",
      () => withWorkspace(async ({ impl, client }) => {
    let source = await commitToGadget(impl, V1);
    impl.storage.blueprints.put({
      id: "older-dirty", metadata: metadataFor("Older"), gadgetId: 1, commitId: source,
      dirty: true,
    });
    await expect(client.retryBlueprintPublish("older-dirty")).rejects.toThrow(/older format/);
  }));

  it("deletes every version of the content, in either form",
      () => withWorkspace(async ({ impl, client }) => {
    await commitToGadget(impl, V1);
    let blueprint = await createBlueprint(client);
    await commitToGadget(impl, V2);
    await client.updateBlueprint(blueprint.id, { updateCode: true });
    await env.BLUEPRINT_CONTENT.put(`${blueprint.id}/1`, await snapshotContent(V1));
    expect(await storedKeys(blueprint.id)).toHaveLength(3);

    // Another blueprint's content, under an id this one's is a prefix of.
    await env.BLUEPRINT_CONTENT.put(`${blueprint.id}0/1`, "other");

    await client.deleteBlueprint(blueprint.id);

    expect(await storedKeys(blueprint.id)).toEqual([]);
    expect(await storedKeys(`${blueprint.id}0`)).toEqual([`${blueprint.id}0/1`]);
    expect(await publishedMetadata(blueprint.id)).toBeUndefined();
    expect(impl.storage.blueprints.get(blueprint.id)).toBeUndefined();
  }));

  it("lets the owner delete every version of an orphaned blueprint's content", async () => {
    let stub = env.TEST_USER.getByName(`blueprints-${++counter}`);
    let metadata = metadataFor("Orphan", { version: 2, commitId: "a".repeat(40) });
    await env.BLUEPRINT_CONTENT.put("orphan/1", await snapshotContent(V1));
    await env.BLUEPRINT_CONTENT.put(blueprintContentKey("orphan", metadata), "pack");
    kv.set("orphan", JSON.stringify({ metadata, ownerId: stub.id.toString() }));

    await runInDurableObject(stub, async (user: UserDurableObject) => {
      let internals = user as unknown as { env: Cloudflare.Env };
      internals.env = { ...internals.env, BLUEPRINTS };
      await user.deleteOwnedBlueprint("orphan");
    });

    expect(await storedKeys("orphan")).toEqual([]);
    expect(await publishedMetadata("orphan")).toBeUndefined();
  });
});

describe("instantiating a blueprint", () => {
  it("builds a gadget from a release's files", async () => {
    let blueprintId!: string;
    await withWorkspace(async ({ impl, client }) => {
      await commitToGadget(impl, V1);
      blueprintId = (await createBlueprint(client)).id;
    });

    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, blueprintId);
      expect(await instantiated(impl)).toEqual({ files: V1, parents: [] });
      expect(impl.storage.title.get()).toBe("Starter");
    });

    // The agent's path reads the same release.
    await withWorkspace(async ({ impl }) => {
      let { files, notes } = await impl.fetchBlueprint(blueprintId);
      expect({ ...files }).toEqual(V1);
      expect(notes).toContain(`"Starter" (blueprintId ${blueprintId})`);
      expect(notes).toContain("client.js, lib/util.js");
    });
  });

  it("builds a gadget from the version its metadata was read at, though a newer one is published",
      async () => {
    let blueprintId!: string;
    let read!: BlueprintMetadata;
    await withWorkspace(async ({ impl, client }) => {
      await commitToGadget(impl, V1);
      blueprintId = (await createBlueprint(client)).id;

      // Someone starts instantiating the blueprint, and has read this much when it is
      // republished under a new title.
      read = (await publishedMetadata(blueprintId))!;
      await commitToGadget(impl, V2);
      await client.updateBlueprint(blueprintId, { updateCode: true, title: "Restarted" });
    });
    expect(await publishedMetadata(blueprintId))
        .toMatchObject({ version: 2, title: "Restarted" });

    // They get the code that goes with what they read, which is what the bindings they are about
    // to set up were declared for.
    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, blueprintId, read);
      expect(await instantiated(impl)).toEqual({ files: V1, parents: [] });
      expect(impl.storage.title.get()).toBe("Starter");
    });

    // Whoever starts now gets the new version.
    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, blueprintId);
      expect(await instantiated(impl)).toEqual({ files: V2, parents: [] });
      expect(impl.storage.title.get()).toBe("Restarted");
    });
  });

  it("builds a gadget from content stored before releases were commits", async () => {
    await storeBlueprint("older-content", metadataFor("Older"), await snapshotContent(V1));

    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, "older-content");
      expect(await instantiated(impl)).toEqual({ files: V1, parents: [] });

      // Every workspace reads the snapshot as the same release.
      let snapshot = await buildSnapshotRelease(new Map(Object.entries(V1)));
      expect(impl.gitCache.hasLocalObject(snapshot.commitId)).toBe(true);
    });

    await withWorkspace(async ({ impl }) => {
      expect({ ...(await impl.fetchBlueprint("older-content")).files }).toEqual(V1);
    });
  });

  it("builds a gadget from an uploaded archive of either version", async () => {
    // A snapshot travels as version 1, the only version there was before releases were commits.
    let snapshot = await snapshotContent(V1);
    expect(await archiveVersion(archiveOf(metadataFor("Older"), snapshot))).toBe(1);
    let uploaded = await uploadArchive("uploaded-v1", archiveOf(metadataFor("Older"), snapshot));
    expect(uploaded.commitId).toBeUndefined();
    expect(await storedKeys("uploaded-v1")).toEqual(["uploaded-v1/1"]);

    // A release travels as version 2, and is stored under the commit its metadata names.
    let release!: BlueprintMetadata;
    let pack!: Uint8Array;
    await withWorkspace(async ({ impl, client }) => {
      await commitToGadget(impl, V2);
      let { id } = await createBlueprint(client);
      release = (await publishedMetadata(id))!;
      pack = await storedContent(`${id}/${release.commitId}`);
    });
    expect(await archiveVersion(archiveOf(release, pack))).toBe(2);
    uploaded = await uploadArchive("uploaded-v2", archiveOf(release, pack));
    expect(uploaded.commitId).toBe(release.commitId);
    expect(await storedKeys("uploaded-v2")).toEqual([`uploaded-v2/${release.commitId}`]);

    for (let [blueprintId, files] of [["uploaded-v1", V1], ["uploaded-v2", V2]] as const) {
      await withWorkspace(async ({ instance, impl }) => {
        await instantiate(instance, blueprintId);
        expect(await instantiated(impl)).toEqual({ files, parents: [] });
      });
    }
  });

  it("refuses an archive whose version and metadata disagree about its content", async () => {
    let content = new TextEncoder().encode("content");
    let commitId = "a".repeat(40);
    let parse = async (version: number, metadata: BlueprintMetadata) =>
        (await parseBlueprintArchive(
            await withArchiveVersion(archiveOf(metadata, content), version))).metadata;

    // A snapshot is not a release, whatever its metadata says.
    expect((await parse(1, metadataFor("Claims", { commitId }))).commitId).toBeUndefined();

    // And a release must name its commit, as an object id and nothing else.
    expect((await parse(2, metadataFor("Names", { commitId }))).commitId).toBe(commitId);
    for (let bad of [undefined, "main", [commitId], `${commitId}/../x`]) {
      await expect(parse(2, { ...metadataFor("Bad"), commitId: bad as string }))
          .rejects.toThrow(/does not name its release commit|Invalid git object id/);
    }

    await expect(parse(3, metadataFor("Future", { commitId })))
        .rejects.toThrow("Unsupported gadget archive version: 3.");
  });

  it("refuses content that is not a valid release, and leaves no gadget behind", async () => {
    // A well-formed pack of a commit whose tree holds something a gadget's cannot: an
    // executable. It is stored as an upload would store it, unexamined.
    let blob = { type: "blob" as const, payload: new TextEncoder().encode("#!/bin/sh\n") };
    let tree = { type: "tree" as const, payload: encodeGitTree([
      { mode: "100755", name: "run.sh", oid: await gitObjectOid("blob", blob.payload) },
    ]) };
    let signature = {
      name: "Mallory", email: "mallory@example.com", timestamp: new Date(0), utcOffsetMinutes: 0,
    };
    let commit = { type: "commit" as const, payload: encodeGitCommit({
      tree: await gitObjectOid("tree", tree.payload), parents: [], author: signature,
      committer: signature, message: "Release 1: Trap",
    }) };
    let commitId = await gitObjectOid("commit", commit.payload);
    let pack = concatBytes(await buildPackBytes([commit, tree, blob]));
    await storeBlueprint("invalid-pack", metadataFor("Trap", { commitId }), pack);

    // A pack that is not the one its metadata names, and metadata with no content at all.
    await storeBlueprint("wrong-pack", metadataFor("Swap", { commitId: "b".repeat(40) }), pack);
    kv.set("no-content", JSON.stringify({ metadata: metadataFor("Lost", { commitId }) }));

    // A snapshot is held to the same rules as a pack.
    await storeBlueprint("invalid-snapshot", metadataFor("Older trap"),
        await snapshotContent({ ".git/config": "[core]\n" }));

    await withWorkspace(async ({ instance, impl }) => {
      for (let [blueprintId, error] of [
        ["invalid-pack", /invalid blueprint release: .*unsupported mode 100755/],
        ["wrong-pack", /invalid blueprint release: commit b{40} is missing/],
        ["invalid-snapshot", /invalid blueprint release: .*reserved name "\.git"/],
        ["no-content", /content of blueprint no-content is missing/],
      ] as const) {
        await expect(instantiate(instance, blueprintId)).rejects.toThrow(error);
      }
      await expect(impl.fetchBlueprint("invalid-pack")).rejects.toThrow(/unsupported mode 100755/);
      await expect(impl.fetchBlueprint("no-such-blueprint")).rejects.toThrow(/No such blueprint/);

      // Nothing was instantiated, and none of the refused objects reached the store.
      expect([...impl.storage.gadgets.list()]).toEqual([]);
      expect(impl.defaultGadgetId).toBeUndefined();
      expect([...impl.storage.gitObjects.list()]).toEqual([]);
    });
  });
});
