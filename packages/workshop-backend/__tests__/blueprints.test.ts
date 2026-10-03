import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Y from "yjs";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
} from "@earendil-works/pi-ai";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiChatMessage, ApplyBlueprintResult, BlueprintGadgetSummary,
  BlueprintMetadata, Overseer, WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import { runAgent } from "../src/agent";
import { buildCompactionState } from "../src/agent-compaction";
import {
  blueprintContentKey, buildBlueprintArchiveStream, parseBlueprintArchive,
} from "../src/blueprint-archive";
import {
  buildReleasePack, buildSnapshotRelease, encodeReleaseCommit, listReleaseFiles, readReleasePack,
  type GitObjectMap,
} from "../src/blueprint-release";
import {
  buildPackBytes, concatBytes, encodeGitCommit, encodeGitTree, gitObjectOid, parseGitCommitRefs,
} from "../src/git-codec";
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
const AGENT: AiChatAuthorInfo = { type: "agent", id: "some-model", name: "Agent" };

const V1 = { "client.js": "one\n", "lib/util.js": "export const answer = 42;\n" };
const V2 = { ...V1, "client.js": "two\n" };
const V3 = { ...V1, "client.js": "three\n" };

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
      getChatContext: async () => ({ profile: OWNER }),
      updateBlueprint: async () => false,  // not featured
      deleteBlueprint: async () => {},
      setGadgetLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    // Disposed with the session: the session holds a duplicate of the stub until then.
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
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

/**
 * Moves the head of the workspace's gadget to a new commit of `files`, adding gadget 1 first if
 * there is none. The commit merges the release `merged`, if given, as accepting an update from
 * its blueprint would.
 */
async function commitToGadget(impl: any, files: Record<string, string>, merged?: string)
    : Promise<string> {
  let [record] = [...impl.storage.gadgets.list()];
  let commitId = await commitFiles(
      impl, files, [...record ? [record.commitId] : [], ...merged ? [merged] : []]);
  impl.storage.gadgets.put(record
      ? { ...record, commitId }
      : { type: "gadget", id: 1, title: "App", created: new Date(0), bindingName: "APP",
          bindings: {}, commitId });
  return commitId;
}

/** Publishes the workspace's gadget, which is gadget 1 unless it was instantiated. */
async function createBlueprint(client: Overseer, title = "Starter", gadgetId = 1)
    : Promise<BlueprintGadgetSummary> {
  let gadget = await client.getGadget(gadgetId);
  return await gadget.createBlueprint(title, "A starter");
}

/** The parents of a commit in the workspace's store. */
async function parentsOf(impl: any, commitId: string): Promise<string[]> {
  return (await impl.gitStore.readCommitLog(commitId, { depth: 1 }))[0].parents;
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

/** The pack published for a release of a blueprint, as whoever reads it finds it. */
async function publishedPack(blueprintId: string, commitId: string): Promise<GitObjectMap> {
  return await readReleasePack(await storedContent(`${blueprintId}/${commitId}`), commitId);
}

function commitsIn(pack: GitObjectMap): string[] {
  return [...pack].filter(([, object]) => object.type === "commit").map(([oid]) => oid).toSorted();
}

/**
 * Publishes a blueprint of each of `versions` in turn, from a workspace of its own. Returns its
 * id, and the metadata that each publish left for readers to find.
 */
async function publishVersions(title: string, versions: Record<string, string>[])
    : Promise<{ blueprintId: string, published: BlueprintMetadata[] }> {
  let blueprintId: string | undefined;
  let published: BlueprintMetadata[] = [];
  await withWorkspace(async ({ impl, client }) => {
    for (let files of versions) {
      await commitToGadget(impl, files);
      if (blueprintId === undefined) {
        blueprintId = (await createBlueprint(client, title)).id;
      } else {
        await client.updateBlueprint(blueprintId, { updateCode: true });
      }
      published.push((await publishedMetadata(blueprintId))!);
    }
  });
  return { blueprintId: blueprintId!, published };
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

/**
 * The files of the workspace's one gadget and the release they came from: the one its head
 * merges into the gadget's own root.
 */
async function instantiated(impl: any)
    : Promise<{ files: Record<string, string>, release: string }> {
  let [gadget, ...others] = [...impl.storage.gadgets.list()];
  expect(others).toEqual([]);
  let files = Object.fromEntries(await impl.gitStore.readCommitFiles(gadget.commitId));
  let [root, release, ...more] = await parentsOf(impl, gadget.commitId);
  expect(more).toEqual([]);
  expect(await parentsOf(impl, root)).toEqual([]);
  expect(await impl.gitStore.commitTree(root)).toBe(EMPTY_TREE);
  return { files, release };
}

/** What a subscriber to the workspace's workpieces is told of them, by role. */
function summaries(impl: any, role: "build" | "use"): WorkpieceSummary[] {
  let entries: WorkpieceSummary[] = [];
  let subscriber: any = {
    dup: () => subscriber,
    onRpcBroken: () => {},
    entry: async (summary: WorkpieceSummary) => { entries.push(summary); },
    ready: async () => {},
    [Symbol.dispose]: () => {},
  };
  impl.subscribeToWorkpieces(subscriber, role === "build")[Symbol.dispose]();
  return entries;
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
    let release!: string;
    await withWorkspace(async ({ impl, client }) => {
      await commitToGadget(impl, V1);
      blueprintId = (await createBlueprint(client)).id;
      release = (await publishedMetadata(blueprintId))!.commitId!;
    });

    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, blueprintId);
      expect(await instantiated(impl)).toEqual({ files: V1, release });
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

  it("merges the release into a history of the gadget's own, and has it follow the blueprint",
      async () => {
    let blueprintId!: string;
    let release!: string;
    await withWorkspace(async ({ impl, client }) => {
      await commitToGadget(impl, V1);
      blueprintId = (await createBlueprint(client)).id;
      release = (await publishedMetadata(blueprintId))!.commitId!;
    });

    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, blueprintId);
      let [gadget] = [...impl.storage.gadgets.list()];

      // The head is the gadget owner's commit of the release's tree. Its first parent is the
      // gadget's own (empty) beginning, and the release comes second, so the gadget's
      // first-parent chain never runs into the blueprint's history.
      let [head] = await impl.gitStore.readCommitLog(gadget.commitId, { depth: 1 });
      let [root] = await impl.gitStore.readCommitLog(head.parents[0], { depth: 1 });
      expect(head).toMatchObject({
        parents: [root.oid, release],
        message: "Instantiate blueprint: Starter\n",
        author: { name: "Olive", email: "olive@commits.example" },
      });
      expect(await impl.gitStore.commitTree(head.oid))
          .toBe(await impl.gitStore.commitTree(release));
      expect(root).toMatchObject({ parents: [], message: "Create gadget: Starter\n" });
      expect(await impl.gitStore.commitTree(root.oid)).toBe(EMPTY_TREE);

      // Which blueprint the release belongs to is on the gadget, since no commit says.
      let upstream = { blueprintId, commitId: release };
      expect(gadget.upstream).toEqual(upstream);

      // Its builders are told, but not those who may only use it: the id is a link to code
      // they cannot read.
      expect(summaries(impl, "build")).toEqual([
        { id: gadget.id, type: "gadget", title: "Starter", commitId: head.oid, upstream },
      ]);
      expect(summaries(impl, "use")).toEqual([
        { id: gadget.id, type: "gadget", title: "Starter", commitId: head.oid },
      ]);
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
      expect(await instantiated(impl)).toEqual({ files: V1, release: read.commitId });
      expect(impl.storage.title.get()).toBe("Starter");
    });

    // Whoever starts now gets the new version.
    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, blueprintId);
      let { commitId } = (await publishedMetadata(blueprintId))!;
      expect(commitId).not.toBe(read.commitId);
      expect(await instantiated(impl)).toEqual({ files: V2, release: commitId });
      expect(impl.storage.title.get()).toBe("Restarted");
    });
  });

  it("builds a gadget from content stored before releases were commits", async () => {
    await storeBlueprint("older-content", metadataFor("Older"), await snapshotContent(V1));

    await withWorkspace(async ({ instance, impl }) => {
      await instantiate(instance, "older-content");

      // Every workspace reads the snapshot as the same release, so that is what each gadget
      // made from it has in its history, and in common with the others.
      let snapshot = await buildSnapshotRelease(new Map(Object.entries(V1)));
      expect(await instantiated(impl)).toEqual({ files: V1, release: snapshot.commitId });
      expect([...impl.storage.gadgets.list()][0].upstream)
          .toEqual({ blueprintId: "older-content", commitId: snapshot.commitId });
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

    let v1 = await buildSnapshotRelease(new Map(Object.entries(V1)));
    for (let [blueprintId, files, commitId] of [
      ["uploaded-v1", V1, v1.commitId], ["uploaded-v2", V2, release.commitId],
    ] as const) {
      await withWorkspace(async ({ instance, impl }) => {
        await instantiate(instance, blueprintId);
        expect(await instantiated(impl)).toEqual({ files, release: commitId });
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

describe("publishing a blueprint built on another", () => {
  // Bob's additions to the second version of Alice's files.
  const BOBS = { ...V2, "bob.js": "bob\n" };

  it("names the release it was built on as a parent, after a root of its own", async () => {
    let alice = await publishVersions("Alice's", [V1, V2]);
    let [a1, a2] = alice.published.map(metadata => metadata.commitId!);

    let bob!: string;
    let b2!: string;
    await withWorkspace(async ({ instance, impl, client }) => {
      // Bob builds on Alice's second release, and publishes what he made of it.
      await instantiate(instance, alice.blueprintId);
      let [gadget] = [...impl.storage.gadgets.list()];
      await commitToGadget(impl, BOBS);
      bob = (await createBlueprint(client, "Bob's", gadget.id)).id;

      let published = (await publishedMetadata(bob))!;
      let b1 = published.commitId!;
      expect(published.version).toBe(1);
      let [b0, ...merged] = await parentsOf(impl, b1);
      expect(merged).toEqual([a2]);

      // A release's first parent is always its own blueprint's, and Bob's had none to give.
      // So his lineage starts at an empty release of its own.
      expect((await impl.gitStore.readCommitLog(b0, { depth: 1 }))[0]).toMatchObject({
        parents: [],
        message: "Release 0: Bob's\n",
        author: { name: "Olive", email: "olive@commits.example" },
      });
      expect(await impl.gitStore.commitTree(b0)).toBe(EMPTY_TREE);

      // The pack holds the whole history, Alice's included, but nothing of the gadget's own.
      // Besides Bob's files it carries those of the release he built on: someone whose gadget
      // came from another of Alice's releases needs them to merge Bob's blueprint into it.
      let pack = await publishedPack(bob, b1);
      expect(commitsIn(pack)).toEqual([a1, a2, b0, b1].toSorted());
      expect(Object.fromEntries(listReleaseFiles(pack, b1))).toEqual(BOBS);
      expect(Object.fromEntries(listReleaseFiles(pack, a2))).toEqual(V2);
      expect(() => listReleaseFiles(pack, a1)).toThrow(/is missing/);

      // What Bob built on is in the history of his first release, so his second need not name
      // it again.
      await commitToGadget(impl, { ...BOBS, "bob.js": "bob again\n" });
      await client.updateBlueprint(bob, { updateCode: true });
      b2 = (await publishedMetadata(bob))!.commitId!;
      expect(await parentsOf(impl, b2)).toEqual([b1]);
    });

    // Carol builds on Bob's blueprint. She never read Alice's, but Bob's pack gave her the
    // files of the release he built on, and her own pack passes them on.
    await withWorkspace(async ({ instance, impl, client }) => {
      await instantiate(instance, bob);
      let [gadget] = [...impl.storage.gadgets.list()];
      let carol = (await createBlueprint(client, "Carol's", gadget.id)).id;

      let c1 = (await publishedMetadata(carol))!.commitId!;
      expect((await parentsOf(impl, c1)).slice(1)).toEqual([b2]);
      let pack = await publishedPack(carol, c1);
      expect(Object.fromEntries(listReleaseFiles(pack, b2)))
          .toEqual({ ...BOBS, "bob.js": "bob again\n" });
      expect(Object.fromEntries(listReleaseFiles(pack, a2))).toEqual(V2);
    });
  });

  it("names the releases its gadget has merged since the last, but none already in its history",
      async () => {
    let alice = await publishVersions("Alice's", [V1, V2, V3]);
    let [, a2, a3] = alice.published.map(metadata => metadata.commitId!);

    await withWorkspace(async ({ instance, impl, client }) => {
      // Bob builds on Alice's first release, and takes her second before he publishes.
      await instantiate(instance, alice.blueprintId, alice.published[0]);
      let [gadget] = [...impl.storage.gadgets.list()];
      await impl.loadBlueprint(alice.blueprintId, alice.published[1]);
      await commitToGadget(impl, BOBS, a2);
      let bob = (await createBlueprint(client, "Bob's", gadget.id)).id;

      // Her first is in the history of her second, so naming it too would say nothing.
      let b1 = (await publishedMetadata(bob))!.commitId!;
      expect((await parentsOf(impl, b1)).slice(1)).toEqual([a2]);

      // Taking her third leaves Bob's files as they were. It is still a release: whoever
      // follows Bob should learn that his blueprint now has her third in it.
      await impl.loadBlueprint(alice.blueprintId, alice.published[2]);
      await commitToGadget(impl, BOBS, a3);
      await client.updateBlueprint(bob, { updateCode: true });
      let second = (await publishedMetadata(bob))!;
      let b2 = second.commitId!;
      expect(second.version).toBe(2);
      expect(await parentsOf(impl, b2)).toEqual([b1, a3]);
      expect(await impl.gitStore.commitTree(b2)).toBe(await impl.gitStore.commitTree(b1));

      // Merging what the blueprint already has, here its own release, gives it nothing to add.
      await commitToGadget(impl, BOBS, b2);
      await client.updateBlueprint(bob, { updateCode: true });
      expect(await publishedMetadata(bob)).toMatchObject({ version: 2, commitId: b2 });
    });
  });
});

/** What publishVersions() returns. */
type Published = Awaited<ReturnType<typeof publishVersions>>;

/** Has readers find an earlier or later publish of a blueprint. Returns its release. */
function republish({ blueprintId, published }: Published, index: number): string {
  kv.set(blueprintId, JSON.stringify({ metadata: published[index] }));
  return published[index].commitId!;
}

async function apply(client: Overseer, gadgetId: number, blueprintId: string, options = {})
    : Promise<ApplyBlueprintResult> {
  using gadget = await client.getGadget(gadgetId);
  return await gadget.applyBlueprint(blueprintId, options);
}

/** Applies a blueprint to the workspace's gadget, which has to yield a proposal: its chat. */
async function propose(
    { impl, client }: Workspace, blueprintId: string, options = {}): Promise<number> {
  let result = await apply(client, theGadget(impl).id, blueprintId, options);
  if (result.outcome !== "proposed") throw new Error(`not proposed: ${result.outcome}`);
  return result.chatId;
}

function addChat(impl: any, id: number): void {
  impl.storage.chatMeta.put({ id, title: "Chat", started: new Date(0), lastActive: new Date(0) });
}

/** A chat in which the owner has asked the agent for something. */
function addUserChat(impl: any, id: number): void {
  addChat(impl, id);
  impl.storage.chats.put({
    chatId: id, sequence: impl.nextChatSequence(id), timestamp: new Date(0), author: OWNER,
    type: "message", message: "Make me a gadget.",
  });
}

/**
 * Runs one turn of the real agent in a chat, with a model that answers each step with the next
 * of `steps`.
 */
async function runScriptedTurn(
    impl: any, chatId: number, steps: ReturnType<typeof fauxAssistantMessage>[]): Promise<void> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  faux.setResponses(steps);
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, chatId, AGENT,
      new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
}

function theGadget(impl: any): any {
  let [gadget, ...others] = [...impl.storage.gadgets.list()];
  expect(others).toEqual([]);
  return gadget;
}

type ChangesMessage = AiChatMessage & { type: "changes" };

function changesMessages(impl: any, chatId: number): ChangesMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })]
      .filter(message => message.type === "changes");
}

/** The record of the proposal a chat was created for, and the message it is on. */
function proposal(impl: any, chatId: number) {
  let [message] = changesMessages(impl, chatId);
  let [merge, ...others] = message.blueprintMerges!;
  expect(others).toEqual([]);
  return { message, merge };
}

/** The gadget's files as a chat proposes them. */
async function proposedFiles(impl: any, chatId: number): Promise<Record<string, string>> {
  let content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId));
  return Object.fromEntries(content.get(theGadget(impl).id));
}

async function accept({ impl, client }: Workspace, chatId: number): Promise<any> {
  expect(await client.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  return theGadget(impl);
}

async function headFiles(impl: any): Promise<Record<string, string>> {
  return Object.fromEntries(await impl.gitStore.readCommitFiles(theGadget(impl).commitId));
}

// The gadget owner's own addition to whatever version of a blueprint's files they have.
const MINE = { "mine.js": "mine\n" };

/**
 * Builds the workspace's gadget as one from before gadgets recorded what they were made from:
 * an empty root, then `files`, then a change of the owner's. Returns the commit of `files`.
 */
async function legacyGadget(impl: any, files: Record<string, string>): Promise<string> {
  await commitToGadget(impl, {});
  let first = await commitToGadget(impl, files);
  await commitToGadget(impl, { ...files, ...MINE });
  return first;
}

/**
 * Publishes a release of the blueprint "unchained", whose every release stands alone, as the
 * bundled blueprints' do. Returns the release.
 */
async function publishUnchained(version: number, files: Record<string, string>): Promise<string> {
  await storeBlueprint("unchained", metadataFor("Unchained", { version }),
      await snapshotContent(files));
  return (await buildSnapshotRelease(new Map(Object.entries(files)))).commitId;
}

/** A binding as a blueprint declares it. */
function declaredBinding(title: string) {
  return {
    title, description: "", type: "gatekeeper" as const, gatekeeperName: "github",
    typeUrlPattern: "https://github.com/*",
  };
}

describe("applying a blueprint to a gadget", () => {

  it("proposes the next release in a new chat, and changes the gadget only on accept",
      async () => {
    let alice = await publishVersions("Alice's", [V1, V2]);
    let a1 = republish(alice, 0);

    await withWorkspace(async workspace => {
      let { instance, impl } = workspace;
      await instantiate(instance, alice.blueprintId);
      let before = theGadget(impl);
      let a2 = republish(alice, 1);

      // The gadget has no changes of its own, so its files simply become the new release's.
      let chatId = await propose(workspace, alice.blueprintId);
      let { message, merge } = proposal(impl, chatId);
      expect(merge).toEqual({
        gadgetId: before.id, blueprintId: alice.blueprintId, title: "Alice's", version: 2,
        commitId: a2, kind: "fastForward", baseCommit: a1, conflictPaths: [],
      });
      expect(message).toMatchObject({
        author: OWNER, pins: [{ gadgetId: before.id, baseCommit: before.commitId }],
      });
      expect(await proposedFiles(impl, chatId)).toEqual(V2);

      // It is a chat like any other, with changes to accept or discard and no message from
      // anyone. Until then the gadget is as it was, down to the blueprint release it follows.
      let meta = impl.chatMetaForClient(impl.storage.chatMeta.get(chatId));
      expect(meta).toMatchObject({
        title: "Update from blueprint: Alice's", proposedChangeWorkpieces: [before.id],
      });
      expect(meta.activeAgent).toBeUndefined();
      expect([...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })])
          .toEqual([message]);
      expect(theGadget(impl)).toEqual(before);

      // Accepting writes the merge into the gadget's history: its own previous state first,
      // then the release. That is what the next update will find to merge against.
      let after = await accept(workspace, chatId);
      expect(await parentsOf(impl, after.commitId)).toEqual([before.commitId, a2]);
      expect(await headFiles(impl)).toEqual(V2);
      expect(after.upstream).toEqual({ blueprintId: alice.blueprintId, commitId: a2 });

      expect(await apply(workspace.client, after.id, alice.blueprintId))
          .toEqual({ outcome: "upToDate" });
    });
  });

  it("merges a release into a gadget that has changes of its own, marking what conflicts",
      async () => {
    let alice = await publishVersions("Alice's", [V1, V2, V3]);
    let a1 = republish(alice, 0);

    await withWorkspace(async workspace => {
      let { instance, impl } = workspace;
      await instantiate(instance, alice.blueprintId);

      // The owner adds a file, and the blueprint changes another: both changes stand.
      let own = await commitToGadget(impl, { ...V1, ...MINE });
      let a2 = republish(alice, 1);
      let chatId = await propose(workspace, alice.blueprintId);
      expect(proposal(impl, chatId).merge).toMatchObject(
          { kind: "merge", commitId: a2, baseCommit: a1, conflictPaths: [] });
      expect(await proposedFiles(impl, chatId)).toEqual({ ...V2, ...MINE });
      let merged = await accept(workspace, chatId);
      expect(await parentsOf(impl, merged.commitId)).toEqual([own, a2]);

      // Now both change the same line of the same file. The base is the release just merged.
      await commitToGadget(impl, { ...V2, ...MINE, "client.js": "mine too\n" });
      let a3 = republish(alice, 2);
      chatId = await propose(workspace, alice.blueprintId);
      expect(proposal(impl, chatId).merge).toMatchObject(
          { kind: "merge", commitId: a3, baseCommit: a2, conflictPaths: ["client.js"] });
      expect(await proposedFiles(impl, chatId)).toEqual({
        ...V3, ...MINE,
        "client.js": "<<<<<<< this gadget\nmine too\n||||||| base\ntwo\n=======\nthree\n" +
            ">>>>>>> blueprint\n",
      });

      // Whether to accept a file with markers in it is the caller's to decide.
      let conflicted = await accept(workspace, chatId);
      expect(conflicted.upstream).toEqual({ blueprintId: alice.blueprintId, commitId: a3 });
      expect((await headFiles(impl))["client.js"]).toContain("<<<<<<< this gadget");
    });
  });

  it("merges a release that changes no file, so that the gadget's history has it", async () => {
    // Bob republishes Alice's first release as it is, under a blueprint of his own.
    let alice = await publishVersions("Alice's", [V1]);
    let a1 = republish(alice, 0);
    let bob!: string;
    await withWorkspace(async ({ instance, impl, client }) => {
      await instantiate(instance, alice.blueprintId);
      bob = (await createBlueprint(client, "Bob's", theGadget(impl).id)).id;
    });
    let b1 = (await publishedMetadata(bob))!.commitId!;

    await withWorkspace(async workspace => {
      let { instance, impl } = workspace;
      await instantiate(instance, alice.blueprintId);
      let own = await commitToGadget(impl, { ...V1, ...MINE });

      // Switching to Bob's blueprint changes nothing in the gadget's files...
      let chatId = await propose(workspace, bob);
      let { message, merge } = proposal(impl, chatId);
      expect(merge).toMatchObject({ kind: "follow", commitId: b1, baseCommit: a1 });
      expect(message.change).toBeUndefined();
      expect(message.pins).toEqual([{ gadgetId: merge.gadgetId, baseCommit: own }]);

      // ...but accepting still commits, with those files: Bob's next release will be merged
      // against this one, which only a gadget whose history has it can find.
      let after = await accept(workspace, chatId);
      expect(await parentsOf(impl, after.commitId)).toEqual([own, b1]);
      expect(await impl.gitStore.commitTree(after.commitId))
          .toBe(await impl.gitStore.commitTree(own));
      expect(after.upstream).toEqual({ blueprintId: bob, commitId: b1 });
    });
  });

  it("proposes only to follow a blueprint whose release the gadget already has", async () => {
    let alice = await publishVersions("Alice's", [V1, V2]);
    let a2 = republish(alice, 1);

    // The same release under another id, as uploading a download of the blueprint gives it.
    await storeBlueprint("copy", alice.published[1],
        await storedContent(`${alice.blueprintId}/${a2}`));

    // And Bob's blueprint, built on that release.
    let bob!: string;
    await withWorkspace(async ({ instance, impl, client }) => {
      await instantiate(instance, alice.blueprintId);
      await commitToGadget(impl, { ...V2, "bob.js": "bob\n" });
      bob = (await createBlueprint(client, "Bob's", theGadget(impl).id)).id;
    });
    let b1 = (await publishedMetadata(bob))!.commitId!;

    await withWorkspace(async workspace => {
      let { instance, impl, client } = workspace;
      await instantiate(instance, bob);
      let before = theGadget(impl);
      expect(before.upstream).toEqual({ blueprintId: bob, commitId: b1 });

      // The gadget took Alice's release by way of Bob's blueprint. Going back to following
      // hers merges nothing, pins nothing, and so can never go stale.
      for (let blueprintId of [alice.blueprintId, "copy"]) {
        let chatId = await propose(workspace, blueprintId);
        let { message, merge } = proposal(impl, chatId);
        expect(merge).toEqual({
          gadgetId: before.id, blueprintId, title: "Alice's", version: 2, commitId: a2,
          kind: "follow", conflictPaths: [],
        });
        expect(message.change).toBeUndefined();
        expect(message.pins).toBeUndefined();
        expect(impl.storage.chatMeta.get(chatId).codeBase).toBeUndefined();

        // The head moves on meanwhile, which a pinned proposal would have to catch up with.
        let head = await commitToGadget(impl, await headFiles(impl));

        // Accepting changes which blueprint the gadget follows, and nothing else.
        let after = await accept(workspace, chatId);
        expect(after)
            .toEqual({ ...before, commitId: head, upstream: { blueprintId, commitId: a2 } });
        expect(await apply(client, before.id, blueprintId)).toEqual({ outcome: "upToDate" });
      }

      // The gadget is up to date only with the blueprint it follows, though it holds the
      // current release of all three.
      expect((await apply(client, before.id, alice.blueprintId)).outcome).toBe("proposed");

      // Such a proposal is nothing but its record in the log, which is where accepting finds
      // it, even after the agent's history has been compacted past it.
      let chatId = await propose(workspace, bob);
      let messages = [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
      let compactedTo = messages.at(-1)!.sequence + 1;
      impl.commitChatCompaction(chatId, {
        chatId, compactedTo, summary: "summary",
        ...buildCompactionState(messages, compactedTo, [], undefined),
      });
      expect((await accept(workspace, chatId)).upstream)
          .toEqual({ blueprintId: bob, commitId: b1 });
    });
  });

  it("finds the release two blueprints have in common to merge against", async () => {
    // The plan's picture: Bob built on Alice's second release, and Carol's gadget is from her
    // third.
    let alice = await publishVersions("Alice's", [V1, V2, V3]);
    let a2 = republish(alice, 1);
    let bob!: string;
    const BOBS = { ...V2, "bob.js": "bob\n" };
    await withWorkspace(async ({ instance, impl, client }) => {
      await instantiate(instance, alice.blueprintId);
      await commitToGadget(impl, BOBS);
      bob = (await createBlueprint(client, "Bob's", theGadget(impl).id)).id;
    });
    let b1 = (await publishedMetadata(bob))!.commitId!;
    republish(alice, 2);

    await withWorkspace(async workspace => {
      let { instance, impl, client } = workspace;
      await instantiate(instance, alice.blueprintId);
      let c1 = await commitToGadget(impl, { ...V3, ...MINE });

      // A pack of Bob's release that leaves out the files of the release he built on, as one
      // made by hand might. Carol's gadget has that release in its history but never held its
      // files, so there is nothing to merge against.
      let thin = await publishedPack(bob, b1);
      thin.delete(await impl.gitStore.commitTree(a2));
      await storeBlueprint("thin", (await publishedMetadata(bob))!,
          concatBytes(await buildPackBytes([...thin.values()])));
      expect(await apply(client, theGadget(impl).id, "thin"))
          .toEqual({ outcome: "baseUnavailable" });
      expect([...impl.storage.chatMeta.list()]).toEqual([]);

      // Bob's own pack carries them. Against that release, Alice's later change to
      // client.js is Carol's change and Bob's addition is his.
      let chatId = await propose(workspace, bob);
      expect(proposal(impl, chatId).merge).toMatchObject(
          { kind: "merge", commitId: b1, baseCommit: a2, conflictPaths: [] });
      expect(await proposedFiles(impl, chatId)).toEqual({ ...V3, ...MINE, "bob.js": "bob\n" });

      let after = await accept(workspace, chatId);
      expect(await parentsOf(impl, after.commitId)).toEqual([c1, b1]);
      expect(after.upstream).toEqual({ blueprintId: bob, commitId: b1 });
    });
  });

  it("chooses among several releases in common: the blueprint's own, else the latest",
      async () => {
    // Releases made by hand, to say when each was published: `seconds` after the epoch.
    let objects: GitObjectMap = new Map();
    let release = async (files: Record<string, string>, parents: string[], seconds: number) => {
      let snapshot = await buildSnapshotRelease(new Map(Object.entries(files)));
      let { tree } = parseGitCommitRefs(snapshot.objects.get(snapshot.commitId)!.payload);
      snapshot.objects.delete(snapshot.commitId);
      for (let [oid, object] of snapshot.objects) objects.set(oid, object);
      let payload = encodeReleaseCommit({
        tree, parents, author: { name: "Olive", email: "olive@example.com" }, title: "By hand",
        version: 1, timestamp: new Date(seconds * 1000),
      });
      let commitId = await gitObjectOid("commit", payload);
      objects.set(commitId, { type: "commit", payload });
      return commitId;
    };
    let publish = async (blueprintId: string, commitId: string) => await storeBlueprint(
        blueprintId, metadataFor(blueprintId, { commitId }),
        await buildReleasePack(oid => objects.get(oid), commitId));

    // Two blueprints that each merged the other's first release, and a third built on both.
    let x1 = await release({ "x.js": "x\n" }, [], 200);
    let y1 = await release({ "y.js": "y\n" }, [], 100);
    let both = { "x.js": "x\n", "y.js": "y\n" };
    let x2 = await release(both, [x1, y1], 300);
    let y2 = await release({ ...both, "y2.js": "y2\n" }, [y1, x1], 300);
    let z1 = await release({ ...both, "z.js": "z\n" }, [await release({}, [], 300), x1, y1], 400);
    await publish("x", x2);
    await publish("y", y2);
    await publish("z", z1);

    await withWorkspace(async workspace => {
      let { instance, impl } = workspace;
      await instantiate(instance, "x");

      // The gadget's history and each of the others share x1 and y1, neither of which holds
      // the other. Of the two, y1 is a release of the blueprint being applied, though the
      // older. Neither is a release of z's, which leaves the later.
      expect(proposal(impl, await propose(workspace, "y")).merge.baseCommit).toBe(y1);
      expect(proposal(impl, await propose(workspace, "z")).merge.baseCommit).toBe(x1);
    });
  });

  it("merges a followed blueprint's unchained releases against the one last taken", async () => {
    let r1 = await publishUnchained(1, V1);

    await withWorkspace(async workspace => {
      let { instance, impl } = workspace;
      await instantiate(instance, "unchained");
      await commitToGadget(impl, { ...V1, ...MINE });

      // Nothing in the commits connects one release to the next, but they are published
      // under the id the gadget follows. So each is merged against the one before, with no
      // warning either time.
      let previous = r1;
      for (let [version, files] of [[2, V2], [3, V3]] as const) {
        let release = await publishUnchained(version, files);
        let chatId = await propose(workspace, "unchained");
        let { merge } = proposal(impl, chatId);
        expect(merge).toMatchObject({ kind: "merge", commitId: release, baseCommit: previous });
        expect(merge.unverifiedBase).toBeUndefined();
        expect((await accept(workspace, chatId)).upstream)
            .toEqual({ blueprintId: "unchained", commitId: release });
        expect(await headFiles(impl)).toEqual({ ...files, ...MINE });
        previous = release;
      }
    });
  });

  it("assumes a base for a gadget with no history in common, if the caller allows it",
      async () => {
    let alice = await publishVersions("Alice's", [V1, V2]);

    await withWorkspace(async workspace => {
      let { impl, client } = workspace;
      let first = await legacyGadget(impl, V3);
      let before = theGadget(impl);

      // Nothing says these files came from this blueprint. The first the gadget had are the
      // best guess at what it started from, and the caller has to accept that it is one.
      expect(await apply(client, before.id, alice.blueprintId)).toEqual({ outcome: "unrelated" });
      expect([...impl.storage.chatMeta.list()]).toEqual([]);

      let chatId = await propose(workspace, alice.blueprintId, { allowUnrelated: true });
      expect(proposal(impl, chatId).merge).toMatchObject(
          { kind: "merge", baseCommit: first, unverifiedBase: true, conflictPaths: [] });
      expect(await proposedFiles(impl, chatId)).toEqual({ ...V2, ...MINE });

      // Once accepted, the gadget follows the blueprint and its history holds the release.
      let after = await accept(workspace, chatId);
      expect(after.upstream)
          .toEqual({ blueprintId: alice.blueprintId, commitId: alice.published[1].commitId });
      expect(await apply(client, before.id, alice.blueprintId)).toEqual({ outcome: "upToDate" });
    });

    // A gadget whose first files are exactly a release of the blueprint did start from it.
    await withWorkspace(async workspace => {
      let first = await legacyGadget(workspace.impl, V1);
      let chatId = await propose(workspace, alice.blueprintId);
      let { merge } = proposal(workspace.impl, chatId);
      expect(merge).toMatchObject({ kind: "merge", baseCommit: first });
      expect(merge.unverifiedBase).toBeUndefined();
      expect(await proposedFiles(workspace.impl, chatId)).toEqual({ ...V2, ...MINE });
    });

    // And one with no files has nothing that a wrong guess could undo.
    await withWorkspace(async workspace => {
      let root = await commitToGadget(workspace.impl, {});
      let chatId = await propose(workspace, alice.blueprintId);
      let { merge } = proposal(workspace.impl, chatId);
      expect(merge).toMatchObject({ kind: "fastForward", baseCommit: root });
      expect(merge.unverifiedBase).toBeUndefined();
    });
  });

  it("records the bindings the release declares that the gadget lacks", async () => {
    let bindings = {
      HAS: declaredBinding("Has"), LACKS: declaredBinding("Lacks"),
      FEEDS_SPAWNER: { ...declaredBinding("Feeds a spawner"), spawnerOnly: true as const },
    };
    let pack = await buildSnapshotRelease(new Map(Object.entries(V1)));
    await storeBlueprint("bound", metadataFor("Bound", { commitId: pack.commitId, bindings }),
        concatBytes(await buildPackBytes([...pack.objects.values()])));

    await withWorkspace(async workspace => {
      let { impl } = workspace;
      await commitToGadget(impl, V1);
      impl.storage.gadgets.put({ ...theGadget(impl), bindings: { HAS: { target: 99 } } });

      let chatId = await propose(workspace, "bound");
      expect(proposal(impl, chatId).merge.missingBindings).toEqual({ LACKS: bindings.LACKS });

      // A gadget the agent creates from the blueprint starts with none of them.
      expect((await impl.fetchBlueprint("bound")).merge.missingBindings)
          .toEqual({ HAS: bindings.HAS, LACKS: bindings.LACKS });
    });
  });

  it("withdraws a proposal that is reverted or whose chat is deleted", async () => {
    let alice = await publishVersions("Alice's", [V1, V2]);
    republish(alice, 0);

    await withWorkspace(async workspace => {
      let { instance, impl, client } = workspace;
      await instantiate(instance, alice.blueprintId);
      let before = theGadget(impl);
      republish(alice, 1);

      // Reverted, the proposal is gone from what accepting the chat accepts, pin and all.
      let chatId = await propose(workspace, alice.blueprintId);
      await client.revertChanges(chatId, 0);
      expect(impl.storage.chatMeta.get(chatId).codeBase.pins).toEqual([]);
      expect(await accept(workspace, chatId)).toEqual(before);

      // A chat deleted with its proposal still in it takes the proposal along.
      chatId = await propose(workspace, alice.blueprintId);
      await client.deleteChat(chatId);
      expect(theGadget(impl)).toEqual(before);

      // Neither stands in the way of proposing it again.
      chatId = await propose(workspace, alice.blueprintId);
      expect((await accept(workspace, chatId)).upstream)
          .toEqual({ blueprintId: alice.blueprintId, commitId: alice.published[1].commitId });
    });
  });

  it("makes a stale proposal catch up with the gadget before it is accepted", async () => {
    let alice = await publishVersions("Alice's", [V1, V2]);
    republish(alice, 0);

    await withWorkspace(async workspace => {
      let { instance, impl, client } = workspace;
      await instantiate(instance, alice.blueprintId);
      let a2 = republish(alice, 1);
      let chatId = await propose(workspace, alice.blueprintId);

      // The gadget moves on before the proposal is accepted.
      let moved = await commitToGadget(impl, { ...V1, ...MINE });
      expect(await client.mergeChanges(chatId)).toEqual({ outcome: "stale" });
      expect(theGadget(impl).upstream.commitId).not.toBe(a2);

      await client.updateChatFromMainline(chatId);
      let after = await accept(workspace, chatId);
      expect(await parentsOf(impl, after.commitId)).toEqual([moved, a2]);
      expect(await headFiles(impl)).toEqual({ ...V2, ...MINE });
    });
  });

  it("splits a merge too large for one message by file", async () => {
    let large = Object.fromEntries(["a", "b", "c"].map(
        name => [`${name}.js`, `// ${name}\n`.repeat(100_000)]));
    let alice = await publishVersions("Alice's", [V1, { ...V2, ...large }]);
    republish(alice, 0);

    await withWorkspace(async workspace => {
      let { instance, impl } = workspace;
      await instantiate(instance, alice.blueprintId);
      republish(alice, 1);
      let chatId = await propose(workspace, alice.blueprintId);

      // The first message records the proposal and the pin that its change and the rest apply
      // over, and says how many messages directly after it hold the rest. No file's change is
      // divided between two messages.
      let messages = changesMessages(impl, chatId);
      expect(messages.length).toBeGreaterThan(1);
      expect(proposal(impl, chatId).merge.messageCount).toBe(messages.length);
      expect(messages.map(message => message.sequence))
          .toEqual(messages.map((_, index) => messages[0].sequence + index));
      expect(messages.map(message => message.blueprintMerges?.length ?? 0))
          .toEqual([1, ...messages.slice(1).map(() => 0)]);
      expect(messages.map(message => message.pins?.length ?? 0))
          .toEqual([1, ...messages.slice(1).map(() => 0)]);
      let paths = messages.flatMap(
          message => Object.values(message.change!).flat().map(([path]) => path));
      expect(paths.toSorted()).toEqual(["a.js", "b.js", "c.js", "client.js"]);

      await accept(workspace, chatId);
      expect(await headFiles(impl)).toEqual({ ...V2, ...large });
    });
  });

  it("refuses a gadget still pending in a chat, and a blueprint that does not exist",
      async () => {
    let alice = await publishVersions("Alice's", [V1]);
    await withWorkspace(async ({ impl, client }) => {
      await commitToGadget(impl, V1);
      await expect(apply(client, 1, "no-such-blueprint")).rejects.toThrow("Blueprint not found.");

      addChat(impl, 7);
      let pending = impl.createGadget("Pending", "PENDING", 7);
      await expect(apply(client, pending.id, alice.blueprintId))
          .rejects.toThrow(/provisional creation in a chat/);
      expect([...impl.storage.chatMeta.list()].map(meta => meta.id)).toEqual([7]);
    });
  });

  it("records the release a gadget the agent creates is made from, for its first accept",
      async () => {
    let alice = await publishVersions("Alice's", [V1]);
    let a1 = republish(alice, 0);

    await withWorkspace(async ({ impl, client }) => {
      addUserChat(impl, 1);
      await runScriptedTurn(impl, 1, [
        fauxAssistantMessage([fauxToolCall("createGadget",
            { title: "Made", bindingName: "MADE", blueprintId: alice.blueprintId })],
            { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("writeFile",
            { workpiece: "MADE", filename: "client.js", content: "the agent's own\n" })],
            { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxText("Done.")),
      ]);
      let created = theGadget(impl);
      expect(created.pending).toBeDefined();
      expect(proposal(impl, 1).merge).toEqual({
        gadgetId: created.id, blueprintId: alice.blueprintId, title: "Alice's", version: 1,
        commitId: a1, kind: "fastForward", conflictPaths: [],
      });

      // Accepting the creation gives the gadget what one instantiated outside a chat is born
      // with: a root of its own, the release merged into it, and the blueprint to follow. Its
      // first commit already holds whatever the agent went on to change.
      expect(await client.mergeChanges(1)).toEqual({ outcome: "merged" });
      let gadget = theGadget(impl);
      expect(gadget.pending).toBeUndefined();
      let [root, release, ...more] = await parentsOf(impl, gadget.commitId);
      expect([release, ...more]).toEqual([a1]);
      expect(await parentsOf(impl, root)).toEqual([]);
      expect(await impl.gitStore.commitTree(root)).toBe(EMPTY_TREE);
      expect(await headFiles(impl)).toEqual({ ...V1, "client.js": "the agent's own\n" });
      expect(gadget.upstream).toEqual({ blueprintId: alice.blueprintId, commitId: a1 });
    });
  });

  it("records no release for a gadget whose copy of the blueprint's files failed", async () => {
    // More than one agent step may change, so the copy that createGadget makes cannot land.
    let large = Object.fromEntries(["a", "b"].map(
        name => [`${name}.js`, `// ${name}\n`.repeat(100_000)]));
    let alice = await publishVersions("Alice's", [large]);

    await withWorkspace(async workspace => {
      let { impl, client } = workspace;
      addUserChat(impl, 1);
      await runScriptedTurn(impl, 1, [
        fauxAssistantMessage([fauxToolCall("createGadget",
            { title: "Made", bindingName: "MADE", blueprintId: alice.blueprintId })],
            { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxText("Done.")),
      ]);
      let [call] = [...impl.storage.chats.list({ prefix: `${keyString(1)}.` })]
          .flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
      expect(call).toMatchObject({ toolName: "createGadget" });
      expect(call.error).toMatch(/Too many code changes in one step/);

      // The call still leaves the gadget it created, with no files. Nothing says it was made
      // from the release, so accepting it does not put the release in its history...
      expect(changesMessages(impl, 1).flatMap(message => message.blueprintMerges ?? []))
          .toEqual([]);
      expect(await client.mergeChanges(1)).toEqual({ outcome: "merged" });
      let gadget = theGadget(impl);
      expect(await parentsOf(impl, gadget.commitId)).toEqual([]);
      expect(await headFiles(impl)).toEqual({});
      expect(gadget.upstream).toBeUndefined();

      // ...and the blueprint can still be applied to it, files and all.
      let chatId = await propose(workspace, alice.blueprintId);
      expect(proposal(impl, chatId).merge.kind).toBe("fastForward");
      expect(await proposedFiles(impl, chatId)).toEqual(large);
    });
  });
});
