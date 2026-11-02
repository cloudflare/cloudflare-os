// Space-sync jobs: a connected account whose description declares providesSpaceSync syncs a source
// into a space through a job its user's User DO records, and acts for the job only through the
// loopback that object hands it (SpaceSyncLoopback), which the job record revokes once it ends.
//
// The User and Space Durable Objects are real. Three things are stood in for, inside the user's
// object: its connected accounts, which are in-memory objects recording what they are asked
// rather than stubs of a gatekeeper Worker; the admin config, a KV namespace holding only that;
// and its `ctx.exports.SpaceSyncLoopback`, which the test Worker does not export, so it mints the
// real SpaceSyncLoopback class with props as the runtime would. Two bundled blueprints are added
// to the ones this Worker was built with.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, SpaceMemberRole, SpaceSyncJobInfo,
} from "@gadgets/workshop-shared/api";
import {
  getSpaceSyncErrorCode, MAX_SPACE_SYNC_MESSAGE_LENGTH, MAX_SPACE_SYNC_WARNINGS,
  SPACE_SYNC_ERROR_CODES, type AccountDescription, type SpaceSyncProgress, type SpaceSyncRequest,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AdminConfig } from "../src/storage-schema/admin-settings-storage.js";
import type { BundledBlueprint } from "../src/generated/bundled-blueprints.js";
import { SpaceSyncLoopback, type SpaceSyncLoopbackProps } from "../src/space-sync-loopback.js";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
import type { ConnectedAccountRecord, UserStorage } from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// Two bundled blueprints besides the ones this Worker was built with: one that publishes the
// workspaces created from it at "build", and one that declares no publication.
const BUNDLED = vi.hoisted(() => ({ build: "test.synced-build", plain: "test.synced-plain" }));
vi.mock("../src/generated/bundled-blueprints.js", async importOriginal => {
  let original = await importOriginal<typeof import("../src/generated/bundled-blueprints.js")>();
  // Only the id and the publication are read; the rest is what the type asks for.
  let entry: Omit<BundledBlueprint, "blueprintId"> = {
    title: "Notice", description: "", revision: 1, contentHash: "", archive: "",
    output: { id: "notice", noun: "Notice", plural: "Notices", icon: "fileText" },
    author: { type: "user", id: "test@example.com", name: "Test" },
  };
  let added: BundledBlueprint[] = [
    { ...entry, blueprintId: BUNDLED.build, publication: "build" },
    { ...entry, blueprintId: BUNDLED.plain },
  ];
  return { ...original, BUNDLED_BLUEPRINTS: [...original.BUNDLED_BLUEPRINTS, ...added] };
});

const VENDOR = "docs";
const RESOURCE = {
  urlPattern: "https://docs.example/spaces/*", title: "Docs space", description: "",
};
const SOURCE = "https://docs.example/spaces/handbook";
const DAY = new Date("2026-01-01");
// `n` minutes after DAY.
const minute = (n: number) => new Date(DAY.getTime() + n * 60_000);
const NO_SPACE = "No such space, or you are not a member of it.";
const RUNNING = "A sync into this space is already running.";
const unique = () => crypto.randomUUID().slice(0, 8);
const space = (key: string) => env.TEST_SPACE.getByName(key);

type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; personal: string;
};

async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, personal: `~${id}` };
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
beforeEach(() => { adminConfig = {}; });
const adminConfigKv = {
  get: async (key: string) => key === ".adminConfig" ? JSON.stringify(adminConfig) : null,
};

// What a test reaches into the user's object for.
type UserInternals = {
  env: Cloudflare.Env;
  ctx: DurableObjectState & { exports: object; id: DurableObjectId };
  storage: UserStorage;
};

// A connected account standing in for a gatekeeper's: what it was asked to start and to cancel,
// and what it reports through the target it was handed. Asked to stop a job, it first reports the
// job "done" through that job's target, as a connector winding down might, and keeps how that
// report went in `cancelReports`: refused as cancelled, if the job had ended before it was asked.
type FakeAccount = {
  accountId: number;
  started: { request: SpaceSyncRequest; target: SpaceSyncLoopback }[];
  cancelled: string[];
  cancelReports: string[];
  // The target the account was handed with its `index`th start.
  target(index?: number): SpaceSyncLoopback;
};

type FakeOptions = {
  description?: AccountDescription; failStart?: string; failCancel?: boolean;
  revoke?: () => Promise<void>; autoProvisioned?: boolean;
};

// The loopback as the runtime mints it, its props set by the user's object. It reaches the user's
// object through the test's own binding, so that a test may call it from outside.
const mint = ({ props }: { props: SpaceSyncLoopbackProps }) => new SpaceSyncLoopback(
    { props, exports: { UserDurableObject: env.TEST_USER } } as unknown as
        ExecutionContext<SpaceSyncLoopbackProps>, env);

// The in-memory accounts of each user's object, by account id, with the fakes installed.
const fakes = new WeakMap<object, Map<number, ConnectedAccountRecord>>();
let nextFakeId = 1_000;

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
  instance.env = { ...instance.env, BLUEPRINTS: adminConfigKv as unknown as KVNamespace };
  instance.ctx.exports = new Proxy(instance.ctx.exports, {
    get: (target, name) => name === "SpaceSyncLoopback" ? mint : Reflect.get(target, name),
  });
  return records;
}

// Connects a fake account to `owner`, by default one that syncs with the bundled blueprint that
// publishes at "build".
function connect(owner: Account, options: FakeOptions = {}): Promise<FakeAccount> {
  let accountId = nextFakeId++;
  let fake: FakeAccount = {
    accountId, started: [], cancelled: [], cancelReports: [],
    target: (index = 0) => fake.started[index]!.target,
  };
  let description = options.description ?? {
    displayName: "Docs", providesSpaceSync: { blueprintId: BUNDLED.build, importMethods: ["load"] },
  };
  let account = {
    async describe() { return description; },
    async getGatekeeperClassFor(_url: string) { return { class: {}, resource: RESOURCE }; },
    async startSpaceSync(request: SpaceSyncRequest, target: SpaceSyncLoopback) {
      fake.started.push({ request, target });
      if (options.failStart !== undefined) throw new Error(options.failStart);
    },
    async cancelSpaceSync(jobId: string) {
      fake.cancelled.push(jobId);
      let started = fake.started.find(({ request }) => request.jobId === jobId);
      if (started) {
        fake.cancelReports.push(await codeOf(report(started.target, { state: "done", done: 1 })));
      }
      if (options.failCancel) throw new Error("cancel failed");
    },
    revoke: options.revoke ?? (async () => {}),
  };
  return runInDurableObject(owner.user, (instance: UserDurableObject) => {
    fakesIn(instance as unknown as UserInternals).set(accountId, {
      id: accountId, vendorId: VENDOR, description,
      account: account as unknown as ConnectedAccountRecord["account"],
      ...(options.autoProvisioned && { autoProvisioned: true }),
    });
    return fake;
  });
}

// Drops a fake account from `owner`'s object without disconnecting it, as a record that is gone
// for any other reason would be.
function forget(owner: Account, { accountId }: FakeAccount): Promise<void> {
  return runInDurableObject(owner.user, (instance: UserDurableObject) => {
    fakesIn(instance as unknown as UserInternals).delete(accountId);
  });
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

const start = (owner: Account, fake: FakeAccount, key: string, parentId?: string) =>
    owner.user.startSpaceSync(fake.accountId, key, { resourceUrl: SOURCE, parentId });

const jobs = (owner: Account, key?: string) => owner.user.listSpaceSyncJobs(key);

const report = (target: SpaceSyncLoopback, progress: Partial<SpaceSyncProgress> = {}) =>
    target.reportProgress({ state: "running", done: 0, ...progress });

describe("starting a space sync", () => {
  it("records the job and hands the account its request and a target", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);

    let job = await start(alice, docs, alice.personal);

    expect(job).toEqual({
      jobId: expect.any(String), accountId: docs.accountId, vendorId: VENDOR,
      spaceKey: alice.personal, blueprintId: BUNDLED.build, publication: "build",
      status: "running", progress: { done: 0, warnings: [] }, created: expect.any(Date),
    });
    expect(docs.started).toEqual([
      { request: { jobId: job.jobId, resourceUrl: SOURCE }, target: expect.any(SpaceSyncLoopback) },
    ]);
    expect(await jobs(alice)).toEqual([job]);
    expect(await jobs(alice, alice.personal)).toEqual([job]);
    expect(await jobs(alice, `team-${unique()}`)).toEqual([]);
    // The target acts for this job: the account's first report reaches it.
    await report(docs.target(), { done: 1 });
    expect((await jobs(alice))[0]!.progress).toEqual({ done: 1, warnings: [] });
  });

  it("lets any member of a team space sync under an entry it lists, publishing at 'use' by default",
      async () => {
    let admin = await signUp("admin");
    let bob = await signUp("bob");
    let key = await teamSpace(admin, [bob, "use"]);
    let parentId = await listed(admin, key);
    let docs = await connect(bob, {
      description: {
        displayName: "Docs", providesSpaceSync: { blueprintId: BUNDLED.plain, importMethods: [] },
      },
    });

    let job = await start(bob, docs, key, parentId);

    expect(job).toMatchObject({ spaceKey: key, parentId, publication: "use", status: "running" });
    expect(docs.started).toHaveLength(1);
    // A sync of someone else's into the same space is theirs alone.
    expect(await jobs(admin, key)).toEqual([]);
  });

  type Refused = {
    name: string; message: string;
    setUp?: (alice: Account) => Promise<{ key?: string; parentId?: string }>;
    options?: FakeOptions; config?: Partial<AdminConfig>;
  };
  it.each<Refused>([
    {
      name: "an account that does not declare providesSpaceSync",
      options: { description: { displayName: "Docs" } },
      message: "This account cannot sync into a space.",
    },
    {
      name: "a blueprint the deployment does not ship",
      options: {
        description: {
          displayName: "Docs",
          providesSpaceSync: { blueprintId: "test.unshipped", importMethods: [] },
        },
      },
      message: "This account syncs with a blueprint this deployment does not ship.",
    },
    {
      name: "a gatekeeper the admin disabled",
      config: { disabledGatekeepers: [VENDOR] },
      message: `The "${VENDOR}" gatekeeper is disabled on this deployment by an administrator.`,
    },
    {
      name: "a resource the admin disabled",
      config: { disabledResources: { [VENDOR]: [RESOURCE.urlPattern] } },
      message:
          `The "${RESOURCE.title}" resource is disabled on this deployment by an administrator.`,
    },
    {
      name: "a team space the caller is not a member of",
      setUp: async () => ({ key: await teamSpace(await signUp("other")) }),
      message: NO_SPACE,
    },
    {
      name: "someone else's personal space",
      setUp: async () => ({ key: (await signUp("other")).personal }),
      message: NO_SPACE,
    },
    {
      name: "a parent the space does not list",
      setUp: async alice => ({
        // Listed, but in another space of hers.
        parentId: await listed(alice, await teamSpace(alice)),
      }),
      message: "This space does not list that workspace.",
    },
  ])("refuses $name, recording nothing", async ({ setUp, options, config, message }) => {
    let alice = await signUp("alice");
    let docs = await connect(alice, options);
    let { key = alice.personal, parentId } = await setUp?.(alice) ?? {};
    adminConfig = config ?? {};

    expect(await refusal(start(alice, docs, key, parentId))).toBe(message);
    expect(docs.started).toEqual([]);
    expect(await jobs(alice)).toEqual([]);
  });

  it("refuses a second running job into the same space, but not into another", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let other = await connect(alice);
    let key = await teamSpace(alice);
    let first = await start(alice, docs, alice.personal);

    expect(await refusal(start(alice, other, alice.personal))).toBe(RUNNING);
    expect(other.started).toEqual([]);
    let second = await start(alice, other, key);
    expect(new Set((await jobs(alice)).map(job => job.jobId)))
        .toEqual(new Set([first.jobId, second.jobId]));

    // Once the first has ended, the space takes another.
    await report(docs.target(), { state: "done" });
    expect((await start(alice, docs, alice.personal)).status).toBe("running");
  });

  it("starts one of two concurrent jobs into the same space", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);

    let outcomes = await Promise.all([
      refusal(start(alice, docs, alice.personal)), refusal(start(alice, docs, alice.personal)),
    ]);

    expect(outcomes.toSorted()).toEqual([RUNNING, undefined]);
    expect(docs.started).toHaveLength(1);
    expect(await jobs(alice)).toHaveLength(1);
  });

  it("marks the job failed, with what the account threw, if it could not start it", async () => {
    let alice = await signUp("alice");
    let thrown = "x".repeat(MAX_SPACE_SYNC_MESSAGE_LENGTH + 10);
    // The fake keeps the job before it throws, as a connector that half-accepted it might.
    let docs = await connect(alice, { failStart: thrown });

    let job = await start(alice, docs, alice.personal);

    expect(job).toMatchObject({
      status: "failed", finished: expect.any(Date),
      error: thrown.slice(0, MAX_SPACE_SYNC_MESSAGE_LENGTH),
    });
    expect(await jobs(alice)).toEqual([job]);
    expect(await codeOf(report(docs.target()))).toBe(SPACE_SYNC_ERROR_CODES.finished);
    // It is then asked to stop, once the job has ended.
    expect(docs.cancelled).toEqual([job.jobId]);
    expect(docs.cancelReports).toEqual([SPACE_SYNC_ERROR_CODES.finished]);
  });

  it("still returns the failed job when the account then fails to stop", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice, { failStart: "no", failCancel: true });

    let job = await start(alice, docs, alice.personal);

    expect(job).toMatchObject({ status: "failed", error: "no" });
    expect(docs.cancelled).toEqual([job.jobId]);
  });
});

describe("a space sync's target", () => {
  it("records the account's progress, and ends the job with a 'done' report", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { jobId } = await start(alice, docs, alice.personal);

    await report(docs.target(), { done: 2, total: 5, warnings: ["skipped one"] });
    expect((await jobs(alice))[0]).toMatchObject({
      status: "running", progress: { done: 2, total: 5, warnings: ["skipped one"] },
    });
    // Each report replaces the last.
    await report(docs.target(), { done: 3 });
    expect((await jobs(alice))[0]!.progress).toEqual({ done: 3, warnings: [] });

    await report(docs.target(), { state: "done", done: 5, total: 5, error: "ignored" });
    let [job] = await jobs(alice);
    expect(job).toMatchObject({
      jobId, status: "done", progress: { done: 5, total: 5, warnings: [] },
      finished: expect.any(Date),
    });
    expect(job!.error).toBeUndefined();
    expect(await codeOf(report(docs.target(), { done: 6 }))).toBe(SPACE_SYNC_ERROR_CODES.finished);
    expect((await jobs(alice))[0]).toEqual(job);
  });

  it("ends the job with a 'failed' report and keeps its error", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    await start(alice, docs, alice.personal);

    await report(docs.target(), { state: "failed", done: 1, error: "The source went away." });

    expect((await jobs(alice))[0]).toMatchObject({
      status: "failed", error: "The source went away.", progress: { done: 1, warnings: [] },
      finished: expect.any(Date),
    });
    expect(await codeOf(report(docs.target()))).toBe(SPACE_SYNC_ERROR_CODES.finished);
  });

  it("bounds what the account reports, and refuses counts that are not non-negative integers",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    await start(alice, docs, alice.personal);
    let long = "w".repeat(MAX_SPACE_SYNC_MESSAGE_LENGTH + 1);

    await report(docs.target(), {
      done: 1, warnings: Array.from({ length: MAX_SPACE_SYNC_WARNINGS + 5 }, () => long),
    });
    let { warnings } = (await jobs(alice))[0]!.progress;
    expect(warnings).toHaveLength(MAX_SPACE_SYNC_WARNINGS);
    expect(warnings.every(warning => warning.length === MAX_SPACE_SYNC_MESSAGE_LENGTH)).toBe(true);

    let invalid = [{ done: -1 }, { done: 1.5 }, { done: 1, total: -2 }, { done: 1, total: 0.5 }];
    for (let counts of invalid) {
      expect(await codeOf(report(docs.target(), counts))).toBe(SPACE_SYNC_ERROR_CODES.notAllowed);
    }
    expect((await jobs(alice))[0]).toMatchObject({ status: "running", progress: { done: 1 } });

    await report(docs.target(), { state: "failed", done: 1, error: long });
    expect((await jobs(alice))[0]!.error).toBe(long.slice(0, MAX_SPACE_SYNC_MESSAGE_LENGTH));
  });

  it("acts only for the job of the account it was minted for", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let other = await connect(alice);
    let { jobId } = await start(alice, docs, alice.personal);

    expect(await codeOf(alice.user.reportSpaceSyncProgress(
        other.accountId, jobId, { state: "running", done: 1 })))
        .toBe(SPACE_SYNC_ERROR_CODES.notAllowed);
    expect(await codeOf(alice.user.reportSpaceSyncProgress(
        docs.accountId, crypto.randomUUID(), { state: "running", done: 1 })))
        .toBe(SPACE_SYNC_ERROR_CODES.finished);
    expect((await jobs(alice))[0]!.progress.done).toBe(0);
  });

  it("is refused once the account is gone", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    await start(alice, docs, alice.personal);

    await forget(alice, docs);

    expect(await codeOf(report(docs.target(), { done: 1 })))
        .toBe(SPACE_SYNC_ERROR_CODES.accountGone);
  });
});

describe("cancelling a space sync", () => {
  it("ends the job first, then asks the account to stop", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { jobId } = await start(alice, docs, alice.personal);

    await alice.user.cancelSpaceSync(jobId);

    expect((await jobs(alice))[0]).toMatchObject({
      jobId, status: "cancelled", finished: expect.any(Date),
    });
    expect(docs.cancelled).toEqual([jobId]);
    // The job had already ended when the account was asked: its report from there was refused.
    expect(docs.cancelReports).toEqual([SPACE_SYNC_ERROR_CODES.cancelled]);
    expect(await codeOf(report(docs.target(), { done: 1 })))
        .toBe(SPACE_SYNC_ERROR_CODES.cancelled);
    expect(await codeOf(report(docs.target(), { state: "done", done: 1 })))
        .toBe(SPACE_SYNC_ERROR_CODES.cancelled);
    expect((await jobs(alice))[0]!.status).toBe("cancelled");

    // An ended job is left as it is, and the account is not asked again.
    await alice.user.cancelSpaceSync(jobId);
    expect(docs.cancelled).toEqual([jobId]);
    expect(await refusal(alice.user.cancelSpaceSync(crypto.randomUUID())))
        .toBe("No such space sync.");
  });

  it("stays cancelled when the account fails to stop", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice, { failCancel: true });
    let { jobId } = await start(alice, docs, alice.personal);

    expect(await refusal(alice.user.cancelSpaceSync(jobId))).toBeUndefined();

    expect(docs.cancelled).toEqual([jobId]);
    expect((await jobs(alice))[0]!.status).toBe("cancelled");
    expect(await codeOf(report(docs.target()))).toBe(SPACE_SYNC_ERROR_CODES.cancelled);
  });

  it("leaves a job that has ended as it is", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let { jobId } = await start(alice, docs, alice.personal);
    await report(docs.target(), { state: "done", done: 1 });

    await alice.user.cancelSpaceSync(jobId);

    expect((await jobs(alice))[0]!.status).toBe("done");
    expect(docs.cancelled).toEqual([]);
  });

  it("happens to every running job of an account that is disconnected", async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    let other = await connect(alice);
    let key = await teamSpace(alice);
    let third = await teamSpace(alice);
    let personal = await start(alice, docs, alice.personal);
    let team = await start(alice, docs, key);
    let kept = await start(alice, other, third);
    // One of its jobs has ended already, and stays as it ended.
    await report(docs.target(0), { state: "done", done: 1 });

    await alice.user.disconnectAccount(docs.accountId);

    let status = new Map((await jobs(alice)).map(job => [job.jobId, job.status]));
    expect(status).toEqual(new Map([
      [personal.jobId, "done"], [team.jobId, "cancelled"], [kept.jobId, "running"],
    ]));
    expect(docs.cancelled).toEqual([team.jobId]);
    expect(docs.cancelReports).toEqual([SPACE_SYNC_ERROR_CODES.cancelled]);
    expect(other.cancelled).toEqual([]);
    expect(await codeOf(report(docs.target(1)))).toBe(SPACE_SYNC_ERROR_CODES.cancelled);
    expect(await codeOf(report(docs.target(0)))).toBe(SPACE_SYNC_ERROR_CODES.finished);
    expect(await codeOf(report(other.target(), { done: 1 }))).toBe("ok");
  });

  it("happens to the running job of an opt-in automatic account that is disconnected",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice, { autoProvisioned: true });
    let { jobId } = await start(alice, docs, alice.personal);

    // While the admin provisions it for every user it cannot be disconnected, and the job runs on.
    adminConfig = { ambientGatekeeperModes: { [VENDOR]: "enabled" } };
    expect(await refusal(alice.user.disconnectAccount(docs.accountId)))
        .toBe("This account is provided automatically and can't be disconnected.");
    expect((await jobs(alice))[0]!.status).toBe("running");

    // Opt-in by default.
    adminConfig = {};
    await alice.user.disconnectAccount(docs.accountId);

    expect((await jobs(alice))[0]).toMatchObject({ jobId, status: "cancelled" });
    expect(docs.cancelled).toEqual([jobId]);
    expect(docs.cancelReports).toEqual([SPACE_SYNC_ERROR_CODES.cancelled]);
  });

  it("also ends a job started while the account was being disconnected", async () => {
    let alice = await signUp("alice");
    // Revoking takes until the test releases it. Each side waits on flags with its own timers,
    // since a promise one Durable Object's I/O context settles cannot resume the test's calls.
    let gate = { revoking: false, released: false };
    let docs = await connect(alice, {
      revoke: async () => {
        gate.revoking = true;
        while (!gate.released) await new Promise(resolve => setTimeout(resolve, 1));
      },
    });

    let disconnected = alice.user.disconnectAccount(docs.accountId);
    await vi.waitFor(() => expect(gate.revoking).toBe(true));
    // The account is still connected while it is revoked, so a start passes every check.
    let { jobId, status } = await start(alice, docs, alice.personal);
    expect(status).toBe("running");
    gate.released = true;
    await disconnected;

    expect((await jobs(alice))[0]).toMatchObject({
      jobId, status: "cancelled", finished: expect.any(Date),
    });
    expect(await codeOf(report(docs.target()))).toBe(SPACE_SYNC_ERROR_CODES.cancelled);
    // So it holds up no later sync into the space.
    expect((await start(alice, await connect(alice), alice.personal)).status).toBe("running");
  });
});

describe("the jobs kept", () => {
  it("are every running job and the 20 most recently ended of those that have ended",
      async () => {
    let alice = await signUp("alice");
    let docs = await connect(alice);
    // Jobs planted as an earlier run left them: 22 that ended, each the later the earlier it
    // started, and two, older than all of them, still running.
    let planted = (n: number, status: SpaceSyncJobInfo["status"]): SpaceSyncJobInfo => ({
      jobId: `planted-${n}`, accountId: docs.accountId, vendorId: VENDOR,
      spaceKey: `team-${n}`, blueprintId: BUNDLED.build, publication: "use", status,
      progress: { done: 0, warnings: [] },
      created: minute(n), ...(status !== "running" && { finished: minute(100 - n) }),
    });
    await runInDurableObject(alice.user, (instance: UserDurableObject) => {
      let { storage } = instance as unknown as UserInternals;
      storage.spaceSyncJobs.put(planted(-1, "running"));
      storage.spaceSyncJobs.put(planted(-2, "running"));
      for (let n = 0; n < 22; n++) storage.spaceSyncJobs.put(planted(n, n % 2 ? "done" : "failed"));
    });
    expect(await jobs(alice)).toHaveLength(24);

    // Ending the oldest job is what drops those that ended before the 20 most recent: it ended
    // last, so it is kept, however long ago it started.
    let target = mint({
      props: { userId: alice.user.id.toString(), accountId: docs.accountId, jobId: "planted--2" },
    });
    await report(target, { state: "done", done: 1 });

    expect((await jobs(alice)).map(job => job.jobId)).toEqual([
      ...Array.from({ length: 19 }, (_, i) => `planted-${18 - i}`), "planted--1", "planted--2",
    ]);
  });
});
