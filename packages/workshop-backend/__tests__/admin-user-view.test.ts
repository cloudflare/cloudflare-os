// A deployment admin's read-only view of a user's account (UserDurableObject.openForAdmin() and
// AdminUserView): what it refuses before recording anything, what it records and where, each
// answer whole, what a level below "full" withholds, that no credential is in any answer, how a
// live view follows the deployment's setting, and that nothing it does changes the account,
// reaches a gatekeeper or tells the deployment directory.
//
// Runs against a real UserDurableObject (the TEST_USER binding) whose `env` is replaced per test
// with the pool's plus a fake BLUEPRINTS serving the deployment's settings. The deployment-wide
// log is the real AdminAuditDurableObject the account reaches through ctx.exports, read back
// through the TEST_ADMIN_AUDIT binding, and the directory the real one behind TEST_USER_DIRECTORY.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_LIST_MAX_LIMIT, ADMIN_USER_METHODS,
  MAX_ADMIN_ACCESS_REASON_LENGTH, getAdminAccessErrorCode,
  type AdminUserAccessRecord, type AdminUserView, type AdminWorkspaceAccess,
  type AiChatAuthorInfo,
} from "@gadgets/workshop-shared/api";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { AdminViewTerms } from "../src/admin-access.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { openAdminUserView, type AdminUserViewHost } from "../src/admin-user-view.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import type { UserStorage } from "../src/storage-schema/user-storage.js";
import {
  DIRECTORY_ACTIVITY_INTERVAL_MS, type UserDirectoryDurableObject,
} from "../src/user-directory.js";
import type { UserDurableObject } from "../src/user.js";
import { rpcSurface } from "./rpc-surface.js";
import type { FakeGatekeeperAccount } from "./test-worker.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

// The pool's ADMINS.
const ADMIN = "deployment-admin@example.test";
const REASON = "Support ticket 42";
const SESSION_ID = "session-1";
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;
// A view that outlives its open by a margin a slow runner keeps, then expires within the test.
const SHORT_LIFETIME_MS = 1000;
const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
// An environment whose cap lets the deployment's setting decide.
const UNCAPPED = { ADMIN_WORKSPACE_ACCESS_MAX: "full" };
// The view's methods, in the order answersOf() calls them.
const READS = ADMIN_USER_METHODS.filter(method => method !== "inspectUser");

// One test's account: its id, which names its Durable Object, and the deployment's stored
// settings as the fake KV serves them to it.
type Account = {
  id: string;
  stub: DurableObjectStub<UserDurableObject>;
  config: { adminWorkspaceAccess: AdminWorkspaceAccess; adminAuditRetentionDays: number };
};

// The account's Durable Object as one runInDurableObject callback holds it: an eviction ends the
// instance, and the next callback meets the object as its constructor made it from stored state.
type Live = Account & {
  instance: UserDurableObject;
  state: DurableObjectState;
  // The instance's own typed storage, so a put through it reaches the instance's subscribers.
  storage: UserStorage;
};

// What these tests reach of a UserDurableObject beyond its public methods.
type Internals = {
  env: Cloudflare.Env;
  storage: UserStorage;
  ctx: DurableObjectState & {
    exports: {
      FakeGatekeeperAccount(options: { props: { name: string } }): Fetcher<FakeGatekeeperAccount>;
    };
  };
};

function internals(instance: UserDurableObject): Internals {
  return instance as unknown as Internals;
}

function newAccount(): Account {
  let id = `view${crypto.randomUUID().replaceAll("-", "")}`;
  return {
    id, stub: env.TEST_USER.getByName(id),
    config: { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: RETENTION },
  };
}

// Sets the instance's env to the pool's plus a fake BLUEPRINTS serving `user.config`, and `vars`.
function setEnv(user: Live, vars: Record<string, unknown> = {}): void {
  internals(user.instance).env = {
    ...env,
    BLUEPRINTS: {
      get: async (key: string) => key === ADMIN_CONFIG_KEY ? JSON.stringify(user.config) : null,
    },
    ...vars,
  } as unknown as Cloudflare.Env;
}

// Runs `fn` on the account's Durable Object as it is now, its environment replaced.
function inAccount<T>(account: Account, fn: (user: Live) => Promise<T>,
                      vars: Record<string, unknown> = {}): Promise<T> {
  return runInDurableObject(account.stub, async (instance: UserDurableObject, state) => {
    let user: Live = { ...account, instance, state, storage: internals(instance).storage };
    setEnv(user, vars);
    return fn(user);
  });
}

// Runs `fn` on a fresh Durable Object that holds no account yet: createAccount() or seed() makes
// one.
function withAccount(fn: (user: Live) => Promise<void>): Promise<void> {
  return inAccount(newAccount(), fn);
}

// Signs the account up, returning its browser session's token.
async function createAccount(user: Live): Promise<string> {
  let token = await user.instance.createAccount(user.id, "Viewed User", PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${user.id}.`);
  return token;
}

// A view asks for the level it is minted at unless `overrides` says otherwise.
function terms(overrides: Partial<AdminViewTerms> = {}): AdminViewTerms {
  return {
    via: "api", access: "metadata", expiresAt: new Date(Date.now() + 600_000), ...overrides,
    requested: overrides.requested ?? overrides.access ?? "metadata",
  };
}

function open(user: Live, overrides: Partial<AdminViewTerms> = {}, admin = ADMIN,
              reason = REASON): Promise<AdminUserView> {
  return user.instance.openForAdmin(admin, reason, SESSION_ID, terms(overrides));
}

// The code a refusal carries, failing the test if `promise` resolves.
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? `uncoded: ${String(err)}`;
  }
  throw new Error("Expected a refusal.");
}

// The deployment-wide log's records of access to this account, oldest first.
async function recordsOf(id: string): Promise<AdminUserAccessRecord[]> {
  let page = await env.TEST_ADMIN_AUDIT.getByName("").list({ owner: id, limit: 200 }, RETENTION);
  return (page.records as AdminUserAccessRecord[]).toReversed();
}

// The account as the deployment directory lists it.
async function listed(id: string) {
  let { users } = await env.TEST_USER_DIRECTORY.getByName("").listUsers({ query: id, limit: 10 });
  return users.find(user => user.id === id);
}

// Lets a directory sync the account may have started land: its acknowledgement, which is what
// writes directoryRev and directoryLoginAt, arrives no later than a round trip made after it, and
// its handler runs within a turn of that.
async function settled(id: string): Promise<void> {
  await listed(id);
  await new Promise(resolve => setTimeout(resolve, 0));
}

// A copy of `value` without the keys whose value is undefined, at any depth: such a key carries
// nothing, and a read may copy an absent optional field straight from a record.
function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(defined) as T;
  if (value === null || typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, defined(item)])) as T;
}

// Every answer of `view`, by method, in READS order, less the keys that carry nothing.
async function answersOf(view: AdminUserView) {
  return defined({
    describe: await view.describe(),
    listWorkspaces: await view.listWorkspaces(),
    listConnectedAccounts: await view.listConnectedAccounts(),
    listModels: await view.listModels(),
    listSessions: await view.listSessions(),
    listBlueprints: await view.listBlueprints(),
    getDiagnostics: await view.getDiagnostics(),
  });
}

// How many writes the object's storage has taken since the object started: the count belongs to
// its SQL connection, so it starts again when the object does.
function changes(state: DurableObjectState): number {
  return Number(state.storage.sql.exec("SELECT total_changes() AS n").one().n);
}

// Everything the account stores, by key, as plain data: a record that holds a gatekeeper stub (a
// connected account's `account`, a pending handoff's `connect.account`) is read without it, so a
// dump can be compared once the instance that took it is gone.
function dump(state: DurableObjectState): [string, unknown][] {
  return [...state.storage.kv.list()].map(([key, value]): [string, unknown] => {
    if (key.startsWith("connectedAccounts:")) {
      let { account: _account, ...record } = value as Record<string, unknown>;
      return [key, record];
    }
    if (key.startsWith("pendingHandoffs:")) {
      let { connect, ...record } = value as { connect?: Record<string, unknown> };
      if (connect === undefined) return [key, record];
      let { account: _account, ...staged } = connect;
      return [key, { ...record, connect: staged }];
    }
    return [key, value];
  });
}

// A gatekeeper account the object can persist (a WorkerEntrypoint reached through ctx.exports, as a
// real gatekeeper's is), viewed as the GatekeeperUser the kernel expects. The fake records what it
// is asked by `name`, so a stub minted again under a name answers for the same account.
function fakeAccount(user: Live, name: string): Fetcher<GatekeeperUser> {
  return internals(user.instance).ctx.exports.FakeGatekeeperAccount({ props: { name } }) as
      unknown as Fetcher<GatekeeperUser>;
}

// What the fake account `name` has been asked, read through a stub minted in this callback: one
// minted in an earlier callback belongs to an instance that is gone.
function fakeCalls(user: Live, name: string): Promise<string[]> {
  return internals(user.instance).ctx.exports.FakeGatekeeperAccount({ props: { name } }).calls();
}

// What `value` holds that no answer may, at any depth: binary data (a stored hash is bytes, which
// no string search sees) and a property named `account` (a stored record's gatekeeper stub).
function forbidden(value: unknown, path = "$"): string[] {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return [`${path} is binary`];
  if (value === null || typeof value !== "object" || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === "account" ? [`${path}.${key} is a stub's property`] : []),
    ...forbidden(item, `${path}.${key}`),
  ]);
}

// --- The seed ---
//
// Every field the answers name gets a value that is not its default, and each flag is seeded both
// ways, so a view that never returned a field, or always returned its default, fails "returns
// each answer whole". The seven counts describe() reports are pairwise different: shared
// workspaces 1, connected accounts 2, models 3, owned workspaces 4, the user's own blueprints 5,
// library blueprints 6, sessions 7.

const VENDOR = "http";
const OWNER: AiChatAuthorInfo = { type: "user", id: "sharer@example.test", name: "Sharing User" };
// A past instant of the seed's choosing, `hours` before one in 2025.
const past = (hours: number) => new Date(Date.UTC(2025, 5, 1, 12) - hours * 3_600_000);
const LAST_LOGIN = past(1).getTime();
const LAST_ACTIVE = past(2);
const CREDITS_UPDATED_AT = past(3).getTime();
const MUTE_UNTIL = new Date(Date.UTC(2031, 0, 1));
const CREDENTIAL_EXPIRES = new Date(Date.UTC(2031, 5, 1));
// The auto-provisioned account's description, as the test stores it.
const AUTO_DESCRIPTION: AccountDescription = {
  displayName: "Context Library", uniqueName: "context:viewed",
  avatar: { url: "https://example.test/context.png" },
  grantedResourceUrlPatterns: ["context://*"], singleton: { tsType: "ContextSession" },
  providesUi: { title: "Context" },
};
// Made-up credentials, each occurring nowhere else in the seed, so a hit can only be a leak.
const MODEL_TOKEN = "model-token-5d1f7a";
const MODEL_URL_PASSWORD = "url-password-83c2e1";
const MODEL_URL_KEY = "url-key-6b40d9";
const MODEL_HEADER_VALUE = "header-value-1e97c4";
const BILLING_ACCOUNT_NAME = "Billing Name 7f20b6";

type Seeded = {
  // The browser session's token, as createAccount() returned it.
  token: string;
  // The linked account's name, an address carrying a token, which also names its fake.
  tokenName: string;
  // The name of the fake behind the auto-provisioned account.
  autoName: string;
  alarmAt: number;
  deviceExpiresAt: Date;
  stagedExpiresAt: Date;
  stagedPendingUntil: Date;
  // Every credential the account stores, as a string.
  secrets: string[];
};

function blueprintMetadata(title: string, version: number, lastUpdated: Date) {
  return {
    title, description: `${title}, described`, author: OWNER, created: past(100), version,
    lastUpdated, bindings: {},
  };
}

// A device handoff's record, every string of it made up.
function deviceHandoff(label: string, expiresAt: Date) {
  return {
    stateHash: `state-hash-${label}`, ticketHash: `ticket-hash-${label}`,
    publicKey: `public-key-${label}`, expiresAt, sessionTokenId: `handoff-session-${label}`,
    handoff: {
      publicKey: `sealed-key-${label}`, salt: `sealed-salt-${label}`, iv: `sealed-iv-${label}`,
      ciphertext: `sealed-text-${label}`,
    },
  };
}

// The id a session is stored under: the SHA-256 of its token.
async function tokenIdOf(token: string): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.fromBase64(token)))
      .toHex();
}

// Seeds the account in this order: the object's own methods, then the records put through
// `storage`, then the alarm. Several methods (recordSharedWorkspaceOpen() among them) re-arm the
// account's sweep from its stored expiries, and a sweep armed over the lapsed records below would
// fire at once and delete them, so no method of the object runs after the first put.
async function seed(user: Live): Promise<Seeded> {
  let { instance, storage, state, id } = user;

  let token = await createAccount(user);
  await instance.authenticate(token);
  // The sign-in tells the directory, whose acknowledgement writes directoryRev and
  // directoryLoginAt: one that landed later would overwrite what is stored below.
  await vi.waitFor(async () => {
    expect(await listed(id)).toMatchObject({ name: "Viewed User", lastLogin: expect.any(Date) });
    expect(storage.directoryRev.get()).toBe(storage.profileRev.get());
  }, { timeout: 10_000, interval: 20 });
  await instance.completeOnboarding();
  for (let n of [1, 2, 3, 4]) await instance.newWorkspace(`ws-owned-${n}`, `Owned ${n}`);
  await instance.setWorkspaceLastActive("ws-owned-1", LAST_ACTIVE, 1.25);
  await instance.setWorkspaceLastActive("ws-owned-2", LAST_ACTIVE, undefined);
  await instance.setWorkspaceLastActive("ws-owned-3", LAST_ACTIVE, undefined);
  await instance.recordSharedWorkspaceOpen("ws-shared", "Shared notes", OWNER, "build", []);
  // Linked with an expiry, then reported expired: not auto-provisioned.
  let tokenName = `https://hooks.example.test/${id}?token=webhook-token-2c8e`;
  let linked = await instance.linkConnectedAccountFromLogin(
      fakeAccount(user, tokenName), VENDOR, CREDENTIAL_EXPIRES);
  await instance.markCredentialsExpired(linked);

  // Auto-provisioned, with no expiry and not expired. Only the object's own provisioning writes
  // that flag, and it needs a vendor binding the pool does not have.
  let autoName = `auto-${id}`;
  let autoId = storage.nextAccountId.get();
  storage.connectedAccounts.put({
    id: autoId, account: fakeAccount(user, autoName), description: AUTO_DESCRIPTION,
    vendorId: "context", autoProvisioned: true,
  });
  storage.nextAccountId.put(autoId + 1);
  storage.gadgets.put(
      { ...storage.gadgets.get("ws-owned-2")!, notificationMute: { until: MUTE_UNTIL } });
  storage.directoryLoginAt.put(LAST_LOGIN);

  // Each seeded session was created in the past, so the browser session is the latest.
  let now = Date.now();
  let deviceExpiresAt = new Date(now + 30 * 86_400_000);
  let stagedExpiresAt = new Date(now + 29 * 86_400_000);
  let stagedPendingUntil = new Date(now + 300_000);
  storage.sessions.put(
      { tokenId: "device-token-id-41aa", created: past(10), expiresAt: deviceExpiresAt });
  storage.sessions.put({
    tokenId: "staged-token-id-52bb", created: past(11), expiresAt: stagedExpiresAt,
    pendingUntil: stagedPendingUntil,
  });
  for (let n of [12, 13, 14, 15]) {
    storage.sessions.put({ tokenId: `plain-token-id-${n}-63cc`, created: past(n) });
  }

  storage.aiModels.put({
    profile: { type: "agent", id: "model-a", name: "Custom A" },
    config: {
      provider: "openai", model: "example-model-a", apiToken: MODEL_TOKEN,
      apiUrl: `https://user:${MODEL_URL_PASSWORD}@llm.example.test/v1?key=${MODEL_URL_KEY}`,
      extraHeaders: { "x-proxy-auth": MODEL_HEADER_VALUE },
    },
  });
  storage.aiModels.put({
    profile: { type: "agent", id: "model-b", name: "Plain B" },
    config: { provider: "anthropic", model: "example-model-b", apiToken: "" },
  });
  storage.aiModels.put({
    profile: { type: "agent", id: "model-c", name: "Plain C" },
    config: { provider: "ollama", model: "example-model-c", apiToken: "" },
  });
  storage.preferredModel.put("model-b");
  storage.quickModel.put("model-c");

  storage.blueprints.put({
    id: "bp-own-1", metadata: blueprintMetadata("Featured kit", 3, past(21)),
    gadgetId: "ws-owned-1", featured: true,
  });
  // Published from a workspace the account no longer lists, and never featured.
  storage.blueprints.put({
    id: "bp-own-2", metadata: blueprintMetadata("Plain kit", 1, past(22)), gadgetId: "ws-gone",
  });
  storage.blueprints.put(
      { id: "bp-own-3", metadata: blueprintMetadata("Imported kit", 7, past(23)) });
  for (let n of [4, 5]) {
    storage.blueprints.put({
      id: `bp-own-${n}`, metadata: blueprintMetadata(`Kit ${n}`, 2, past(20 + n)),
      gadgetId: "ws-owned-2", featured: false,
    });
  }
  for (let n of [1, 2, 3, 4, 5, 6]) {
    storage.libraryBlueprints.put({
      id: `bp-lib-${n}`, metadata: blueprintMetadata(`Library ${n}`, 10 + n, past(30 + n)),
      addedAt: past(40 + n), uploaded: n <= 3,
    });
  }

  // Two live flows and a lapsed one, one live handoff and a lapsed one: the two counts differ.
  storage.pendingConnectFlows.put(
      { nonceHash: "nonce-hash-live-1", accountId: linked, expiresAt: new Date(now + 600_000) });
  storage.pendingConnectFlows.put(
      { nonceHash: "nonce-hash-live-2", accountId: autoId, expiresAt: new Date(now + 900_000) });
  storage.pendingConnectFlows.put(
      { nonceHash: "nonce-hash-lapsed", accountId: linked, expiresAt: new Date(now - 60_000) });
  storage.pendingDeviceHandoffs.put(deviceHandoff("live", new Date(now + 600_000)));
  storage.pendingDeviceHandoffs.put(deviceHandoff("lapsed", new Date(now - 60_000)));

  storage.dailyLlmCount.put({ day: "2025-06-01", count: 17 });
  storage.cloudflareBilling.put({
    accountId: "billing-account-id-1", accountName: BILLING_ACCOUNT_NAME, creditsRemaining: 12.5,
    creditsUpdatedAt: CREDITS_UPDATED_AT,
  });
  storage.phoneNotificationSubscriptions.put({ "phone-device-key-1": "phone-subscription-1" });
  storage.browserNotificationSubscriptions.put({
    "browser-device-key-1": "browser-subscription-1",
    "browser-device-key-2": "browser-subscription-2",
  });

  // An hour ahead, so it never fires in a run.
  let alarmAt = now + 3_600_000;
  await state.storage.setAlarm(alarmAt);

  let passwordHash = storage.passwordHashHash.get()!;
  let secrets = [
    token, ...[...storage.sessions.list()].map(session => session.tokenId),
    passwordHash.toHex(), passwordHash.toBase64(),
    MODEL_TOKEN, MODEL_URL_PASSWORD, MODEL_URL_KEY, MODEL_HEADER_VALUE,
    ...[...storage.pendingConnectFlows.list()].map(flow => flow.nonceHash),
    ...[...storage.pendingDeviceHandoffs.list()].flatMap(pending => [
      pending.stateHash, pending.ticketHash, pending.publicKey, pending.sessionTokenId!,
      ...Object.values(pending.handoff),
    ]),
    ...Object.entries(storage.phoneNotificationSubscriptions.get()).flat(),
    ...Object.entries(storage.browserNotificationSubscriptions.get()).flat(),
    BILLING_ACCOUNT_NAME,
  ];
  return {
    token, tokenName, autoName, alarmAt, deviceExpiresAt, stagedExpiresAt, stagedPendingUntil,
    secrets,
  };
}

describe("opening an admin user view", () => {
  it("refuses an account never created without creating it", () => withAccount(async user => {
    let before = changes(user.state);
    expect(await codeOf(open(user))).toBe(ADMIN_ACCESS_ERROR_CODES.userNotFound);
    // Before anything else: malformed terms for no account are refused the same way.
    expect(await codeOf(open(user, {}, ADMIN, "   ")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.userNotFound);
    expect(dump(user.state)).toStrictEqual([]);
    expect(changes(user.state)).toBe(before);
    expect(await user.state.storage.getAlarm()).toBeNull();
    expect(await recordsOf(user.id)).toStrictEqual([]);
  }));

  it("refuses, unrecorded, a caller who is not an admin, malformed terms and a past expiry",
      () => withAccount(async user => {
    await createAccount(user);
    expect(await codeOf(open(user, {}, "someone@example.test")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    await expect(open(user, {}, ADMIN, "   ")).rejects.toThrow(TypeError);
    await expect(open(user, {}, ADMIN, "x".repeat(MAX_ADMIN_ACCESS_REASON_LENGTH + 1)))
        .rejects.toThrow(TypeError);
    await expect(open(user, { via: "gatekeeper" as any })).rejects.toThrow(TypeError);
    await expect(open(user, { access: "off" as any })).rejects.toThrow(TypeError);
    await expect(open(user, { requested: "everything" as any })).rejects.toThrow(TypeError);
    await expect(open(user, { requested: "metadata", access: "full" })).rejects.toThrow(TypeError);
    await expect(open(user, { expiresAt: new Date(NaN) })).rejects.toThrow(TypeError);
    await expect(open(user, { expiresAt: new Date(Date.now() + 2 * 3_600_000) }))
        .rejects.toThrow(TypeError);
    // An expiry already past is not malformed: the open is refused as any call on an expired
    // view is.
    expect(await codeOf(open(user, { expiresAt: new Date(Date.now() - 1) })))
        .toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect(await recordsOf(user.id)).toStrictEqual([]);
  }));

  it("records the open, with its trimmed reason, before the view is returned",
      () => withAccount(async user => {
    await createAccount(user);
    let viewTerms = terms({ via: "cli", requested: "full" });
    let before = Date.now();
    await user.instance.openForAdmin(ADMIN, `  ${REASON}  `, SESSION_ID, viewTerms);
    let records = await recordsOf(user.id);
    expect(records).toStrictEqual([{
      kind: "user", userId: user.id, at: expect.any(Date), admin: ADMIN, sessionId: SESSION_ID,
      via: "cli", method: "inspectUser", args: { expiresAt: viewTerms.expiresAt.toISOString() },
      reason: REASON, requested: "full", access: "metadata", exposed: "metadata",
    }]);
    expect(records[0]!.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(records[0]!.at.getTime()).toBeLessThanOrEqual(Date.now());
  }));

  it("exposes no method but the ones the audit names", () => withAccount(async user => {
    await createAccount(user);
    // Called inside the object, the open returns the view itself and not a stub.
    let view = await open(user);
    expect(view).toBeInstanceOf(RpcTarget);
    expect(rpcSurface(view)).toStrictEqual(
        new Set(ADMIN_USER_METHODS.filter(method => method !== "inspectUser")));
  }));
});

describe("a metadata view", () => {
  it("records every call as metadata, and withholds descriptions and blueprint ids alone",
      () => withAccount(async user => {
    await seed(user);
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    let expiresAt = new Date(Date.now() + 600_000);
    let full = await answersOf(await open(user, { access: "full", expiresAt }));
    let fullRecords = await recordsOf(user.id);

    let answers = await answersOf(await open(user, { expiresAt }));
    let records = (await recordsOf(user.id)).slice(fullRecords.length);
    expect(records.map(record => record.method)).toStrictEqual([...ADMIN_USER_METHODS]);
    for (let record of records) {
      expect(record).toMatchObject({
        kind: "user", userId: user.id, requested: "metadata", access: "metadata",
        exposed: "metadata",
      });
      expect(record).not.toHaveProperty("refused");
    }

    expect(answers.listConnectedAccounts).toHaveLength(2);
    for (let account of answers.listConnectedAccounts) {
      expect(account).not.toHaveProperty("description");
    }
    expect(answers.listBlueprints).toHaveLength(11);
    for (let blueprint of answers.listBlueprints) expect(blueprint).not.toHaveProperty("id");

    // Every other field is the "full" view's.
    expect(answers).toStrictEqual({
      ...full,
      describe: { ...full.describe, access: "metadata" },
      listConnectedAccounts: full.listConnectedAccounts.map(
          ({ description: _description, ...account }) => account),
      listBlueprints: full.listBlueprints.map(({ id: _id, ...blueprint }) => blueprint),
    });
  }));
});

describe("a full view", () => {
  it("records the descriptions and the blueprint ids it returns as content, and nothing else",
      () => withAccount(async user => {
    let seeded = await seed(user);
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    let answers = await answersOf(await open(user, { access: "full" }));

    let records = await recordsOf(user.id);
    expect(records.map(record => [record.method, record.exposed])).toStrictEqual([
      ["inspectUser", "metadata"], ["describe", "metadata"], ["listWorkspaces", "metadata"],
      ["listConnectedAccounts", "content"], ["listModels", "metadata"],
      ["listSessions", "metadata"], ["listBlueprints", "content"],
      // Its billing account's id and balance included, which are metadata at every level.
      ["getDiagnostics", "metadata"],
    ]);
    expect(answers.getDiagnostics.billing).toBeDefined();
    for (let record of records) {
      expect(record).toMatchObject({ requested: "full", access: "full", args: {} });
    }

    // A description is returned as its gatekeeper stored it: a name that carries a token is
    // returned with it.
    let [linked] = answers.listConnectedAccounts;
    expect(linked!.description).toStrictEqual(
        { displayName: seeded.tokenName, uniqueName: seeded.tokenName });
    expect(seeded.tokenName).toContain("?token=");
    expect(JSON.stringify(answers)).toContain(seeded.tokenName);
  }));

  it("records metadata for an account with no connected account and no blueprint",
      () => withAccount(async user => {
    await createAccount(user);
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    let view = await open(user, { access: "full" });
    expect(await view.listConnectedAccounts()).toStrictEqual([]);
    expect(await view.listBlueprints()).toStrictEqual([]);
    expect((await recordsOf(user.id)).map(record => [record.method, record.access, record.exposed]))
        .toStrictEqual([
          ["inspectUser", "full", "metadata"], ["listConnectedAccounts", "full", "metadata"],
          ["listBlueprints", "full", "metadata"],
        ]);
  }));

  // Each expectation is written out field by field from what the seed chose (a timestamp it did
  // not choose is read from storage, one field at a time), never by spreading a stored record:
  // that would carry the record's other fields into the expectation. So a field the API does not
  // name fails the case, whatever it holds.
  it("returns each answer whole", () => withAccount(async user => {
    let seeded = await seed(user);
    let storage = user.storage;
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    let viewTerms = terms({ access: "full" });
    let answers = await answersOf(
        await user.instance.openForAdmin(ADMIN, REASON, SESSION_ID, viewTerms));

    expect(answers.describe).toStrictEqual({
      profile: { type: "user", name: "Viewed User", id: user.id },
      created: storage.createdAt.get(),
      lastLogin: new Date(LAST_LOGIN),
      isAdmin: false,
      hasPassword: true,
      onboardingCompleted: true,
      counts: {
        ownedWorkspaces: 4, sharedWorkspaces: 1, connectedAccounts: 2, models: 3, sessions: 7,
        ownBlueprints: 5, libraryBlueprints: 6,
      },
      access: "full",
      expiresAt: viewTerms.expiresAt,
    });
    expect(answers.describe.created).toBeInstanceOf(Date);

    let createdOf = (workspaceId: string) => storage.gadgets.get(workspaceId)!.created;
    expect(answers.listWorkspaces).toStrictEqual([
      {
        id: "ws-owned-1", title: "Owned 1", created: createdOf("ws-owned-1"),
        lastActive: LAST_ACTIVE, totalCost: 1.25,
      },
      {
        id: "ws-owned-2", title: "Owned 2", created: createdOf("ws-owned-2"),
        lastActive: LAST_ACTIVE, notificationMute: { until: MUTE_UNTIL },
      },
      {
        id: "ws-owned-3", title: "Owned 3", created: createdOf("ws-owned-3"),
        lastActive: LAST_ACTIVE,
      },
      // One whose creation has not finished.
      { id: "ws-owned-4", title: "Owned 4", created: createdOf("ws-owned-4") },
      {
        id: "ws-shared", title: "Shared notes", created: createdOf("ws-shared"),
        lastActive: storage.gadgets.get("ws-shared")!.lastActive, owner: OWNER, role: "build",
      },
    ]);
    for (let workspace of answers.listWorkspaces) expect(workspace.created).toBeInstanceOf(Date);

    expect(answers.listConnectedAccounts).toStrictEqual([
      {
        id: 0, vendorId: VENDOR, autoProvisioned: false,
        credentialExpiresAt: CREDENTIAL_EXPIRES, credentialsExpired: true,
        description: { displayName: seeded.tokenName, uniqueName: seeded.tokenName },
      },
      {
        id: 1, vendorId: "context", autoProvisioned: true, credentialsExpired: false,
        description: AUTO_DESCRIPTION,
      },
    ]);

    expect(answers.listModels).toStrictEqual({
      models: [
        {
          id: "model-a", name: "Custom A", provider: "openai", model: "example-model-a",
          customApiUrl: true,
        },
        {
          id: "model-b", name: "Plain B", provider: "anthropic", model: "example-model-b",
          customApiUrl: false,
        },
        {
          id: "model-c", name: "Plain C", provider: "ollama", model: "example-model-c",
          customApiUrl: false,
        },
      ],
      preferredModel: "model-b",
      quickModel: "model-c",
    });

    // Latest first: the browser session, which has no expiry, then the seeded ones.
    let browserSession = storage.sessions.get(await tokenIdOf(seeded.token))!;
    expect(answers.listSessions).toStrictEqual({
      total: 7,
      sessions: [
        { created: browserSession.created },
        { created: past(10), expiresAt: seeded.deviceExpiresAt },
        {
          created: past(11), expiresAt: seeded.stagedExpiresAt,
          pendingUntil: seeded.stagedPendingUntil,
        },
        { created: past(12) }, { created: past(13) }, { created: past(14) },
        { created: past(15) },
      ],
    });

    expect(answers.listBlueprints).toStrictEqual([
      {
        id: "bp-own-1", held: "published", title: "Featured kit", version: 3,
        lastUpdated: past(21), workspaceId: "ws-owned-1", featured: true,
      },
      {
        id: "bp-own-2", held: "published", title: "Plain kit", version: 1,
        lastUpdated: past(22), workspaceId: "ws-gone", featured: false,
      },
      {
        id: "bp-own-3", held: "imported", title: "Imported kit", version: 7,
        lastUpdated: past(23), featured: false,
      },
      {
        id: "bp-own-4", held: "published", title: "Kit 4", version: 2, lastUpdated: past(24),
        workspaceId: "ws-owned-2", featured: false,
      },
      {
        id: "bp-own-5", held: "published", title: "Kit 5", version: 2, lastUpdated: past(25),
        workspaceId: "ws-owned-2", featured: false,
      },
      { id: "bp-lib-1", held: "uploaded", title: "Library 1", version: 11, lastUpdated: past(31) },
      { id: "bp-lib-2", held: "uploaded", title: "Library 2", version: 12, lastUpdated: past(32) },
      { id: "bp-lib-3", held: "uploaded", title: "Library 3", version: 13, lastUpdated: past(33) },
      { id: "bp-lib-4", held: "added", title: "Library 4", version: 14, lastUpdated: past(34) },
      { id: "bp-lib-5", held: "added", title: "Library 5", version: 15, lastUpdated: past(35) },
      { id: "bp-lib-6", held: "added", title: "Library 6", version: 16, lastUpdated: past(36) },
    ]);

    // The lapsed flow and the lapsed handoff are not counted, and billing has no name.
    expect(answers.getDiagnostics).toStrictEqual({
      nextAlarm: new Date(seeded.alarmAt),
      pendingConnectFlows: 2,
      pendingDeviceHandoffs: 1,
      pushDevices: { phones: 1, browsers: 2 },
      queuedNotifications: 0,
      dailyModelCalls: { day: "2025-06-01", count: 17 },
      billing: {
        accountId: "billing-account-id-1", creditsRemaining: 12.5,
        creditsUpdatedAt: new Date(CREDITS_UPDATED_AT),
      },
    });
  }));

  it("says a user is an admin only while ADMINS names them", () => withAccount(async user => {
    await createAccount(user);
    expect((await (await open(user)).describe()).isAdmin).toBe(false);
    setEnv(user, { ADMINS: [ADMIN, user.id] });
    expect((await (await open(user)).describe()).isAdmin).toBe(true);
  }));

  it("describes an account with no password that has not finished onboarding",
      () => withAccount(async user => {
    await user.instance.authenticateFromCfAccess(user.id, true);
    let description = await (await open(user)).describe();
    expect(description.hasPassword).toBe(false);
    expect(description.onboardingCompleted).toBe(false);
  }));

  it("answers for an account nothing has signed in to", () => withAccount(async user => {
    // createAccount() does not tell the directory, so the account holds no sign-in it told.
    await createAccount(user);
    let view = await open(user);
    expect(defined(await view.describe())).not.toHaveProperty("lastLogin");
    expect(await view.listModels())
        .toStrictEqual({ models: [], preferredModel: null, quickModel: null });
  }));

  it("lists the latest sessions, with how many there are", () => withAccount(async user => {
    // The browser session createAccount() makes, and 204 older ones.
    await createAccount(user);
    for (let n = 1; n <= 204; n++) {
      user.storage.sessions.put({ tokenId: `token-id-${n}`, created: past(n) });
    }
    let { total, sessions } = await (await open(user)).listSessions();
    expect(total).toBe(205);
    expect(sessions).toHaveLength(ADMIN_LIST_MAX_LIMIT);
    let [latest, ...older] = sessions.map(session => session.created.getTime());
    expect(latest).toBeGreaterThan(past(0).getTime());
    expect(older).toStrictEqual(
        Array.from({ length: ADMIN_LIST_MAX_LIMIT - 1 }, (_, index) => past(index + 1).getTime()));
  }));

  it("leaves an unknown credit balance out", () => withAccount(async user => {
    await createAccount(user);
    user.storage.cloudflareBilling.put(
        { accountId: "billing-account-id-2", creditsRemaining: null });
    expect(defined(await (await open(user)).getDiagnostics()).billing)
        .toStrictEqual({ accountId: "billing-account-id-2" });
  }));

  // Two checks, since neither sees everything: a string search cannot see bytes, and a walk for
  // bytes and stubs cannot see a credential stored as a string.
  it("returns no credential at any level", () => withAccount(async user => {
    let seeded = await seed(user);
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    // The seed stores each of these, so the search below has something to find.
    expect(seeded.secrets).toHaveLength(40);
    expect(new Set(seeded.secrets).size).toBe(40);
    for (let secret of seeded.secrets) expect(secret.length).toBeGreaterThanOrEqual(8);
    // The walk sees a stored hash, which is bytes, and a record's stub.
    expect(forbidden({ hash: user.storage.passwordHashHash.get() }))
        .toStrictEqual(["$.hash is binary"]);
    expect(forbidden({ records: [{ account: {} }] }))
        .toStrictEqual(["$.records.0.account is a stub's property"]);

    for (let access of ["metadata", "full"] as const) {
      let answers = await answersOf(await open(user, { access }));
      for (let [method, answer] of Object.entries(answers)) {
        expect(forbidden(answer), `${method} at ${access}`).toStrictEqual([]);
        let text = JSON.stringify(answer);
        expect(seeded.secrets.filter(secret => text.includes(secret)), `${method} at ${access}`)
            .toStrictEqual([]);
      }
    }
  }));
});

describe("the access level", () => {
  it("records and refuses an open and a live view's call while the setting is off",
      () => withAccount(async user => {
    await createAccount(user);
    let view = await open(user);
    user.config.adminWorkspaceAccess = "off";
    expect(await codeOf(view.describe())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(await codeOf(open(user, { access: "full" }))).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    let records = await recordsOf(user.id);
    expect(records.map(r => [r.method, r.requested, r.access, r.exposed, r.refused]))
        .toStrictEqual([
          ["inspectUser", "metadata", "metadata", "metadata", undefined],
          ["describe", "metadata", "off", "metadata", ADMIN_ACCESS_ERROR_CODES.accessOff],
          ["inspectUser", "full", "off", "metadata", ADMIN_ACCESS_ERROR_CODES.accessOff],
        ]);
  }));

  it("runs at metadata under the default cap, whatever the setting",
      () => withAccount(async user => {
    await seed(user);
    user.config.adminWorkspaceAccess = "full";
    let view = await open(user, { access: "full" });
    expect((await view.describe()).access).toBe("metadata");
    for (let account of await view.listConnectedAccounts()) {
      expect(account).not.toHaveProperty("description");
    }
    for (let blueprint of await view.listBlueprints()) expect(blueprint).not.toHaveProperty("id");
    for (let record of await recordsOf(user.id)) {
      expect(record).toMatchObject({ requested: "full", access: "metadata", exposed: "metadata" });
    }
  }));

  it("never raises a view that asked for full and got metadata", () => withAccount(async user => {
    await seed(user);
    // The deployment allowed "metadata" when the view was opened, and allows "full" after.
    let view = await open(user, { requested: "full", access: "metadata" });
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    expect((await view.describe()).access).toBe("metadata");
    for (let account of await view.listConnectedAccounts()) {
      expect(account).not.toHaveProperty("description");
    }
    for (let blueprint of await view.listBlueprints()) expect(blueprint).not.toHaveProperty("id");
    let records = await recordsOf(user.id);
    expect(records).toHaveLength(4);
    for (let record of records) {
      expect(record).toMatchObject({ requested: "full", access: "metadata", exposed: "metadata" });
    }
  }));

  it("withholds from its next call once the setting drops to metadata",
      () => withAccount(async user => {
    await seed(user);
    setEnv(user, UNCAPPED);
    user.config.adminWorkspaceAccess = "full";
    let view = await open(user, { access: "full" });
    let accounts = await view.listConnectedAccounts();
    let blueprints = await view.listBlueprints();
    expect(accounts).toHaveLength(2);
    expect(blueprints).toHaveLength(11);
    for (let account of accounts) expect(account).toHaveProperty("description");
    for (let blueprint of blueprints) expect(blueprint).toHaveProperty("id");

    // The view's own level is still "full": only the level its calls are passed has dropped.
    user.config.adminWorkspaceAccess = "metadata";
    accounts = await view.listConnectedAccounts();
    blueprints = await view.listBlueprints();
    expect(accounts).toHaveLength(2);
    expect(blueprints).toHaveLength(11);
    for (let account of accounts) expect(account).not.toHaveProperty("description");
    for (let blueprint of blueprints) expect(blueprint).not.toHaveProperty("id");
    expect((await view.describe()).access).toBe("metadata");

    let records = await recordsOf(user.id);
    expect(records.map(r => [r.method, r.requested, r.access, r.exposed])).toStrictEqual([
      ["inspectUser", "full", "full", "metadata"],
      ["listConnectedAccounts", "full", "full", "content"],
      ["listBlueprints", "full", "full", "content"],
      ["listConnectedAccounts", "full", "metadata", "metadata"],
      ["listBlueprints", "full", "metadata", "metadata"],
      ["describe", "full", "metadata", "metadata"],
    ]);
  }));
});

// A host of the test's own, for what a real account cannot show: this pool's audit log is shared
// with other suites and cannot be made to fail safely, and no path of UserDurableObject deletes
// an account. `controls` changes what the host answers under a live view; `appended` holds the
// records its audit log took.
function fakeHost() {
  let appended: AdminUserAccessRecord[] = [];
  let controls = { created: true, admins: [ADMIN], appendError: undefined as Error | undefined };
  let host = {
    env: () => ({ ADMINS: controls.admins, BLUEPRINTS: { get: async () => null } }),
    storage: {
      profile: { get: () => ({ type: "user", id: "hosted@example.test", name: "Hosted" }) },
      created: { get: () => controls.created },
      aiModels: { list: () => [] },
      preferredModel: { get: () => null },
      quickModel: { get: () => null },
    },
    audits: {
      getByName: () => ({
        append: async (record: AdminUserAccessRecord) => {
          if (controls.appendError) throw controls.appendError;
          appended.push(record);
        },
      }),
    },
    connectedAccounts: () => [],
    nextAlarm: async () => null,
  } as unknown as AdminUserViewHost;
  let openOn = (overrides: Partial<AdminViewTerms> = {}) =>
      openAdminUserView(host, ADMIN, REASON, SESSION_ID, terms(overrides));
  return { controls, appended, openOn };
}

describe("a view over a host of the test's own", () => {
  const NO_MODELS = { models: [], preferredModel: null, quickModel: null };

  it("fails an open and a call whose record cannot be written", async () => {
    let { controls, appended, openOn } = fakeHost();
    let view = await openOn();
    controls.appendError = new Error("audit store down");
    await expect(openOn()).rejects.toThrow("audit store down");
    await expect(view.listModels()).rejects.toThrow("audit store down");
    expect(appended.map(record => record.method)).toStrictEqual(["inspectUser"]);
  });

  it("refuses a call, unrecorded, once the view has expired", async () => {
    let { appended, openOn } = fakeHost();
    let view = await openOn({ expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) });
    await scheduler.wait(SHORT_LIFETIME_MS + 100);
    expect(await codeOf(view.listModels())).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect(appended.map(record => record.method)).toStrictEqual(["inspectUser"]);
  });

  it("refuses a call, unrecorded, once ADMINS drops its admin", async () => {
    let { controls, appended, openOn } = fakeHost();
    let view = await openOn();
    expect(await view.listModels()).toStrictEqual(NO_MODELS);
    controls.admins = ["someone-else@example.test"];
    expect(await codeOf(view.listModels())).toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(appended.map(record => record.method)).toStrictEqual(["inspectUser", "listModels"]);
  });

  it("refuses a call, unrecorded, once the account is gone", async () => {
    let { controls, appended, openOn } = fakeHost();
    let view = await openOn();
    expect(await view.listModels()).toStrictEqual(NO_MODELS);
    controls.created = false;
    expect(await codeOf(view.listModels())).toBe(ADMIN_ACCESS_ERROR_CODES.userNotFound);
    expect(appended.map(record => record.method)).toStrictEqual(["inspectUser", "listModels"]);
  });
});

// What notification delivery does not own of an account, by name. A store answers for a singleton
// never stored.
function keptThroughDelivery({ storage }: Live) {
  return {
    sessions: [...storage.sessions.list()],
    workspaces: [...storage.gadgets.list()],
    connectedAccounts: Array.from(
        storage.connectedAccounts.list(), ({ account: _account, ...record }) => record),
    flows: [...storage.pendingConnectFlows.list()],
    profile: storage.profile.get(),
    directoryRev: storage.directoryRev.get(),
    directoryLoginAt: storage.directoryLoginAt.get(),
  };
}

// A dump less everything notification delivery stores: its queue, the chats' read cursors (and
// that collection's index rows), the badge and the push registrations.
function outsideDelivery(entries: [string, unknown][]): [string, unknown][] {
  return entries.filter(([key]) =>
      !["notificationOutbox:", "chatReadCursors:", "chatReadCursors."]
          .some(prefix => key.startsWith(prefix)) &&
      !["notificationBadge", "phoneNotificationSubscriptions",
        "browserNotificationSubscriptions"].includes(key));
}

describe("the account under inspection", () => {
  // The seed is pinned so that each check can fail: the account is listed in the directory, both
  // kinds of directory sync are due (a session sync would report a login, and any sync would send
  // a new name), two gatekeeper accounts are stored, and an alarm is set. An account with a
  // notification queued is the next case's.
  it("is not changed, and neither a gatekeeper nor the directory is reached", async () => {
    let account = newAccount();
    // What a subscriber to the account's workspaces, sessions and connected accounts is told.
    let told: string[] = [];
    let subscribe = (user: Live) => {
      for (let name of ["gadgets", "sessions", "connectedAccounts"] as const) {
        (user.storage[name] as { subscribe(subscriber: object): void }).subscribe({
          add: () => told.push(`${name}.add`),
          update: () => told.push(`${name}.update`),
          remove: () => told.push(`${name}.remove`),
        });
      }
    };
    let seeded!: Seeded;
    // What an inspection could change besides the storage's write count: everything the account
    // stores, its alarm, its directory listing and what its gatekeeper accounts were asked.
    let snapshot = async (user: Live) => ({
      storage: dump(user.state),
      alarm: await user.state.storage.getAlarm(),
      listed: await listed(user.id),
      directoryRev: user.storage.directoryRev.get(),
      directoryLoginAt: user.storage.directoryLoginAt.get(),
      gatekeeperCalls: [
        await fakeCalls(user, seeded.tokenName), await fakeCalls(user, seeded.autoName),
      ],
    });

    let before = await inAccount(account, async user => {
      let { storage, state } = user;
      seeded = await seed(user);
      // Nothing that seeds runs from here on: a sign-in or a rename would sync the directory.
      let lastLogin = (await listed(user.id))!.lastLogin!.getTime();
      storage.directoryLoginAt.put(lastLogin - 2 * DIRECTORY_ACTIVITY_INTERVAL_MS);
      storage.profile.put({ ...storage.profile.get(), name: "Renamed, unsynced" });
      storage.profileRev.put(storage.profileRev.get() + 1);
      expect(storage.directoryRev.get()).toBeLessThan(storage.profileRev.get());
      expect(Date.now() - storage.directoryLoginAt.get())
          .toBeGreaterThan(DIRECTORY_ACTIVITY_INTERVAL_MS);
      expect([...storage.notificationOutbox.list()]).toStrictEqual([]);

      subscribe(user);
      let taken = await snapshot(user);
      expect(taken.alarm).toBe(seeded.alarmAt);
      expect(taken.listed).toMatchObject({ name: "Viewed User" });
      expect(taken.gatekeeperCalls).toStrictEqual([["describe"], []]);
      let writes = changes(state);
      let unchangedAfter = async (step: string) => {
        expect({
          step, writes: changes(state), storage: dump(state), alarm: await state.storage.getAlarm(),
        }).toStrictEqual({ step, writes, storage: taken.storage, alarm: taken.alarm });
      };

      // The open and every method, at "metadata" and then at "full".
      setEnv(user, UNCAPPED);
      user.config.adminWorkspaceAccess = "full";
      for (let access of ["metadata", "full"] as const) {
        let view = await open(user, { access });
        await unchangedAfter(`an open at ${access}`);
        for (let method of READS) {
          await view[method]();
          await unchangedAfter(`${method}() at ${access}`);
        }
      }

      // A live view's call and an open that the setting "off" refuses, each recorded.
      let live = await open(user);
      user.config.adminWorkspaceAccess = "off";
      expect(await codeOf(live.describe())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
      await unchangedAfter("a call refused at off");
      expect(await codeOf(open(user))).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
      await unchangedAfter("an open refused at off");
      user.config.adminWorkspaceAccess = "full";

      // Opens refused unrecorded.
      expect(await codeOf(open(user, {}, "someone@example.test")))
          .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
      await unchangedAfter("an open by a non-admin");
      expect(await codeOf(open(user, { expiresAt: new Date(Date.now() - 1) })))
          .toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
      await unchangedAfter("an open with an expiry already past");
      await expect(open(user, {}, ADMIN, "  ")).rejects.toThrow(TypeError);
      await unchangedAfter("an open with a blank reason");

      await settled(user.id);
      expect(await snapshot(user)).toStrictEqual(taken);
      expect(told).toStrictEqual([]);
      return taken;
    });

    // The wake with nothing queued, which is what an admin's open of a sleeping account does. The
    // next callback's instance is the object as its constructor made it from the stored state.
    await evictDurableObject(account.stub);
    await inAccount(account, async user => {
      let { instance, storage, state } = user;
      subscribe(user);
      let answers = await answersOf(await open(user, { access: "full" }));
      expect(answers.describe.access).toBe("full");
      await settled(user.id);
      // The count starts again with the object, so 0 says nothing has been written since the
      // account woke: not by its constructor, and not by the inspection.
      expect(changes(state)).toBe(0);
      expect(await snapshot(user)).toStrictEqual(before);
      expect(told).toStrictEqual([]);

      // Control, with the same settle and no polling: a sign-in on this object does sync the
      // directory, and each kind of write does reach its subscriber.
      await instance.authenticate(seeded.token);
      await settled(user.id);
      expect(storage.directoryRev.get()).toBe(storage.profileRev.get());
      expect(storage.directoryRev.get()).toBeGreaterThan(before.directoryRev);
      expect(storage.directoryLoginAt.get()).toBeGreaterThan(before.directoryLoginAt);
      let relisted = (await listed(user.id))!;
      expect(relisted.name).toBe("Renamed, unsynced");
      expect(relisted.lastLogin!.getTime()).toBeGreaterThan(before.listed!.lastLogin!.getTime());
      expect(changes(state)).toBeGreaterThan(0);
      await instance.newWorkspace("ws-control", "Control");
      await instance.login(PASSWORD_HASH);
      await instance.markCredentialsExpired(1);
      expect(told).toStrictEqual(["gadgets.add", "sessions.add", "connectedAccounts.update"]);
    }, UNCAPPED);
  });

  // The one exception, which is the wake's and not the view's: the constructor's recovery, which
  // any wake runs whether or not a view is opened, delivers the notifications already queued and
  // re-arms a missing alarm. The case above seeds no notification, so that a wake leaves its
  // account byte for byte as it was.
  it("leaves a queued notification and a missing alarm to the wake's own recovery", async () => {
    const WORKSPACE = "ws-notified";
    const CHAT_TITLE = "Build the demo";
    let account = newAccount();
    let fakeName = `queued-${account.id}`;

    let before = await inAccount(account, async user => {
      let { instance, storage, state } = user;
      await createAccount(user);
      // Delivery admits only a workspace the account lists.
      await instance.newWorkspace(WORKSPACE, "Notified");
      await instance.linkConnectedAccountFromLogin(fakeAccount(user, fakeName), VENDOR);
      storage.chatReadCursors.put({
        workspaceId: WORKSPACE, chatId: 1, readThroughSequence: -1, readThroughVisibleSequence: 0,
        latestVisibleSequence: 1, unreadCount: 1, notifiedThroughSequence: 0,
        head: { chatTitle: CHAT_TITLE, latestSequence: 1 },
      });
      storage.notificationOutbox.put({
        id: "11111111-1111-4111-8111-111111111111", kind: "taskCompleted",
        workspaceId: WORKSPACE, chatId: 1, chatTitle: CHAT_TITLE, sequence: 1,
        expiresAt: new Date(Date.now() + 600_000),
      });
      // A pending expiry with no alarm set: the missing alarm the recovery re-arms.
      let flowAt = Date.now() + 3_600_000;
      storage.pendingConnectFlows.put(
          { nonceHash: "nonce-hash-queued", accountId: 0, expiresAt: new Date(flowAt) });

      // On the object as it runs, the view neither delivers nor arms.
      let writes = changes(state);
      let stored = dump(state);
      let answers = await answersOf(await open(user));
      // Whole: nothing is stored for nextAlarm, dailyModelCalls or billing.
      expect(answers.getDiagnostics).toStrictEqual({
        pendingConnectFlows: 1, pendingDeviceHandoffs: 0, pushDevices: { phones: 0, browsers: 0 },
        queuedNotifications: 1,
      });
      expect(changes(state)).toBe(writes);
      expect(dump(state)).toStrictEqual(stored);
      expect(await state.storage.getAlarm()).toBeNull();
      return { stored, flowAt, kept: keptThroughDelivery(user) };
    });

    // Entering the object again wakes it, and no view is opened there.
    await evictDurableObject(account.stub);
    await inAccount(account, async user => {
      let { storage, state } = user;
      // Both are end states: no device is registered and no client is connected, so the delivery
      // counts as done, and the alarm, first armed for the queue, settles on the flow's expiry.
      await vi.waitFor(async () => {
        expect([...storage.notificationOutbox.list()]).toStrictEqual([]);
        expect(await state.storage.getAlarm()).toBe(before.flowAt);
      }, { timeout: 10_000, interval: 20 });

      expect(outsideDelivery(dump(state))).toStrictEqual(outsideDelivery(before.stored));
      expect(keptThroughDelivery(user)).toStrictEqual(before.kept);
      // The recovery calls no gatekeeper: the account was asked only what linking it asked.
      expect(await fakeCalls(user, fakeName)).toStrictEqual(["describe"]);
    });
  });
});
