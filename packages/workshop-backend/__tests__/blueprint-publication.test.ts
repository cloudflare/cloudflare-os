// A blueprint the deployment ships may publish the workspaces created from it by default: the
// creation path (newWorkspaceFromBlueprint) against a real Overseer, its owner's User DO and the
// space that lists it, with the blueprint store faked and two bundled entries added to the ones
// this Worker was built with. Which blueprint is trusted, and that the space is told of the
// publication with the workspace's first registration, are what is tested here.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as Y from "yjs";
import {
  slugify, type AiChatAuthorInfo, type BlueprintMetadata, type Overseer,
} from "@gadgets/workshop-shared/api";
import { buildBlueprintArchiveStream, parseBlueprintArchive } from "../src/blueprint-archive.js";
import {
  fromApiOptions, newWorkspaceFromBlueprint, type BlueprintInstantiationOptions,
} from "../src/blueprint-instantiation.js";
import type { BundledBlueprint } from "../src/generated/bundled-blueprints.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
import type { BlueprintKvRecord } from "../src/storage-schema/blueprints-kv.js";
import { makeUserStorage, type GadgetRecord } from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// Two bundled blueprints besides the ones this Worker was built with: one that publishes the
// workspaces created from it at "use", and one that declares no publication.
const BUNDLED = vi.hoisted(() => ({ published: "test.published", plain: "test.plain" }));
vi.mock("../src/generated/bundled-blueprints.js", async importOriginal => {
  let original = await importOriginal<typeof import("../src/generated/bundled-blueprints.js")>();
  // Only the id and the publication are read; the rest is what the type asks for.
  let entry: Omit<BundledBlueprint, "blueprintId"> = {
    title: "Notice", description: "", revision: 1, contentHash: "", archive: "",
    output: { id: "notice", noun: "Notice", plural: "Notices", icon: "fileText" },
    author: { type: "user", id: "test@example.com", name: "Test" },
  };
  let added: BundledBlueprint[] = [
    { ...entry, blueprintId: BUNDLED.published, publication: "use" },
    { ...entry, blueprintId: BUNDLED.plain },
  ];
  return { ...original, BUNDLED_BLUEPRINTS: [...original.BUNDLED_BLUEPRINTS, ...added] };
});

type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; userId: string;
  personal: string;
};

const TITLE = "Team Notes";
const NEITHER = { containsRestrictedData: false, ownerInvitesOnly: false };
const unique = () => crypto.randomUUID().slice(0, 8);
const space = (key: string) => env.TEST_SPACE.getByName(key);

async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, userId: user.id.toString(), personal: `~${id}` };
}

// The blueprint store the creation path reads, as KV and R2 hold it: a record under the
// blueprint's id, and its gzip-compressed code under `<id>/<version>`.
const records = new Map<string, string>();
const contents = new Map<string, Uint8Array>();
const store = {
  BLUEPRINTS: { get: async (key: string) => records.get(key) ?? null },
  BLUEPRINT_CONTENT: {
    get: async (key: string) => {
      let bytes = contents.get(key);
      return bytes ? { body: new Response(bytes as BufferSource).body } : null;
    },
  },
} as unknown as Cloudflare.Env;

// Stores blueprint `id`: installed by the deployment unless given an owner, titled TITLE, with
// whatever `metadata` adds.
async function seed(id: string, ownerId?: string, metadata: Partial<BlueprintMetadata> = {}) {
  let doc = new Y.Doc();
  doc.getMap().set("index.js", new Y.Text("export {};"));
  let compressed = new Response(new Blob([Y.encodeStateAsUpdateV2(doc) as BufferSource]).stream()
      .pipeThrough(new CompressionStream("gzip")));
  contents.set(`${id}/1`, new Uint8Array(await compressed.arrayBuffer()));
  let created = new Date("2026-01-01");
  let record: BlueprintKvRecord = {
    metadata: {
      title: TITLE, description: "", author: { type: "user", id: "author", name: "Author" },
      created, version: 1, lastUpdated: created, bindings: {}, ...metadata,
    },
    ...(ownerId !== undefined && { ownerId }),
  };
  records.set(id, JSON.stringify(record));
}

// Creates a workspace of `owner`'s from blueprint `id`, opening it as the API does but with no
// session to lose, and waits out the sync with its space that its creation started.
async function create(owner: Account, id: string, options?: BlueprintInstantiationOptions) {
  let ctx = { exports: { OverseerDurableObject: env.TEST_OVERSEER }, waitUntil: () => {} };
  let overseer = await newWorkspaceFromBlueprint(
      ctx as unknown as ExecutionContext, store, owner.user,
      workspaceId => env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(workspaceId))
          .open(owner.userId, owner.profile.id, new NativeRpcStub<() => void>(() => {})) as
              unknown as Promise<NativeRpcStub<Overseer>>,
      id, {}, options);
  try {
    let { id: workspaceId, publicAccess } = await overseer.getMetadata();
    // Deleting a workspace the owner has no record of takes its turn after every sync before it.
    await owner.user.deleteGadget("ws-none", NEITHER);
    return { id: workspaceId, publicAccess };
  } finally {
    overseer[Symbol.dispose]();
  }
}

const stored = (owner: Account, id: string): Promise<GadgetRecord | undefined> =>
    runInDurableObject(owner.user, (_instance, state) =>
        makeUserStorage(state.storage).gadgets.get(id));
const entry = async (key: string, owner: Account, id: string) =>
    (await space(key).listWorkspaces(owner.profile.id)).find(listed => listed.id === id);

let attach: MockInstance<SpaceDurableObject["attachWorkspaces"]>;
// What each space was told of workspace `id`, registration by registration.
const registrations = (id: string) => attach.mock.calls.flatMap(([, registered]) =>
    registered.filter(registration => registration.id === id));

beforeEach(() => {
  records.clear();
  contents.clear();
  attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces");
  // A first open provisions the owner's singleton accounts, which needs bindings this suite
  // does not have; the owner has none.
  vi.spyOn(UserDurableObject.prototype, "listProvidedAccounts").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a workspace created from a bundled blueprint that declares a publication", () => {
  it("is published from its first registration, under the blueprint's title", async () => {
    let alice = await signUp("alice");
    await seed(BUNDLED.published);

    let { id, publicAccess } = await create(alice, BUNDLED.published, fromApiOptions(undefined));

    expect(publicAccess).toBe("use");
    // One registration, already published: the space never listed it unpublished.
    expect(registrations(id)).toEqual([
      { id, title: TITLE, created: expect.any(Date), published: "use", placement: {} },
    ]);
    expect(await entry(alice.personal, alice, id))
        .toMatchObject({ title: TITLE, slug: slugify(TITLE), published: "use" });
    expect(await stored(alice, id)).toMatchObject({
      title: TITLE, publicAccess: "use",
      registered: { spaceKey: alice.personal, title: TITLE, published: "use" },
    });
  });

  it("is not published when its creator opts out", async () => {
    let alice = await signUp("alice");
    await seed(BUNDLED.published);

    let { id, publicAccess } =
        await create(alice, BUNDLED.published, fromApiOptions({ publish: false }));

    expect(publicAccess).toBeUndefined();
    expect(registrations(id)).toEqual([
      { id, title: TITLE, created: expect.any(Date), placement: {} },
    ]);
    expect(await entry(alice.personal, alice, id)).not.toHaveProperty("published");
    expect(await stored(alice, id)).not.toHaveProperty("publicAccess");
  });

  it("is placed by a string third argument as by a spaceKey", async () => {
    let alice = await signUp("alice");
    let team = `team-${unique()}`;
    expect(await space(team).claim(teamSpaceClaim(team, "Team"), alice.profile)).toBe(true);
    await seed(BUNDLED.published);

    let { id, publicAccess } = await create(alice, BUNDLED.published, fromApiOptions(team));

    expect(publicAccess).toBe("use");
    expect(await stored(alice, id)).toMatchObject({ spaceKey: team, publicAccess: "use" });
    expect(await entry(team, alice, id)).toMatchObject({ title: TITLE, published: "use" });
    expect(await entry(alice.personal, alice, id)).toBeUndefined();
  });

  it("is placed under the entry its creator names", async () => {
    let alice = await signUp("alice");
    await seed(BUNDLED.published);
    let parent = await create(alice, BUNDLED.published);

    let { id } = await create(alice, BUNDLED.published, fromApiOptions({ parentId: parent.id }));

    expect(registrations(id)).toEqual([{
      id, title: TITLE, created: expect.any(Date), published: "use",
      placement: { parentId: parent.id },
    }]);
    expect(await entry(alice.personal, alice, id))
        .toMatchObject({ parentId: parent.id, published: "use" });
  });

  it("refuses a malformed space key before creating anything", async () => {
    let alice = await signUp("alice");
    await seed(BUNDLED.published);

    await expect(create(alice, BUNDLED.published, fromApiOptions("~alice")))
        .rejects.toThrow(/space key/);
    expect(attach).not.toHaveBeenCalled();
    expect(await runInDurableObject(alice.user, (_instance, state) =>
        [...makeUserStorage(state.storage).gadgets.list()])).toEqual([]);
  });
});

describe("a workspace created from any other blueprint", () => {
  it.each<[string, string, string | undefined, Partial<BlueprintMetadata>]>([
    ["one the deployment does not ship", "uploaded", undefined, {}],
    ["one a user published under a bundled id", BUNDLED.published, "someone", {}],
    ["one whose stored metadata alone claims a publication", "uploaded", undefined,
      { publication: "use" }],
    ["a bundled one that declares none, whatever its stored metadata claims", BUNDLED.plain,
      undefined, { publication: "build" }],
  ])("is not published: %s", async (_case, blueprintId, ownerId, metadata) => {
    let alice = await signUp("alice");
    await seed(blueprintId, ownerId, metadata);

    let { id, publicAccess } = await create(alice, blueprintId, fromApiOptions({ publish: true }));

    expect(publicAccess).toBeUndefined();
    expect(registrations(id)).toEqual([
      { id, title: TITLE, created: expect.any(Date), placement: {} },
    ]);
  });

  it("is published at the role its creating kernel code states", async () => {
    let alice = await signUp("alice");
    await seed(BUNDLED.plain);

    let { id, publicAccess } = await create(alice, BUNDLED.plain, { publicAccess: "build" });

    expect(publicAccess).toBe("build");
    expect(registrations(id)).toEqual([
      { id, title: TITLE, created: expect.any(Date), published: "build", placement: {} },
    ]);
  });
});

describe("the options of AuthenticatedApi.newGadgetFromBlueprint", () => {
  it("read a string as a spaceKey, and publish: false as no publication", () => {
    expect(fromApiOptions(undefined)).toEqual({});
    expect(fromApiOptions("team")).toEqual({ spaceKey: "team" });
    expect(fromApiOptions({ spaceKey: "team", parentId: "p", publish: true }))
        .toEqual({ spaceKey: "team", parentId: "p" });
    expect(fromApiOptions({ publish: false })).toEqual({ publicAccess: null });
  });

  // capnweb-validate forwards members a method does not declare unvalidated.
  it("name no title and no role", () => {
    let options = { spaceKey: "team", title: "Forged", publicAccess: "build" };
    expect(fromApiOptions(options as never)).toEqual({ spaceKey: "team" });
  });
});

describe("a blueprint archive", () => {
  it("brings no publication into the blueprint stored from it", async () => {
    let created = new Date("2026-01-01");
    let metadata: BlueprintMetadata = {
      title: TITLE, description: "", author: { type: "user", id: "author", name: "Author" },
      created, version: 1, lastUpdated: created, bindings: {}, publication: "build",
    };
    let content = new Uint8Array([1, 2, 3]);
    let archive = buildBlueprintArchiveStream(
        metadata, new Response(content as BufferSource).body!, content.byteLength);

    let parsed = await parseBlueprintArchive(archive);
    await parsed.content.cancel();

    expect(parsed.metadata).not.toHaveProperty("publication");
    expect(parsed.metadata.title).toBe(TITLE);
  });
});
