import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_USER_METHODS, getAdminAccessErrorCode,
  MAX_ADMIN_ACCESS_REASON_LENGTH, MAX_ADMIN_VIEW_LIFETIME_SECONDS, type AdminAccessErrorCode,
  type AdminApi, type AdminUserAccessRecord, type AdminUserView, type AiChatAuthorInfo,
  type AuthenticatedApi, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import {
  ADMIN_USERNAME, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, stubFor, waitFor,
  WorkpieceRecorder, type ConnectedAccount,
} from "../src/rpc-client.js";

const REASON = "Support ticket 123";
const NOTES = "Meeting notes: ship the admin audit log.\n";
// A model of the user's own. Each of these is a secret of it that no answer may hold: its API
// token, the password and the query key in its API URL, and the value of its extra header.
const MODEL_TOKEN = "model-token-2c84f1";
const MODEL_URL_PASSWORD = "url-password-97ad30";
const MODEL_URL_KEY = "url-key-5e06bb";
const MODEL_HEADER_VALUE = "header-value-d4193c";
const MODEL_SECRETS = [MODEL_TOKEN, MODEL_URL_PASSWORD, MODEL_URL_KEY, MODEL_HEADER_VALUE];
const MODEL = {
  profile: { type: "agent" as const, id: "support-model", name: "Support model" },
  config: {
    provider: "openai" as const, model: "example-model", apiToken: MODEL_TOKEN,
    apiUrl: `https://user:${MODEL_URL_PASSWORD}@llm.example.test/v1?key=${MODEL_URL_KEY}`,
    extraHeaders: { "x-proxy-auth": MODEL_HEADER_VALUE },
  },
};

// Admin settings and the audit log are deployment-wide, so this file owns its harness and runs
// serially.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop: config => {
      config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME] };
    },
  });
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${ADMIN_USERNAME}`);
  admin = fileScope.use(stub);
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** The code `call` is refused with; throws if it succeeds. */
async function refusalOf(call: PromiseLike<unknown>): Promise<AdminAccessErrorCode | undefined> {
  try {
    await call;
  } catch (error) {
    return getAdminAccessErrorCode(error);
  }
  throw new Error("The call was not refused");
}

/** The code `call` is refused with, or null when it succeeds: for polling until a refusal. */
async function outcomeOf(call: PromiseLike<unknown>): Promise<AdminAccessErrorCode | undefined | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return getAdminAccessErrorCode(error);
  }
}

/** Every record of the deployment-wide audit log about the account of user `id`, newest first. */
async function userRecords(id: string): Promise<AdminUserAccessRecord[]> {
  const { records } = await admin.listAdminAudit({ kind: "user", owner: id, limit: 200 });
  return records.map(record => {
    if (record.kind !== "user") throw new Error("Expected a user access record");
    return record;
  });
}

/** The storage of the account of user `name`, which is the Durable Object of that name. */
const accountStorage = (name: string) =>
  harness.server.getWorker("workshop-backend").getDurableObjectStorage("UserDurableObject", { name });

/**
 * How many rows the account of user `name` has written since its Durable Object started: its
 * records, which typed storage keeps through the KV API, and its alarm. Equal counts around a call
 * show that the call wrote nothing there.
 */
async function writes(name: string): Promise<number> {
  const rows = await (await accountStorage(name))
      .exec<{ n: number }>("SELECT total_changes() AS n");
  return rows[0]!.n;
}

/**
 * The tables of the account of user `name`. An account keeps its records in typed storage over
 * the KV API, whose table _cf_KV an object's first write creates, so an object with no table has
 * never been written. Miniflare's own tables, which any visit creates, are left out, and _cf_KV
 * itself cannot be read (SQLITE_AUTH), hence sqlite_master.
 */
async function tables(name: string): Promise<string[]> {
  const rows = await (await accountStorage(name)).exec<{ name: string }>(
      `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT GLOB '__miniflare*' ORDER BY name`);
  return rows.map(row => row.name);
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Waits until the account of user `name` has stopped writing (three reads of its write count,
 * 100 ms apart, agree) and answers with that count. A workspace reports to its owner's account
 * after the call that caused the report has returned (a chat's read cursor, an output, the last
 * activity), so a seeded account can still be written to once its seeding has returned.
 *
 * One report outlasts this wait: a workspace tells the account of its last activity at most once
 * a minute, so the seeding's later activity is reported a minute after its first. The calls a
 * case makes around a write count are over within seconds of the seeding.
 */
function quiet(name: string): Promise<number> {
  return waitFor(`the account of ${name} to go quiet`, async () => {
    const first = await writes(name);
    await pause(100);
    const second = await writes(name);
    await pause(100);
    return first === second && second === await writes(name) ? first : null;
  });
}

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

/** What a user sees of their own account: who they are, their workspaces, their connections. */
type Seen = {
  profile: AiChatAuthorInfo;
  workspaces: { id: string; title: string }[];
  accounts: ConnectedAccount[];
};

async function seenBy(api: RpcStub<AuthenticatedApi>): Promise<Seen> {
  return {
    profile: await api.whoami(),
    workspaces: (await api.listWorkspaces()).map(({ id, title }) => ({ id, title })),
    accounts: await listConnectedAccounts(api),
  };
}

type SeededUser = {
  /** The user's canonical id, which is their username and the name of their account's object. */
  id: string;
  /** What the user saw of their account once it was seeded. */
  seen: Seen;
  /** The user's one workspace. */
  workspace: { id: string; title: string };
  /** The blueprint published from that workspace. */
  blueprint: { id: string; title: string };
};

/**
 * A fresh user whose account holds something of each kind a view lists: the test account, which
 * the Workshop provisions with no sign-in, a model with secrets, a workspace, and a blueprint
 * published from it. The gadget behind the blueprint is seeded without a model: a human-only chat
 * submits one file at the empty head, and accepting it commits it.
 *
 * Everything the seeding opened is closed before this returns: the workspace, its gadget, their
 * subscriptions and the user's own connection. A workspace with a session open keeps writing to
 * its owner's account, which is not a view's doing.
 */
async function seededUser(prefix: string): Promise<SeededUser> {
  using stack = new DisposableStack();
  const [id] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), id!, `Name of ${id}`));
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  await api.addModel(MODEL.profile, MODEL.config);

  const ws = stack.use(await api.newWorkspace());
  const title = `Workspace of ${id}`;
  await ws.setTitle(title);
  const workspace = { id: (await ws.getMetadata()).id, title };

  const workpieces = new WorkpieceRecorder();
  const workpiecesStub = stack.use(stubFor(workpieces));
  stack.use(await ws.subscribeToWorkpieces(workpiecesStub));
  await workpieces.loaded;
  const gadget = stack.use(ws.createGadget("Notes", undefined, "NOTES"));
  const gadgetId = await gadget.getId();
  const empty = await headOf(workpieces, gadgetId);
  const seedChatId = await ws.newChat("Seed", null);
  await ws.submitCodeChange(seedChatId, {
    generation: 0, revision: 0, clientId: "seed", seq: 1,
    pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(new Map([[gadgetId, new Map()]]),
        new Map([[gadgetId, new Map([["notes.txt", NOTES]])]])),
  });
  expect(await ws.mergeChanges(seedChatId)).toEqual({ outcome: "merged" });
  await headOf(workpieces, gadgetId, empty);

  const published = await gadget.createBlueprint();
  await waitFor("the blueprint to reach its owner's account", async () =>
    (await api.listOwnBlueprints()).some(entry => entry.id === published.id) || null);
  // The account lists a workspace once it has heard of activity in it.
  await waitFor("the workspace to be listed in its owner's account", async () =>
    (await api.listWorkspaces()).some(entry => entry.id === workspace.id) || null);

  return {
    id: id!, seen: await seenBy(api), workspace,
    blueprint: { id: published.id, title: published.title },
  };
}

/** Fails if `answers`, as they arrived, hold any of MODEL_SECRETS. */
function expectNoModelSecret(answers: object): void {
  const text = JSON.stringify(answers);
  for (const secret of MODEL_SECRETS) expect(text).not.toContain(secret);
}

/** Runs one call of a view, named by its method, and answers with what the call answers. */
type Run = <T>(method: string, call: () => PromiseLike<T>) => PromiseLike<T>;

/**
 * The answer of each of `view`'s methods, called in the order ADMIN_USER_METHODS names them, each
 * through `run` when a case has something to check around every call.
 */
async function answersOf(view: RpcStub<AdminUserView>, run: Run = (_method, call) => call()) {
  return {
    describe: await run("describe", () => view.describe()),
    listWorkspaces: await run("listWorkspaces", () => view.listWorkspaces()),
    listConnectedAccounts: await run("listConnectedAccounts", () => view.listConnectedAccounts()),
    listModels: await run("listModels", () => view.listModels()),
    listSessions: await run("listSessions", () => view.listSessions()),
    listBlueprints: await run("listBlueprints", () => view.listBlueprints()),
    getDiagnostics: await run("getDiagnostics", () => view.getDiagnostics()),
  };
}

it("is reachable by a deployment admin alone", async () => {
  using stack = new DisposableStack();
  const [name] = nextUsernames("nonadmin");
  const user = stack.use(await signUp(stack.use(connect(harness.url)), name!));
  const ws = stack.use(await user.newWorkspace());
  expect(await user.getAdminApi()).toBeNull();

  // inspectUser() is not on AuthenticatedApi, and the open it reaches is on the account's Durable
  // Object, never on a capability a user holds: not their own, and not a workspace's.
  const terms = { via: "api", expiresAt: new Date(Date.now() + 60_000) };
  const loose = user as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  await expect(loose.inspectUser!(name, REASON)).rejects.toThrow();
  await expect(loose.openForAdmin!(ADMIN_USERNAME, REASON, "session", terms)).rejects.toThrow();
  const looseWs = ws as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  await expect(looseWs.openForAdmin!(ADMIN_USERNAME, REASON, "session", terms)).rejects.toThrow();
  expect(await userRecords(name!)).toEqual([]);
});

it("refuses a user that does not exist without creating an account", async () => {
  using stack = new DisposableStack();
  const [ghost, member] = nextUsernames("ghost", "member");
  // The probe addresses an account as the Workshop does, by its user's id: one that signed up
  // has the table.
  stack.use(await signUp(stack.use(connect(harness.url)), member!));
  expect(await tables(member!)).toContain("_cf_KV");
  expect(await tables(ghost!)).toEqual([]);

  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await refusalOf(admin.inspectUser(ghost!, REASON)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.userNotFound);
  }
  expect(await tables(ghost!)).toEqual([]);
  expect((await admin.listUsers({ query: ghost })).users).toEqual([]);
  expect((await admin.listAdminAudit({ owner: ghost })).records).toEqual([]);

  expect(await refusalOf(admin.inspectUser("", REASON)))
      .toBe(ADMIN_ACCESS_ERROR_CODES.userNotFound);
});

it("records every call into an account, and withholds what its user can read", async () => {
  const user = await seededUser("recorded");
  expect(user.seen.accounts).toHaveLength(1);
  const [connected] = user.seen.accounts;
  // The account is one the Workshop itself provisioned, and `autoProvisioned` is set by that
  // provisioning alone.
  const ambient = {
    id: connected!.id, vendorId: TEST_VENDOR_ID, autoProvisioned: true, credentialsExpired: false,
  };
  const published = {
    held: "published", title: user.blueprint.title, version: expect.any(Number),
    lastUpdated: expect.any(Date), workspaceId: user.workspace.id, featured: false,
  };
  // Each part a view withholds, as the user's own session gave it to them: it is in the account,
  // so its absence from the view's answers below is the view withholding it.
  const { displayName, uniqueName, singleton } = connected!.description;
  const withheld = [displayName!, uniqueName!, singleton!.tsType, user.blueprint.id];
  for (const part of withheld) expect(part.length, part).toBeGreaterThanOrEqual(8);

  using view = await admin.inspectUser(user.id, REASON);
  const answers = await answersOf(view);

  const logged = await userRecords(user.id);
  expect(logged.map(record => record.method)).toEqual(ADMIN_USER_METHODS.toReversed());
  const { sessionId } = logged[0]!;
  for (const record of logged) {
    expect(record).toMatchObject({
      kind: "user", userId: user.id, admin: ADMIN_USERNAME, reason: REASON, sessionId,
      via: "api", access: "metadata",
    });
    expect(record.refused).toBeUndefined();
    expect(Object.keys(record)).not.toContain("requested");
    expect(Object.keys(record)).not.toContain("exposed");
    expect(record.args).toEqual(record.method === "inspectUser"
        ? { expiresAt: answers.describe.expiresAt.toISOString() } : {});
  }

  expect(answers.describe).toMatchObject({
    profile: user.seen.profile, created: expect.any(Date), isAdmin: false, hasPassword: true,
    counts: {
      ownedWorkspaces: 1, sharedWorkspaces: 0, connectedAccounts: 1, models: 1, sessions: 1,
      ownBlueprints: 1, libraryBlueprints: 0,
    },
  });
  expect(answers.describe).not.toHaveProperty("access");
  expect(answers.listWorkspaces).toEqual([{
    ...user.workspace, created: expect.any(Date), lastActive: expect.any(Date),
  }]);
  expect(answers.listModels.models).toEqual([{
    id: MODEL.profile.id, name: MODEL.profile.name, provider: MODEL.config.provider,
    model: MODEL.config.model, customApiUrl: true,
  }]);
  // The account and the blueprint are listed, without what the gatekeeper says of the one and
  // without the id of the other.
  expect(answers.listConnectedAccounts).toEqual([ambient]);
  expect(answers.listConnectedAccounts[0]).not.toHaveProperty("description");
  expect(answers.listBlueprints).toEqual([published]);
  expect(answers.listBlueprints[0]).not.toHaveProperty("id");
  const text = JSON.stringify(answers);
  for (const part of withheld) expect(text, part).not.toContain(part);
  expectNoModelSecret(answers);
  // A session is listed by when it was created and when it stops working, and by nothing that
  // names its token.
  expect(answers.listSessions.total).toBe(1);
  expect(answers.listSessions.sessions).toHaveLength(1);
  for (const session of answers.listSessions.sessions) {
    expect(session.created).toBeInstanceOf(Date);
    expect(Object.keys(session)
        .filter(key => !["created", "expiresAt", "pendingUntil"].includes(key))).toEqual([]);
  }

  // A user's records are those of their account and of the workspaces they own.
  using _workspaceView = await admin.inspectWorkspace(user.workspace.id, REASON);
  const kinds = (await admin.listAdminAudit({ owner: user.id, limit: 200 })).records
      .map(record => record.kind);
  expect(new Set(kinds)).toEqual(new Set(["user", "workspace"]));
});

it("has no level above metadata", async () => {
  const user = await seededUser("nolevel");

  // An inspection has no level to ask for: the option is not one, and the view is as any other.
  using view = await admin.inspectUser(user.id, REASON, { access: "full" } as never);
  expect(await view.describe()).not.toHaveProperty("access");
  for (const account of await view.listConnectedAccounts()) {
    expect(account).not.toHaveProperty("description");
  }
  for (const blueprint of await view.listBlueprints()) expect(blueprint).not.toHaveProperty("id");
  const logged = await userRecords(user.id);
  expect(logged.map(record => record.method))
      .toEqual(["listBlueprints", "listConnectedAccounts", "describe", "inspectUser"]);
  for (const record of logged) {
    expect(record).toMatchObject({ access: "metadata" });
    expect(Object.keys(record)).not.toContain("requested");
  }

  // Nor is there one to set: nothing is stored, and the view answers as it did.
  await expect(admin.setAdminWorkspaceAccess("full" as never)).rejects.toThrow(TypeError);
  expect((await admin.getSettings()).adminWorkspaceAccess)
      .toEqual({ effective: "metadata", chosen: "metadata", max: "metadata" });
  expect((await view.listConnectedAccounts())[0]).not.toHaveProperty("description");
});

it("turns a live view off and on with the deployment's level, recording what that refuses",
    async () => {
  const user = await seededUser("levels");
  const viewReason = "Opened before access was turned off";
  const { accessOff } = ADMIN_ACCESS_ERROR_CODES;

  try {
    using view = await admin.inspectUser(user.id, viewReason);
    expect(await view.listWorkspaces()).toHaveLength(1);

    await admin.setAdminWorkspaceAccess("off");
    const offReason = "Off-mode check";
    expect(await refusalOf(admin.inspectUser(user.id, offReason))).toBe(accessOff);
    expect((await userRecords(user.id))[0]).toMatchObject({
      kind: "user", userId: user.id, method: "inspectUser", admin: ADMIN_USERNAME,
      reason: offReason, access: "off", refused: accessOff,
    });
    await waitFor("the live view to be turned off", async () =>
      await outcomeOf(view.listWorkspaces()) === accessOff || null);
    expect((await userRecords(user.id))[0]).toMatchObject({
      method: "listWorkspaces", reason: viewReason, access: "off", refused: accessOff,
    });

    // The same view answers again once the level is back, within its lifetime.
    await admin.setAdminWorkspaceAccess("metadata");
    await waitFor("the live view to answer again", async () =>
      await outcomeOf(view.listWorkspaces()) === null || null);
    expect((await userRecords(user.id))[0]).toMatchObject({
      method: "listWorkspaces", reason: viewReason, access: "metadata",
    });
    expect((await userRecords(user.id))[0]).not.toHaveProperty("refused");

    // A malformed open is refused before the level is read, and nothing records it. Checked with
    // inspection on, where a well-formed open would succeed.
    const logged = await userRecords(user.id);
    for (const reason of ["", "   ", "x".repeat(MAX_ADMIN_ACCESS_REASON_LENGTH + 1)]) {
      await expect(admin.inspectUser(user.id, reason), `reason of ${reason.length}`)
          .rejects.toThrow();
    }
    for (const lifetimeSeconds of [0, MAX_ADMIN_VIEW_LIFETIME_SECONDS + 1, 1.5]) {
      await expect(admin.inspectUser(user.id, REASON, { lifetimeSeconds }),
          `lifetime ${lifetimeSeconds}`).rejects.toThrow();
    }
    expect(await userRecords(user.id)).toEqual(logged);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

// What this case cannot show, and admin-user-view.test.ts does:
//   - That a view leaves the user's last login and the deployment directory alone. A user who
//     signed up moments ago has nothing due (an account tells the directory of a session at most
//     hourly, and the directory has this profile), so the directory would list them the same
//     whether or not a view started a sync. The unit suite seeds an account with both kinds of
//     sync due.
//   - What a wake does. The account's Durable Object is awake from its seeding through every
//     bracket, and total_changes() restarts with the object, so a bracket cannot span a restart.
//     The unit suite evicts an account with nothing queued and inspects it as it wakes, and evicts
//     one with a notification queued, which the wake delivers: the one exception to "changes
//     nothing", and the wake's doing, not the view's.
it("writes nothing to the account it inspects, and leaves what its user sees as it was",
    async () => {
  using stack = new DisposableStack();
  const user = await seededUser("untouched");
  const { accessOff } = ADMIN_ACCESS_ERROR_CODES;
  // Keeps a late write of the seeding out of the first bracket. It is not the proof.
  await quiet(user.id);
  // The premise of that one exception, checked and not assumed: nothing is queued, so nothing
  // that wakes the account during the brackets has anything to deliver.
  {
    using premise = await admin.inspectUser(user.id, REASON);
    expect((await premise.getDiagnostics()).queuedNotifications,
        "notifications the seeding left queued, which any wake would deliver").toBe(0);
  }

  // The proof is a bracket around each admin call: the account's write count before it and after.
  const unchangedBy = async <T>(what: string, call: () => PromiseLike<T>): Promise<T> => {
    const before = await writes(user.id);
    const answer = await call();
    expect(await writes(user.id), what).toBe(before);
    return answer;
  };
  const start = await writes(user.id);

  try {
    const view = stack.use(await unchangedBy("an open", () => admin.inspectUser(user.id, REASON)));
    const first = await answersOf(view, (method, call) => unchangedBy(`${method}()`, call));

    await unchangedBy("setting the level to off", () => admin.setAdminWorkspaceAccess("off"));
    expect(await unchangedBy("an open refused at off",
        () => refusalOf(admin.inspectUser(user.id, REASON)))).toBe(accessOff);
    await unchangedBy("a live view's calls until one is refused at off",
        () => waitFor("the live view to be turned off", async () =>
          await outcomeOf(view.describe()) === accessOff || null));
    await unchangedBy("an open with a blank reason",
        () => expect(admin.inspectUser(user.id, "  ")).rejects.toThrow());

    await unchangedBy("setting the level to metadata",
        () => admin.setAdminWorkspaceAccess("metadata"));
    await unchangedBy("a live view's calls until one answers again",
        () => waitFor("the live view to answer again", async () =>
          await outcomeOf(view.describe()) === null || null));
    const last = await unchangedBy("listSessions() on the view that answers again",
        () => view.listSessions());

    // No session was started for any of it, and nothing was written between the brackets.
    expect(last.total).toBe(first.listSessions.total);
    expect(await writes(user.id), "the whole sequence").toBe(start);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }

  // The user signs in again, after the brackets since a sign-in stores a session, and sees what
  // they saw before any of it.
  const api = stack.use(await logIn(stack.use(connect(harness.url)), user.id));
  expect(await seenBy(api)).toEqual(user.seen);

  // Control: an ordinary write moves the count, so each bracket could have failed.
  const before = await writes(user.id);
  await api.setOwnDisplayName(`Renamed ${user.id}`);
  expect(await writes(user.id)).toBeGreaterThan(before);
});

it("fails a call whose audit record cannot be written, returning nothing and writing nothing",
    async () => {
  const user = await seededUser("unaudited");
  // Addresses the deployment-wide log, which is always getByName("").
  const audit = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });

  using view = await admin.inspectUser(user.id, REASON);
  const logged = await userRecords(user.id);
  expect(logged.map(record => record.method)).toEqual(["inspectUser"]);
  const written = await quiet(user.id);

  try {
    await audit.exec(`CREATE TRIGGER admin_audit_unavailable BEFORE INSERT ON admin_audit
        BEGIN SELECT RAISE(ABORT, 'admin audit unavailable'); END`);
    await expect(view.listConnectedAccounts()).rejects.toThrow();
    await expect(admin.inspectUser(user.id, REASON)).rejects.toThrow();
  } finally {
    await audit.exec("DROP TRIGGER IF EXISTS admin_audit_unavailable");
  }
  expect(await writes(user.id)).toBe(written);
  expect(await userRecords(user.id)).toEqual(logged);

  // The same view answers once its call can be recorded, so it was the record that failed.
  expect(await view.listConnectedAccounts()).toHaveLength(1);
  expect((await userRecords(user.id)).map(record => record.method))
      .toEqual(["listConnectedAccounts", "inspectUser"]);
});
