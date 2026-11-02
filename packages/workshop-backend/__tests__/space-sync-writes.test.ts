// What a space sync writes: through the loopback of a running job, the account running it makes
// the user's workspaces in the job's space (ensureWorkspace), fills them in through their gadget
// (writeWorkspace) and retitles them (setWorkspaceTitle), and the user re-syncs one
// (resyncWorkspace).
//
// The User, Space and Overseer Durable Objects are real, and so is the gadget each workspace is
// created with, loaded from the code of the blueprint in the store below. Stood in for, inside
// the user's object, as in space-sync-jobs.test.ts: its connected accounts, in-memory objects
// recording what they are asked; the KV namespace holding the admin config and the blueprint's
// record, and the bucket holding its code; and its `ctx.exports.SpaceSyncLoopback`, which mints
// the real class with props as the runtime would. One bundled blueprint is added to the ones this
// Worker was built with.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  slugify, type AiChatAuthorInfo, type BlueprintMetadata, type SpaceMemberRole,
} from "@gadgets/workshop-shared/api";
import {
  getSpaceSyncErrorCode, MAX_SPACE_SYNC_TITLE_LENGTH, MAX_SPACE_SYNC_SOURCE_URL_LENGTH,
  MAX_SPACE_SYNC_WRITE_BYTES, SPACE_SYNC_ERROR_CODES, type AccountDescription,
  type SpaceSyncRequest,
} from "@gadgets/workshop-shared/gatekeeper";
import type { BundledBlueprint } from "../src/generated/bundled-blueprints.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceSyncLoopback, type SpaceSyncLoopbackProps } from "../src/space-sync-loopback.js";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import type { BlueprintKvRecord } from "../src/storage-schema/blueprints-kv.js";
import { DEFAULT_WORKSPACE_TITLE } from "../src/storage-schema/overseer-storage.js";
import {
  makeUserStorage, type ConnectedAccountRecord, type GadgetRecord, type UserStorage,
} from "../src/storage-schema/user-storage.js";
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

// The bundled blueprint the accounts sync with: it publishes at "build", and lets a sync call
// `importContent`, `fail` and `blueprintOnly` on its gadget, and lists `then` and `toString`,
// which the kernel refuses anyway. Another, which an account may come to declare instead, lets a
// sync call `accountOnly` too.
const BLUEPRINT = vi.hoisted(() => "test.synced-notes");
const OTHER_BLUEPRINT = vi.hoisted(() => "test.other-notes");
vi.mock("../src/generated/bundled-blueprints.js", async importOriginal => {
  let original = await importOriginal<typeof import("../src/generated/bundled-blueprints.js")>();
  // Only the id, the publication and the import methods are read; the rest is what the type
  // asks for.
  let added: BundledBlueprint = {
    blueprintId: BLUEPRINT, title: "Notes", description: "", revision: 1, contentHash: "",
    archive: "", output: { id: "notes", noun: "Note", plural: "Notes", icon: "fileText" },
    author: { type: "user", id: "test@example.com", name: "Test" },
    publication: "build",
    importMethods: ["importContent", "fail", "blueprintOnly", "then", "toString"],
  };
  let other: BundledBlueprint = {
    ...added, blueprintId: OTHER_BLUEPRINT, publication: "use",
    importMethods: ["importContent", "accountOnly"],
  };
  return { ...original, BUNDLED_BLUEPRINTS: [...original.BUNDLED_BLUEPRINTS, added, other] };
});

// Every product analytics event recorded, as a dashboard would count it.
const recorded = vi.hoisted(() => [] as { event_name: string; gadget_id?: string }[]);
vi.mock("../src/analytics.js", async importOriginal => {
  let original = await importOriginal<typeof import("../src/analytics.js")>();
  return {
    ...original,
    recordAnalytics(...args: Parameters<typeof original.recordAnalytics>) {
      recorded.push(args[2]);
      original.recordAnalytics(...args);
    },
  };
});

// The gadget of every synced workspace: it keeps what it was last given, a long string by its
// length, which storage would not take whole, and `read` returns it.
const SERVER_JS = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async #keep(content) {
    let long = typeof content === "string" && content.length > 100000;
    await this.ctx.storage.put("content", long ? { length: content.length } : content);
    return { kept: content };
  }
  importContent(content) { return this.#keep(content); }
  accountOnly(content) { return this.#keep(content); }
  blueprintOnly(content) { return this.#keep(content); }
  fail() { throw new Error("The secret plan is in here."); }
  async read() { return (await this.ctx.storage.get("content")) ?? null; }
}
`;

const VENDOR = "docs";
const RESOURCE = {
  urlPattern: "https://docs.example/spaces/*", title: "Docs space", description: "",
};
const ROOT = "https://docs.example/spaces/handbook";
const PAGE = "https://docs.example/spaces/handbook/welcome";
// What the accounts declare: the methods the blueprint lists too, but `blueprintOnly`, and one it
// does not.
const DECLARED: AccountDescription = {
  displayName: "Docs",
  providesSpaceSync: {
    blueprintId: BLUEPRINT,
    importMethods: ["importContent", "fail", "accountOnly", "then", "toString"],
  },
};
const DAY = new Date("2026-01-01");
const unique = () => crypto.randomUUID().slice(0, 8);
const space = (key: string) => env.TEST_SPACE.getByName(key);
const { notAllowed, cancelled, workspaceGone } = SPACE_SYNC_ERROR_CODES;

type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; userId: string;
  personal: string;
};

async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, userId: user.id.toString(), personal: `~${id}` };
}

// A team space under a fresh key, created by `admin`.
async function teamSpace(admin: Account, ...members: [Account, SpaceMemberRole][]) {
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  for (let [{ profile }, role] of members) {
    await space(key).setMemberRole(admin.profile.id, profile.id, role);
  }
  return key;
}

// Lists a workspace of `owner`'s in space `key`, under a fresh id, as their User DO would.
async function listed(owner: Account, key: string): Promise<string> {
  let id = `ws-${unique()}`;
  expect(await space(key).attachWorkspaces(owner.profile, [{ id, title: "Parent", created: DAY }]))
      .toBe(true);
  return id;
}

// The admin config every user's object reads, reset before each test.
let adminConfig: Partial<AdminConfig> = {};

// The blueprint as the deployment installed it: its record, with no owner, and its gzip-compressed
// code under `<id>/1`.
let blueprintCode: Uint8Array;
const blueprintRecord: BlueprintKvRecord = {
  metadata: {
    title: "Notes", description: "", author: { type: "user", id: "author", name: "Author" },
    created: DAY, version: 1, lastUpdated: DAY, bindings: {},
  } satisfies BlueprintMetadata,
};
const store = {
  BLUEPRINTS: {
    get: async (key: string) => key === ".adminConfig" ? JSON.stringify(adminConfig)
        : key === BLUEPRINT ? JSON.stringify(blueprintRecord) : null,
  },
  BLUEPRINT_CONTENT: {
    get: async (key: string) => key === `${BLUEPRINT}/1`
        ? { body: new Response(blueprintCode as BufferSource).body } : null,
  },
};

beforeEach(async () => {
  adminConfig = {};
  let doc = new Y.Doc();
  doc.getMap().set("server.js", new Y.Text(SERVER_JS));
  let compressed = new Response(new Blob([Y.encodeStateAsUpdateV2(doc) as BufferSource]).stream()
      .pipeThrough(new CompressionStream("gzip")));
  blueprintCode = new Uint8Array(await compressed.arrayBuffer());
  // A first open provisions the owner's singleton accounts, which needs bindings this suite
  // does not have; the owner has none.
  vi.spyOn(UserDurableObject.prototype, "listProvidedAccounts").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// What a test reaches into the user's object for.
type UserInternals = {
  env: Cloudflare.Env;
  ctx: DurableObjectState & { exports: object; id: DurableObjectId };
  storage: UserStorage;
};

// A connected account standing in for a gatekeeper's: the jobs it was asked to start, each with
// the target it was handed.
type FakeAccount = {
  accountId: number;
  started: { request: SpaceSyncRequest; target: SpaceSyncLoopback }[];
  // The target the account was handed with its `index`th start, by default its last.
  target(index?: number): SpaceSyncLoopback;
};

// The loopback as the runtime mints it, its props set by the user's object. It reaches the user's
// object through the test's own binding, so that a test may call it from outside.
const mint = ({ props }: { props: SpaceSyncLoopbackProps }) => new SpaceSyncLoopback(
    { props, exports: { UserDurableObject: env.TEST_USER } } as unknown as
        ExecutionContext<SpaceSyncLoopbackProps>, env);

// The in-memory accounts of each user's object, by account id, with the fakes installed.
const fakes = new WeakMap<object, Map<number, ConnectedAccountRecord>>();
let nextFakeId = 2_000;

function fakesIn(instance: UserInternals): Map<number, ConnectedAccountRecord> {
  let accounts = fakes.get(instance);
  if (accounts) return accounts;
  let records = new Map<number, ConnectedAccountRecord>();
  fakes.set(instance, records);
  let collection = instance.storage.connectedAccounts;
  let get = collection.get.bind(collection);
  let remove = collection.delete.bind(collection);
  vi.spyOn(collection, "get").mockImplementation(id => records.get(id) ?? get(id));
  vi.spyOn(collection, "delete").mockImplementation(id => records.delete(id) || remove(id));
  instance.env = { ...instance.env, ...store } as unknown as Cloudflare.Env;
  instance.ctx.exports = new Proxy(instance.ctx.exports, {
    get: (target, name) => name === "SpaceSyncLoopback" ? mint : Reflect.get(target, name),
  });
  return records;
}

// Connects a fake account declaring DECLARED to `owner`.
function connect(owner: Account): Promise<FakeAccount> {
  let accountId = nextFakeId++;
  let fake: FakeAccount = {
    accountId, started: [],
    target: (index = fake.started.length - 1) => fake.started[index]!.target,
  };
  let account = {
    async describe() { return DECLARED; },
    async getGatekeeperClassFor(_url: string) { return { class: {}, resource: RESOURCE }; },
    async startSpaceSync(request: SpaceSyncRequest, target: SpaceSyncLoopback) {
      fake.started.push({ request, target });
    },
    async cancelSpaceSync(_jobId: string) {},
    async revoke() {},
  };
  return runInDurableObject(owner.user, (instance: UserDurableObject) => {
    fakesIn(instance as unknown as UserInternals).set(accountId, {
      id: accountId, vendorId: VENDOR, description: DECLARED,
      account: account as unknown as ConnectedAccountRecord["account"],
    });
    return fake;
  });
}

// Starts a sync of `owner`'s through `fake` into space `key`, under `parentId`, and returns the
// target the account was handed for it.
async function start(owner: Account, fake: FakeAccount, key: string, parentId?: string) {
  let job = await owner.user.startSpaceSync(fake.accountId, key, { resourceUrl: ROOT, parentId });
  expect(job.status).toBe("running");
  return { job, target: fake.target() };
}

// The message a call is refused with, or undefined if it succeeds: a native RPC promise left to
// `.rejects` is also flagged as an unhandled rejection by the pool.
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

// The code a call is refused with, "ok" if it succeeds, or the message of a refusal with none.
async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (error) {
    return getSpaceSyncErrorCode(error) ?? (error as Error).message;
  }
}

const ensure = async (target: SpaceSyncLoopback, sourceUrl = PAGE, title = "Welcome",
    parentId?: string) =>
  (await target.ensureWorkspace({ sourceUrl, title, ...(parentId && { parentId }) })).workspaceId;

const stored = (owner: Account, id: string): Promise<GadgetRecord | undefined> =>
    runInDurableObject(owner.user, (_instance, state) =>
        makeUserStorage(state.storage).gadgets.get(id));

const entry = async (key: string, owner: Account, id: string) =>
    (await space(key).listWorkspaces(owner.profile.id)).find(workspace => workspace.id === id);

// Opens workspace `id` as its owner `owner`, as the API does but with no session to lose.
// Typed loosely: Cap'n Web and native stubs of the Overseer do not line up for the compiler.
function openAsOwner(owner: Account, id: string): Promise<any> {
  return env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(id))
      .open(owner.userId, owner.profile.id, () => {});
}

// What the default gadget of `owner`'s workspace `id` was last given, read through the owner's
// own connection to it.
async function contentOf(owner: Account, id: string): Promise<unknown> {
  using overseer = await openAsOwner(owner, id);
  let { defaultGadgetId } = await overseer.getMetadata();
  using gadget = await overseer.getGadget(defaultGadgetId);
  using facet = await gadget.connectToGadget();
  return await facet.read();
}

describe("ensureWorkspace", () => {
  it("creates the user's workspace in the job's space, under the parent given, titled and " +
      "published at the job's role", async () => {
    let admin = await signUp("admin");
    let bob = await signUp("bob");
    let key = await teamSpace(admin, [bob, "use"]);
    let jobParent = await listed(admin, key);
    let parentId = await listed(admin, key);
    let docs = await connect(bob);
    let { target } = await start(bob, docs, key, jobParent);

    let id = await ensure(target, PAGE, "Welcome", parentId);

    // Listed by the time it returns.
    expect(await entry(key, bob, id)).toMatchObject({
      title: "Welcome", slug: slugify("Welcome"), published: "build", parentId,
      owner: { id: bob.profile.id },
    });
    expect(await stored(bob, id)).toMatchObject({
      title: "Welcome", spaceKey: key, publicAccess: "build",
      syncedFrom: { accountId: docs.accountId, blueprintId: BLUEPRINT, sourceUrl: PAGE },
      registered: { spaceKey: key, title: "Welcome", published: "build" },
    });
    // The owner is told which account synced it, but not the source item.
    let [listedGadget] = (await bob.user.listGadgets()).filter(gadget => gadget.id === id);
    expect(listedGadget!.syncedFrom).toEqual({ accountId: docs.accountId });
    expect((await bob.user.getGadget(id))!.syncedFrom).toEqual({ accountId: docs.accountId });
    // It is the gadget of the blueprint the account declared.
    expect(await contentOf(bob, id)).toBeNull();
  });

  it("puts it under the job's parent when the space does not list the one given, and at the " +
      "top of the tree with neither", async () => {
    let alice = await signUp("alice");
    let key = await teamSpace(alice);
    let jobParent = await listed(alice, key);
    let docs = await connect(alice);
    let { target } = await start(alice, docs, key, jobParent);

    let underJob = await ensure(target, PAGE, "Welcome", `ws-${unique()}`);
    expect((await entry(key, alice, underJob))?.parentId).toBe(jobParent);

    let personal = await connect(alice);
    let { target: personalTarget } = await start(alice, personal, alice.personal);
    let atTop = await ensure(personalTarget, PAGE, "Welcome");
    let top = await entry(alice.personal, alice, atTop);
    expect(top).toMatchObject({ title: "Welcome", published: "build" });
    expect(top).not.toHaveProperty("parentId");
    expect(await stored(alice, atTop)).not.toHaveProperty("spaceKey");
  });

  it("returns the same workspace when called again for the same item, and keeps its title",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);

    let id = await ensure(target, PAGE, "Welcome");
    let again = await ensure(target, PAGE, "Renamed upstream");
    let other = await ensure(target, ROOT, "Handbook");

    expect(again).toBe(id);
    expect(other).not.toBe(id);
    expect((await entry(alice.personal, alice, id))?.title).toBe("Welcome");
    let synced = (await alice.user.listGadgets()).filter(gadget => gadget.syncedFrom);
    expect(synced.map(gadget => gadget.id).toSorted()).toEqual([id, other].toSorted());
  });

  it("creates one workspace for two concurrent calls for the same item", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);

    let [first, second] = await Promise.all([ensure(target), ensure(target)]);

    expect(second).toBe(first);
    expect((await alice.user.listGadgets()).filter(gadget => gadget.syncedFrom)).toHaveLength(1);
    expect((await space(alice.personal).listWorkspaces(alice.profile.id))
        .filter(workspace => workspace.title === "Welcome")).toHaveLength(1);
  });

  it("creates another once the user has deleted it", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    {
      using overseer = await openAsOwner(alice, id);
      await overseer.deleteSelf();
    }

    let replacement = await ensure(target);

    expect(replacement).not.toBe(id);
    expect(await stored(alice, id)).toBeUndefined();
    expect(await entry(alice.personal, alice, replacement)).toMatchObject({ title: "Welcome" });
  });

  it("creates another once the user has moved it to another space, where it stays", async () => {
    let alice = await signUp("alice");
    let elsewhere = await teamSpace(alice);
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    {
      using overseer = await openAsOwner(alice, id);
      await overseer.moveToSpace(elsewhere);
    }

    let replacement = await ensure(target);

    expect(replacement).not.toBe(id);
    expect(await entry(alice.personal, alice, replacement)).toMatchObject({ title: "Welcome" });
    expect(await entry(alice.personal, alice, id)).toBeUndefined();
    expect(await entry(elsewhere, alice, id)).toMatchObject({ title: "Welcome" });
  });

  it("replaces a workspace whose creation stopped half way, which no space listed", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces");
    vi.spyOn(OverseerDurableObject.prototype, "initializeFromBlueprint")
        .mockRejectedValueOnce(new Error("interrupted"));

    expect(await codeOf(ensure(target))).toBe("interrupted");
    let [half] = await runInDurableObject(alice.user, (_instance, state) =>
        [...makeUserStorage(state.storage).gadgets.list()]);
    expect(half).toMatchObject({ title: "Welcome" });
    expect(half).not.toHaveProperty("lastActive");

    let id = await ensure(target);

    expect(id).not.toBe(half!.id);
    expect(await stored(alice, half!.id)).toBeUndefined();
    expect(await entry(alice.personal, alice, id)).toMatchObject({ title: "Welcome" });
    // The half-made workspace was never listed.
    let registered = attach.mock.calls.flatMap(([, registrations]) => registrations);
    expect(registered.map(registration => registration.id)).not.toContain(half!.id);
  });

  it("finishes a workspace that was made but that its space has yet to list", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let unreachable = true;
    let attach = SpaceDurableObject.prototype.attachWorkspaces;
    vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces").mockImplementation(
        function (this: SpaceDurableObject, ...args) {
          if (unreachable) throw new Error("The space is out of reach.");
          return attach.apply(this, args);
        });

    expect(await codeOf(ensure(target))).toBe("The space is out of reach.");
    let [made] = (await alice.user.listGadgets()).filter(gadget => gadget.title === "Welcome");
    expect(made).toBeDefined();
    unreachable = false;

    let id = await ensure(target);

    expect(id).toBe(made!.id);
    expect(await entry(alice.personal, alice, id)).toMatchObject({ title: "Welcome" });
  });

  it("refuses a source URL that is empty or too long", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);

    for (let sourceUrl of ["", `${ROOT}/${"x".repeat(MAX_SPACE_SYNC_SOURCE_URL_LENGTH)}`]) {
      expect(await codeOf(ensure(target, sourceUrl))).toBe(notAllowed);
    }
    expect((await alice.user.listGadgets()).filter(gadget => gadget.syncedFrom)).toEqual([]);
  });

  it("cuts a long title", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);

    let id = await ensure(target, PAGE, "t".repeat(MAX_SPACE_SYNC_TITLE_LENGTH + 5));

    expect((await stored(alice, id))?.title).toBe("t".repeat(MAX_SPACE_SYNC_TITLE_LENGTH));
  });
});

describe("the loopback's writes", () => {
  it("are refused once the job is cancelled", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { job, target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    await alice.user.cancelSpaceSync(job.jobId);

    expect(await codeOf(ensure(target, ROOT))).toBe(cancelled);
    expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args: "x" })))
        .toBe(cancelled);
    expect(await codeOf(target.setWorkspaceTitle(id, "Renamed"))).toBe(cancelled);
    expect(await contentOf(alice, id)).toBeNull();
    // What the sync made stays the user's own.
    expect(await entry(alice.personal, alice, id)).toMatchObject({ title: "Welcome" });
  });

  it("are refused once the user has left the team space", async () => {
    let admin = await signUp("admin");
    let bob = await signUp("bob");
    let key = await teamSpace(admin, [bob, "build"]);
    let docs = await connect(bob);
    let { target } = await start(bob, docs, key);
    let id = await ensure(target);

    await space(key).removeMember(admin.profile.id, bob.profile.id);

    expect(await codeOf(ensure(target, ROOT))).toBe(notAllowed);
    expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args: "x" })))
        .toBe(notAllowed);
    expect(await codeOf(target.setWorkspaceTitle(id, "Renamed"))).toBe(notAllowed);
    expect(await contentOf(bob, id)).toBeNull();
    expect((await stored(bob, id))?.title).toBe("Welcome");
  });

  it("are refused for a workspace another account synced, or none did", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let other = await connect(alice);
    let { target: docsTarget } = await start(alice, docs, alice.personal);
    let synced = await ensure(docsTarget);
    await docsTarget.reportProgress({ state: "done", done: 1 });
    let { target } = await start(alice, other, alice.personal);
    let plain = await ownWorkspace(alice);

    for (let id of [synced, plain]) {
      expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args: "x" })))
          .toBe(workspaceGone);
      expect(await codeOf(target.setWorkspaceTitle(id, "Renamed"))).toBe(workspaceGone);
    }
    expect(await contentOf(alice, synced)).toBeNull();
    // The other account's sync of the same item gets a workspace of its own.
    expect(await ensure(target)).not.toBe(synced);
  });
});

describe("a workspace that left the job's space", () => {
  it("refuses only the calls that name it, and the job goes on", async () => {
    let alice = await signUp("alice");
    let key = await teamSpace(alice);
    let docs = await connect(alice);
    let { job, target } = await start(alice, docs, key);
    let moved = await ensure(target);
    {
      using overseer = await openAsOwner(alice, moved);
      await overseer.moveToSpace(null);
    }

    expect(await codeOf(target.writeWorkspace(moved, { method: "importContent", args: "x" })))
        .toBe(workspaceGone);
    expect(await codeOf(target.setWorkspaceTitle(moved, "Renamed"))).toBe(workspaceGone);

    let next = await ensure(target, ROOT, "Handbook");
    await target.writeWorkspace(next, { method: "importContent", args: "x" });
    expect(await contentOf(alice, next)).toBe("x");
    expect((await alice.user.listSpaceSyncJobs(key))[0]).toMatchObject(
        { jobId: job.jobId, status: "running" });
    expect(await contentOf(alice, moved)).toBeNull();
    expect((await stored(alice, moved))?.title).toBe("Welcome");
  });
});

// Has `fake`'s account declare `providesSpaceSync` as given from now on, as a refreshed
// description would.
const declare = (owner: Account, fake: FakeAccount,
    providesSpaceSync: AccountDescription["providesSpaceSync"]) =>
  runInDurableObject(owner.user, (instance: UserDurableObject) => {
    fakesIn(instance as unknown as UserInternals).get(fake.accountId)!.description =
        { ...DECLARED, providesSpaceSync };
  });

describe("a change to what the account declares", () => {
  it("refuses every call of a job started with another declaration", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    for (let changed of [
      undefined, { blueprintId: OTHER_BLUEPRINT, importMethods: ["importContent", "accountOnly"] },
    ]) {
      await declare(alice, docs, changed);
      expect(await codeOf(ensure(target, ROOT))).toBe(notAllowed);
      expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args: "x" })))
          .toBe(notAllowed);
      expect(await codeOf(target.setWorkspaceTitle(id, "Renamed"))).toBe(notAllowed);
    }
    expect(await contentOf(alice, id)).toBeNull();
    expect((await stored(alice, id))?.title).toBe("Welcome");
  });

  it("never reaches a workspace made from another blueprint", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    await target.reportProgress({ state: "done", done: 1 });

    await declare(alice, docs,
        { blueprintId: OTHER_BLUEPRINT, importMethods: ["importContent", "accountOnly"] });
    expect(await refusal(alice.user.resyncWorkspace(id)))
        .toBe("This account now syncs with another blueprint than this workspace's.");
    let { job, target: other } = await start(alice, docs, alice.personal);
    expect(job).toMatchObject({ blueprintId: OTHER_BLUEPRINT, publication: "use" });

    // `accountOnly` is a method of the workspace's gadget that its own blueprint does not list.
    for (let method of ["accountOnly", "importContent"]) {
      expect(await codeOf(other.writeWorkspace(id, { method, args: "x" }))).toBe(workspaceGone);
    }
    expect(await codeOf(other.setWorkspaceTitle(id, "Renamed"))).toBe(workspaceGone);
    expect(await contentOf(alice, id)).toBeNull();
  });

  it("checks a method only against a list of them", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    // A string holds the method's name, as a list would.
    await declare(alice, docs,
        { blueprintId: BLUEPRINT, importMethods: "importContent" as unknown as string[] });
    expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args: "x" })))
        .toBe(notAllowed);
    await declare(alice, docs, { blueprintId: BLUEPRINT } as NonNullable<
        AccountDescription["providesSpaceSync"]>);
    expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args: "x" })))
        .toBe(notAllowed);
    expect(await contentOf(alice, id)).toBeNull();
  });
});

// A workspace of `owner`'s in their personal space that no sync made, recorded as the API does.
async function ownWorkspace(owner: Account): Promise<string> {
  let id = env.TEST_OVERSEER.newUniqueId().toString();
  await owner.user.newGadget(id, "Mine");
  return id;
}

describe("writeWorkspace", () => {
  it("calls the method on the workspace's default gadget, and returns nothing of its result",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    let content = { blocks: [{ type: "paragraph", text: "Hello" }], created: "2026-01-01" };

    let result = await target.writeWorkspace(id, { method: "importContent", args: content });

    expect(result).toBeUndefined();
    expect(await contentOf(alice, id)).toEqual(content);
  });

  it("refuses a method that the account or the blueprint does not list", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    for (let method of ["accountOnly", "blueprintOnly", "read", "constructor"]) {
      expect(await codeOf(target.writeWorkspace(id, { method, args: "x" }))).toBe(notAllowed);
    }
    expect(await contentOf(alice, id)).toBeNull();
  });

  it("refuses `then` and the names of Object.prototype, even when both lists name them",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    let reached = vi.spyOn(OverseerDurableObject.prototype, "writeForSpaceSync");

    for (let method of ["then", "toString"]) {
      expect(await codeOf(target.writeWorkspace(id, { method, args: "x" }))).toBe(notAllowed);
    }
    expect(reached).not.toHaveBeenCalled();
  });

  it("refuses arguments that are too large or that JSON does not carry", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    // In two-byte characters, its JSON is two bytes over the limit, its two quotes, although it
    // is fewer characters long than that.
    let large = "é".repeat(MAX_SPACE_SYNC_WRITE_BYTES / 2);

    for (let args of [large, 1n, undefined]) {
      expect(await codeOf(target.writeWorkspace(id, { method: "importContent", args })))
          .toBe(notAllowed);
    }
    expect(await contentOf(alice, id)).toBeNull();
    // Exactly the limit, as UTF-8.
    let fits = "é".repeat(MAX_SPACE_SYNC_WRITE_BYTES / 2 - 1);
    await target.writeWorkspace(id, { method: "importContent", args: fits });
    expect(await contentOf(alice, id)).toEqual({ length: fits.length });
  });

  it("rejects without quoting what the gadget threw", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    let refused = await refusal(target.writeWorkspace(id, { method: "fail", args: null }));

    expect(refused).toBe("The workspace's gadget failed to take the write.");
    expect(await codeOf(target.writeWorkspace(id, { method: "fail", args: null })))
        .toBe(refused);
  });
});

describe("setWorkspaceTitle", () => {
  it("retitles the workspace and its entry, which gets a slug once it has a title",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target, PAGE, DEFAULT_WORKSPACE_TITLE);
    expect(await entry(alice.personal, alice, id)).not.toHaveProperty("slug");

    await target.setWorkspaceTitle(id, "Handbook");

    expect(await entry(alice.personal, alice, id))
        .toMatchObject({ title: "Handbook", slug: "handbook", published: "build" });
    expect((await stored(alice, id))?.title).toBe("Handbook");
    using overseer = await openAsOwner(alice, id);
    expect((await overseer.getMetadata()).title).toBe("Handbook");
  });

  it("cuts a long title", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    await target.setWorkspaceTitle(id, "t".repeat(MAX_SPACE_SYNC_TITLE_LENGTH + 1));

    expect((await entry(alice.personal, alice, id))?.title)
        .toBe("t".repeat(MAX_SPACE_SYNC_TITLE_LENGTH));
  });
});

describe("what a sync does as the workspace's owner", () => {
  it("is not counted as the user opening the workspace", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let before = recorded.length;

    let id = await ensure(target);
    await target.setWorkspaceTitle(id, "Handbook");
    await target.writeWorkspace(id, { method: "importContent", args: "x" });

    let events = recorded.slice(before);
    expect(events).toContainEqual(
        expect.objectContaining({ event_name: "gadget_created", gadget_id: id }));
    expect(events.filter(event => event.event_name === "gadget_opened")).toEqual([]);
  });
});

describe("resyncWorkspace", () => {
  it("starts a job for the workspace's source item into the space it is in now, whose " +
      "ensureWorkspace returns that workspace", async () => {
    let alice = await signUp("alice");
    let elsewhere = await teamSpace(alice);
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    await target.reportProgress({ state: "done", done: 1 });
    {
      using overseer = await openAsOwner(alice, id);
      await overseer.moveToSpace(elsewhere);
    }

    let job = await alice.user.resyncWorkspace(id);

    expect(job).toMatchObject({
      accountId: docs.accountId, spaceKey: elsewhere, publication: "build", status: "running",
    });
    expect(job).not.toHaveProperty("parentId");
    expect(docs.started.at(-1)!.request)
        .toEqual({ jobId: job.jobId, resourceUrl: PAGE, scope: "item" });
    let resync = docs.target();
    expect(await ensure(resync, PAGE, "Welcome again")).toBe(id);
    await resync.writeWorkspace(id, { method: "importContent", args: "upstream" });
    expect(await contentOf(alice, id)).toBe("upstream");
    expect(await entry(elsewhere, alice, id)).toMatchObject({ title: "Welcome" });
  });

  it("is refused to anyone but the owner, and for a workspace no sync made", async () => {
    let alice = await signUp("alice");
    let bob = await signUp("bob");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    await target.reportProgress({ state: "done", done: 1 });
    await bob.user.recordSharedGadgetOpen(id, "Welcome", alice.profile, "build");

    expect(await refusal(bob.user.resyncWorkspace(id)))
        .toBe("No such workspace belonging to user.");
    expect(await refusal((await signUp("carol")).user.resyncWorkspace(id)))
        .toBe("No such workspace belonging to user.");
    expect(await refusal(alice.user.resyncWorkspace(await ownWorkspace(alice))))
        .toBe("This workspace was not created by a space sync.");
    expect(docs.started).toHaveLength(1);
  });

  it("is refused once the account is disconnected, or the admin disabled the resource",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    await target.reportProgress({ state: "done", done: 1 });

    adminConfig = { disabledResources: { [VENDOR]: [RESOURCE.urlPattern] } };
    expect(await refusal(alice.user.resyncWorkspace(id))).toBe(
        `The "${RESOURCE.title}" resource is disabled on this deployment by an administrator.`);
    adminConfig = {};

    await alice.user.disconnectAccount(docs.accountId);
    expect(await refusal(alice.user.resyncWorkspace(id)))
        .toBe("This account cannot sync into a space.");
    expect(docs.started).toHaveLength(1);
    // The workspace still says which account synced it.
    expect((await alice.user.getGadget(id))!.syncedFrom).toEqual({ accountId: docs.accountId });
  });

  it("is refused while an ended sync is still creating a workspace for the same source",
      async () => {
    let alice = await signUp("alice");
    let elsewhere = await teamSpace(alice);
    let docs = await connect(alice);
    let { job, target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);
    const move = async (spaceKey: string | null) => {
      using overseer = await openAsOwner(alice, id);
      await overseer.moveToSpace(spaceKey);
    };
    await move(elsewhere);
    // The next creation for the source waits until it is let go.
    let letGo!: () => void;
    let held = new Promise<void>(resolve => { letGo = resolve; });
    let initialize = OverseerDurableObject.prototype.initializeFromBlueprint;
    let initializing = vi.spyOn(OverseerDurableObject.prototype, "initializeFromBlueprint")
        .mockImplementationOnce(async function (this: OverseerDurableObject, ...args) {
          await held;
          return initialize.apply(this, args);
        });
    let replacing = ensure(target);
    await vi.waitFor(() => expect(initializing).toHaveBeenCalled());
    await alice.user.cancelSpaceSync(job.jobId);
    await move(null);

    expect(await refusal(alice.user.resyncWorkspace(id)))
        .toBe("An earlier sync is still creating a workspace for this source.");
    letGo();
    let replacement = await replacing;
    expect(replacement).not.toBe(id);

    // Once it is done, the re-sync fills in the workspace it was asked for.
    await alice.user.resyncWorkspace(id);
    let resync = docs.target();
    expect(await ensure(resync)).toBe(id);
    await resync.writeWorkspace(id, { method: "importContent", args: "upstream" });
    expect(await contentOf(alice, id)).toBe("upstream");
    expect(await contentOf(alice, replacement)).toBeNull();
  });

  it("is refused while a sync into the workspace's space runs", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { target } = await start(alice, docs, alice.personal);
    let id = await ensure(target);

    expect(await refusal(alice.user.resyncWorkspace(id)))
        .toBe("A sync into this space is already running.");
    expect(docs.started).toHaveLength(1);
  });
});
