// The account-wide grant a user gives deployment admins to read the content of every workspace
// they own (AuthenticatedApi.getAccountAdminGrant(), grantAccountAdminAccess() and
// revokeAccountAdminAccess(), and UserDurableObject.liveAccountAdminGrant(), which a workspace
// asks): what each stores and returns, when the grant is live, how long an ended one is kept, and
// that nothing is written to the admin audit log.
//
// Runs against a real UserDurableObject (the TEST_USER binding) whose env is replaced per test.
// The deployment-wide log is the real AdminAuditDurableObject, read through the TEST_ADMIN_AUDIT
// binding.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_LIFETIME_SECONDS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  getAdminAccessErrorCode,
  type AdminAccessGrant, type AdminWorkspaceAccess, type AiChatAuthorInfo, type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { namedUser } from "../src/admin-access.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import server from "../src/server.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.test", name: "Alice" };
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIFETIME_MS = ADMIN_GRANT_LIFETIME_SECONDS * 1000;
// The key the account stores its grant under.
const GRANT_KEY = "accountAdminGrant";
const ORIGIN = "https://workshop.example";

type Account = {
  user: UserDurableObject;
  state: DurableObjectState;
  // The deployment's stored settings, as the fake KV serves them.
  config: { adminWorkspaceAccess: AdminWorkspaceAccess; adminAuditRetentionDays: number };
  // How many times the account read the deployment's settings.
  configReads: number;
};

// Sets the account's env to the pool's env with a cap of "content", a fake BLUEPRINTS serving
// `account.config`, and `vars`.
function setEnv(account: Account, vars: Record<string, unknown> = {}): void {
  account.user["env"] = {
    ...env,
    ADMIN_WORKSPACE_ACCESS_MAX: "content",
    BLUEPRINTS: {
      get: async (key: string) => {
        account.configReads++;
        return key === ADMIN_CONFIG_KEY ? JSON.stringify(account.config) : null;
      },
    },
    ...vars,
  } as unknown as Cloudflare.Env;
}

// The user object behind `stub` as an account on a deployment that lets content be granted: the
// level in force is "content".
function accountOf(user: UserDurableObject, state: DurableObjectState): Account {
  let account: Account = {
    user, state, configReads: 0,
    config: { adminWorkspaceAccess: "content", adminAuditRetentionDays: RETENTION },
  };
  setEnv(account);
  return account;
}

// Runs `fn` on a fresh account whose profile is `profile`.
async function withAccount(fn: (account: Account) => Promise<void>,
                           profile: AiChatAuthorInfo = ALICE): Promise<void> {
  let stub = env.TEST_USER.getByName(`admin-account-grant-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (user: UserDurableObject, state) => {
    user["storage"].created.put(true);
    user["storage"].profile.put(profile);
    await fn(accountOf(user, state));
  });
}

// A grant given an hour ago and live for another, with `overrides`.
function grantOf(overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  return {
    id: crypto.randomUUID(), level: "content", source: "owner", scope: "account",
    grantedBy: namedUser(ALICE),
    grantedAt: new Date(Date.now() - HOUR_MS), expiresAt: new Date(Date.now() + HOUR_MS),
    ...overrides,
  };
}

// Puts `grant` into the account's storage directly, and returns it.
function put(account: Account, grant: AdminAccessGrant): AdminAccessGrant {
  account.user["storage"].accountAdminGrant.put(grant);
  return grant;
}

// The grant exactly as the account keeps it: the raw value under its key, undefined when the
// account never stored one.
function raw(account: Account): unknown {
  return account.state.storage.kv.get(GRANT_KEY);
}

// Everything the account stores, keys and values.
function stored(account: Account): [string, unknown][] {
  return [...account.state.storage.kv.list()];
}

// The deployment-wide audit log, newest first.
async function auditRecords(): Promise<unknown[]> {
  return (await env.TEST_ADMIN_AUDIT.getByName("").list({ limit: 200 }, RETENTION)).records;
}

// What a call is refused with: its code and its message.
async function refusalOf(promise: PromiseLike<unknown>)
    : Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return {
      code: getAdminAccessErrorCode(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
  throw new Error("Expected a refusal.");
}

// A PublicApi session on a deployment with no admins. No admin config is stored for the
// session Worker: every read of it gets the defaults (signups open).
async function connect(): Promise<RpcStub<PublicApi>> {
  // The first /api request installs the bundled blueprints, which needs storage this test
  // lacks.
  let ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: Object.create(ctx.exports, {
    AdminSettings: { value: { getByName: () => ({
      ensureBundledBlueprintsInstalled: async () => true,
    }) } },
  }) });
  let deployment = { ...env, ADMINS: [], BLUEPRINTS: { get: async () => null } };
  let response = await server.fetch(
      new Request(`${ORIGIN}/api`, { headers: { Upgrade: "websocket", Origin: ORIGIN } }),
      deployment as unknown as Cloudflare.Env, ctx);
  expect(response.status).toBe(101);
  let socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

const CONTENT_OFF = {
  code: ADMIN_ACCESS_ERROR_CODES.contentOff,
  message: "Admin access to workspace content is turned off on this deployment.",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an account that never gave a grant", () => {
  it("answers null and stores nothing", () => withAccount(async account => {
    let before = stored(account);
    expect(await account.user.getAccountAdminGrant()).toBeNull();
    expect(await account.user.liveAccountAdminGrant()).toBeNull();
    await account.user.revokeAccountAdminAccess();

    expect(raw(account)).toBeUndefined();
    expect(stored(account)).toStrictEqual(before);
  }));
});

describe("giving the account-wide grant", () => {
  it("stores one grant for 72 hours and returns it", () => withAccount(async account => {
    let before = Date.now();
    let grant = await account.user.grantAccountAdminAccess();
    let after = Date.now();

    expect(grant).toStrictEqual({
      id: expect.any(String), level: "content", source: "owner", scope: "account",
      grantedBy: { id: ALICE.id, name: ALICE.name },
      grantedAt: expect.any(Date), expiresAt: expect.any(Date),
    });
    expect(grant.grantedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(grant.grantedAt.getTime()).toBeLessThanOrEqual(after);
    expect(grant.expiresAt.getTime() - grant.grantedAt.getTime()).toBe(LIFETIME_MS);

    expect(raw(account)).toStrictEqual(grant);
    expect(await account.user.getAccountAdminGrant()).toStrictEqual(grant);
    expect(await account.user.liveAccountAdminGrant()).toStrictEqual(grant);
  }));

  it("renews a live grant under its id", () => withAccount(async account => {
    let live = put(account, grantOf());
    let before = Date.now();
    let renewed = await account.user.grantAccountAdminAccess();

    expect(renewed).toStrictEqual({ ...live, expiresAt: expect.any(Date) });
    expect(renewed.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LIFETIME_MS);
    expect(renewed.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + LIFETIME_MS);
    expect(raw(account)).toStrictEqual(renewed);
  }));

  it("renews sixty times in a row, refusing none", () => withAccount(async account => {
    let now = Date.now();
    let clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let first = await account.user.grantAccountAdminAccess();
    for (let i = 1; i <= 60; i++) {
      clock.mockReturnValue(now + i * 60_000);
      expect(await account.user.grantAccountAdminAccess()).toStrictEqual({
        ...first, expiresAt: new Date(now + i * 60_000 + LIFETIME_MS),
      });
    }
    expect(raw(account)).toMatchObject({ id: first.id, grantedAt: first.grantedAt });
  }));

  it("gives a grant with another id once the last one ended", () => withAccount(async account => {
    let ended = [
      grantOf({ revokedAt: new Date(), revokedBy: namedUser(ALICE) }),
      grantOf({ expiresAt: new Date(Date.now() - 1) }),
      grantOf({ expiresAt: new Date(NaN) }),
    ];
    for (let last of ended) {
      put(account, last);
      let grant = await account.user.grantAccountAdminAccess();

      expect(grant.id).not.toBe(last.id);
      expect(grant).not.toHaveProperty("revokedAt");
      expect(grant).not.toHaveProperty("revokedBy");
      expect(grant.expiresAt.getTime() - grant.grantedAt.getTime()).toBe(LIFETIME_MS);
      // The ended one is replaced: the account keeps one record.
      expect(raw(account)).toStrictEqual(grant);
    }
  }));

  it("keeps an id and a bounded name of the user, and nothing else of their profile",
      () => withAccount(async account => {
    let user = { id: ALICE.id, name: `${"n".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…` };
    let grant = await account.user.grantAccountAdminAccess();
    expect(grant.grantedBy).toStrictEqual(user);

    await account.user.revokeAccountAdminAccess();
    let revoked = await account.user.getAccountAdminGrant();
    expect(revoked!.grantedBy).toStrictEqual(user);
    expect(revoked!.revokedBy).toStrictEqual(user);
    expect(raw(account)).toStrictEqual(revoked);
    expect(JSON.stringify(raw(account)).length).toBeLessThan(2048);
  }, {
    ...ALICE, name: "n".repeat(1_000_000), commitEmail: "alice@example.test",
    description: "About Alice",
  }));
});

describe("while the level in force is below content", () => {
  // The admins' choice, then the operator's cap (unset, it is "metadata").
  const BELOW: ((account: Account) => void)[] = [
    account => { account.config.adminWorkspaceAccess = "metadata"; },
    account => { account.config.adminWorkspaceAccess = "off"; },
    account => setEnv(account, { ADMIN_WORKSPACE_ACCESS_MAX: undefined }),
    account => setEnv(account, { ADMIN_WORKSPACE_ACCESS_MAX: "full" }),
  ];

  it("refuses a grant and stores nothing", async () => {
    for (let lower of BELOW) {
      await withAccount(async account => {
        lower(account);
        let before = stored(account);
        expect(await refusalOf(account.user.grantAccountAdminAccess()))
            .toStrictEqual(CONTENT_OFF);
        expect(raw(account)).toBeUndefined();
        expect(stored(account)).toStrictEqual(before);
      });
    }
  });

  it("neither renews a live grant nor replaces an ended one", async () => {
    for (let lower of BELOW) {
      for (let kept of [grantOf(), grantOf({ expiresAt: new Date(Date.now() - 1) })]) {
        await withAccount(async account => {
          put(account, kept);
          lower(account);
          expect(await refusalOf(account.user.grantAccountAdminAccess()))
              .toStrictEqual(CONTENT_OFF);
          expect(raw(account)).toStrictEqual(kept);
        });
      }
    }
  });

  it("still reads and ends a grant given earlier", async () => {
    for (let lower of BELOW) {
      await withAccount(async account => {
        let grant = await account.user.grantAccountAdminAccess();
        lower(account);

        expect(await account.user.getAccountAdminGrant()).toStrictEqual(grant);
        await account.user.revokeAccountAdminAccess();
        expect(await account.user.getAccountAdminGrant()).toStrictEqual({
          ...grant, revokedAt: expect.any(Date), revokedBy: namedUser(ALICE),
        });
        expect(await account.user.liveAccountAdminGrant()).toBeNull();
      });
    }
  });
});

describe("ending the account-wide grant", () => {
  it("sets when and by whom, once", () => withAccount(async account => {
    let grant = await account.user.grantAccountAdminAccess();
    let before = Date.now();
    await account.user.revokeAccountAdminAccess();

    let revoked = raw(account) as AdminAccessGrant;
    expect(revoked).toStrictEqual({
      ...grant, revokedAt: expect.any(Date), revokedBy: { id: ALICE.id, name: ALICE.name },
    });
    expect(revoked.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(revoked.revokedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await account.user.getAccountAdminGrant()).toStrictEqual(revoked);
    expect(await account.user.liveAccountAdminGrant()).toBeNull();

    // Ending it again changes nothing, whoever the profile now names.
    account.user["storage"].profile.put({ ...ALICE, name: "Alice Renamed" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOUR_MS);
    await account.user.revokeAccountAdminAccess();
    expect(raw(account)).toStrictEqual(revoked);
  }));

  it("leaves a grant that expired as it is", () => withAccount(async account => {
    let expired = put(account, grantOf({ expiresAt: new Date(Date.now() - 1) }));
    await account.user.revokeAccountAdminAccess();
    expect(raw(account)).toStrictEqual(expired);
  }));

  it("reads no deployment settings", () => withAccount(async account => {
    await account.user.grantAccountAdminAccess();
    let reads = account.configReads;
    await account.user.revokeAccountAdminAccess();
    expect(account.configReads).toBe(reads);
  }));
});

describe("what a workspace is answered", () => {
  it("is the grant until its end exactly", () => withAccount(async account => {
    let grant = put(account, grantOf());
    let end = grant.expiresAt.getTime();
    let clock = vi.spyOn(Date, "now");

    clock.mockReturnValue(end - 1);
    expect(await account.user.liveAccountAdminGrant()).toStrictEqual(grant);
    clock.mockReturnValue(end);
    expect(await account.user.liveAccountAdminGrant()).toBeNull();
    clock.mockReturnValue(end + 1);
    expect(await account.user.liveAccountAdminGrant()).toBeNull();
  }));

  it("is null for a grant that is revoked, has no valid end or is not for content",
      () => withAccount(async account => {
    let notLive: AdminAccessGrant[] = [
      grantOf({ revokedAt: new Date(), revokedBy: namedUser(ALICE) }),
      // Revoked at a time yet to come: it is ended all the same.
      grantOf({ revokedAt: new Date(Date.now() + HOUR_MS), revokedBy: namedUser(ALICE) }),
      grantOf({ expiresAt: new Date(NaN) }),
      grantOf({ expiresAt: "2999-01-01T00:00:00.000Z" as unknown as Date }),
      grantOf({ expiresAt: undefined as unknown as Date }),
      grantOf({ level: "everything" as AdminAccessGrant["level"] }),
    ];
    for (let grant of notLive) {
      put(account, grant);
      expect(await account.user.liveAccountAdminGrant()).toBeNull();
    }
  }));

  it("reads one stored value, no deployment settings, and writes nothing",
      () => withAccount(async account => {
    let read = vi.spyOn(account.state.storage.kv, "get");
    let longEnded = grantOf({ expiresAt: new Date(Date.now() - 2 * RETENTION * DAY_MS) });
    for (let grant of [grantOf(), longEnded]) {
      put(account, grant);
      let before = stored(account);
      read.mockClear();
      await account.user.liveAccountAdminGrant();

      expect(read.mock.calls).toStrictEqual([[GRANT_KEY]]);
      expect(account.configReads).toBe(0);
      // Not even an ended grant past its retention is deleted by the workspace's question.
      expect(stored(account)).toStrictEqual(before);
    }
  }));
});

describe("an ended grant", () => {
  it("is kept for the audit retention, then deleted when the account next reads it",
      () => withAccount(async account => {
    let past = new Date(Date.now() - RETENTION * DAY_MS - HOUR_MS);
    let within = new Date(Date.now() - RETENTION * DAY_MS + HOUR_MS);

    for (let kept of [
      grantOf({ expiresAt: within }),
      grantOf({ revokedAt: within, revokedBy: namedUser(ALICE) }),
      // Long expired, but ended by its revocation, which is recent.
      grantOf({ expiresAt: past, revokedAt: within, revokedBy: namedUser(ALICE) }),
    ]) {
      put(account, kept);
      expect(await account.user.getAccountAdminGrant()).toStrictEqual(kept);
      expect(raw(account)).toStrictEqual(kept);
    }

    for (let gone of [
      grantOf({ expiresAt: past }),
      grantOf({ revokedAt: past, revokedBy: namedUser(ALICE) }),
      grantOf({ expiresAt: new Date(NaN) }),
    ]) {
      put(account, gone);
      expect(await account.user.getAccountAdminGrant()).toBeNull();
      expect(raw(account)).toBeNull();
    }
  }));

  it("is kept for the retention the environment's floor gives",
      () => withAccount(async account => {
    // The admins chose a day; the floor holds it at 90.
    account.config.adminAuditRetentionDays = 1;
    let ended = put(account, grantOf({ expiresAt: new Date(Date.now() - 30 * DAY_MS) }));
    expect(await account.user.getAccountAdminGrant()).toStrictEqual(ended);

    setEnv(account, { ADMIN_AUDIT_RETENTION_MIN_DAYS: "7" });
    expect(await account.user.getAccountAdminGrant()).toBeNull();
    expect(raw(account)).toBeNull();
  }));
});

describe("the admin audit log", () => {
  it("gains no record from any of the account's grant methods",
      () => withAccount(async account => {
    let audit = await auditRecords();

    expect(await account.user.getAccountAdminGrant()).toBeNull();
    let grant = await account.user.grantAccountAdminAccess();
    expect((await account.user.grantAccountAdminAccess()).id).toBe(grant.id);
    expect(await account.user.liveAccountAdminGrant()).toMatchObject({ id: grant.id });
    await account.user.revokeAccountAdminAccess();
    await account.user.revokeAccountAdminAccess();
    expect(await account.user.getAccountAdminGrant()).toMatchObject({ id: grant.id });
    expect(await account.user.liveAccountAdminGrant()).toBeNull();
    expect((await account.user.grantAccountAdminAccess()).id).not.toBe(grant.id);
    account.config.adminWorkspaceAccess = "metadata";
    expect(await refusalOf(account.user.grantAccountAdminAccess())).toStrictEqual(CONTENT_OFF);
    // An expired grant past its retention, deleted by the read.
    put(account, grantOf({ expiresAt: new Date(Date.now() - 2 * RETENTION * DAY_MS) }));
    expect(await account.user.getAccountAdminGrant()).toBeNull();

    expect(await auditRecords()).toStrictEqual(audit);
  }));
});

describe("a user's own session", () => {
  it("gives, reads and ends the account's grant, with no admin status", async () => {
    let username = `grantee${crypto.randomUUID().replaceAll("-", "")}`;
    let stub = env.TEST_USER.getByName(username);
    let secret = await stub.createAccount(username, "Grace", new Uint8Array([1, 2, 3]));
    // The account's object keeps this env for the calls the session makes below.
    let account = await runInDurableObject(stub,
        async (user: UserDurableObject, state) => accountOf(user, state));

    using api = await connect();
    using session = api.authenticate(`${username}:${secret}`);
    expect(await session.amIAdmin()).toBe(false);
    expect(await session.getAccountAdminGrant()).toBeNull();

    let grant = await session.grantAccountAdminAccess();
    expect(grant).toStrictEqual({
      id: expect.any(String), level: "content", source: "owner", scope: "account",
      grantedBy: { id: username, name: "Grace" },
      grantedAt: expect.any(Date), expiresAt: expect.any(Date),
    });
    expect(await session.getAccountAdminGrant()).toStrictEqual(grant);
    let renewed = await session.grantAccountAdminAccess();
    expect(renewed).toStrictEqual({ ...grant, expiresAt: expect.any(Date) });

    account.config.adminWorkspaceAccess = "metadata";
    expect(await refusalOf(session.grantAccountAdminAccess())).toStrictEqual(CONTENT_OFF);

    expect(await session.revokeAccountAdminAccess()).toBeUndefined();
    expect(await session.getAccountAdminGrant()).toStrictEqual({
      ...renewed, revokedAt: expect.any(Date), revokedBy: { id: username, name: "Grace" },
    });
    expect(await stub.liveAccountAdminGrant()).toBeNull();
  });
});
