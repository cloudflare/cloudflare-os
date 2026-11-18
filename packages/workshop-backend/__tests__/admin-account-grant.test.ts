// The account-wide grant a user gives deployment admins to read the content of every workspace
// they own (AuthenticatedApi.getAccountAdminGrant(), grantAccountAdminAccess() and
// revokeAccountAdminAccess(), and UserDurableObject.liveAccountAdminGrant(), which a workspace
// asks): what each stores and returns, when the grant is live, how long an ended one is kept,
// that nothing is written to the admin audit log, and how a grant given with an issue report
// reaches the reports that show it.
//
// Runs against a real UserDurableObject (the TEST_USER binding) whose env is replaced per test.
// The deployment-wide log is the real AdminAuditDurableObject, read through the TEST_ADMIN_AUDIT
// binding.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_LIFETIME_SECONDS, ISSUE_REPORT_ERROR_CODES,
  MAX_ADMIN_AUDIT_ARG_LENGTH, getAdminAccessErrorCode, getIssueReportErrorCode,
  type AdminAccessGrant, type AdminWorkspaceAccess, type AiChatAuthorInfo, type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { IssueReportsDurableObject } from "../src/issue-reports.js";
import { namedUser } from "../src/admin-access.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import server from "../src/server.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
    TEST_ISSUE_REPORTS: DurableObjectNamespace<IssueReportsDurableObject>;
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
  vi.useRealTimers();
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

// A fresh issue report store of the real class, which the account reaches in place of the
// deployment's. `calls` names each call the account makes to it; `fail.noteGrant` is how many of
// the next noteGrant() calls reject without reaching it, the first of them once `fail.after`
// settles, and `fail.noteGrantAnswer` how many reach it and then reject, as a call whose answer
// was lost does.
function reportStore(account: Account) {
  let stub = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
  let calls: string[] = [];
  let fail: { noteGrant: number; noteGrantAnswer: number; after?: Promise<void> } =
      { noteGrant: 0, noteGrantAnswer: 0 };
  account.user["issueReports"] = { getByName: () => ({
    checkGrantLink: (...args: Parameters<IssueReportsDurableObject["checkGrantLink"]>) => {
      calls.push("checkGrantLink");
      return stub.checkGrantLink(...args);
    },
    noteGrant: async (...args: Parameters<IssueReportsDurableObject["noteGrant"]>) => {
      calls.push("noteGrant");
      if (fail.noteGrant-- > 0) {
        let { after } = fail;
        delete fail.after;
        await after;
        throw new Error("The issue report store is unreachable.");
      }
      await stub.noteGrant(...args);
      if (fail.noteGrantAnswer-- > 0) throw new Error("The issue report store's answer was lost.");
    },
  }) } as unknown as DurableObjectNamespace<IssueReportsDurableObject>;
  return {
    calls, fail,
    // Files ALICE's report: about no workspace, or about `workspaceId`, which she owns or not.
    file: async (workspaceId?: string, ownsWorkspace = false) =>
        (await stub.submit(ALICE, {
          text: "The chart is blank.", priority: "high",
          ...workspaceId !== undefined && { context: { workspaceId } },
        }, ownsWorkspace)).id,
    // The grant a report shows, as admins and as its reporter read it.
    shown: async (reportId: string) => {
      let grant = (await stub.get(reportId)).grant;
      expect((await stub.getOwn(ALICE.id, reportId)).grant).toStrictEqual(grant);
      return grant;
    },
  };
}

// The code of the issue report refusal a call rejects with.
async function reportRefusalOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return getIssueReportErrorCode(err);
  }
  throw new Error("Expected a refusal.");
}

// Gives a grant with `reportId` and ends it with the end lost on its way to the store, so the
// report still shows the grant with time left. Returns the ended grant as the account keeps it.
async function endMissedBy(account: Account, store: ReturnType<typeof reportStore>,
    reportId: string): Promise<AdminAccessGrant> {
  let grant = await account.user.grantAccountAdminAccess(reportId);
  store.fail.noteGrant = 1;
  await account.user.revokeAccountAdminAccess();
  let ended = raw(account) as AdminAccessGrant;
  expect(ended).toStrictEqual(
      { ...grant, revokedAt: expect.any(Date), revokedBy: namedUser(ALICE) });
  expect(await store.shown(reportId))
      .toStrictEqual({ id: grant.id, scope: "account", expiresAt: grant.expiresAt });
  return ended;
}

describe("the account-wide grant given with an issue report", () => {
  it("is shown by every report it was given with, through its renewal and its end",
      () => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();
    let owned = await store.file("workspace-1", true);
    let audit = await auditRecords();

    let grant = await account.user.grantAccountAdminAccess(home);
    expect(grant).toMatchObject({ source: "owner", scope: "account", reportId: home });
    expect(raw(account)).toStrictEqual(grant);
    let shown = { id: grant.id, scope: "account", expiresAt: grant.expiresAt };
    expect(await store.shown(home)).toStrictEqual(shown);
    expect(await store.shown(owned)).toBeUndefined();

    // Given again with the report that already shows it: the same grant, renewed.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + HOUR_MS });
    let same = await account.user.grantAccountAdminAccess(home);
    expect(same).toStrictEqual({ ...grant, expiresAt: new Date(Date.now() + LIFETIME_MS) });
    expect(same.expiresAt.getTime()).toBeGreaterThan(grant.expiresAt.getTime());
    shown = { ...shown, expiresAt: same.expiresAt };
    expect(await store.shown(home)).toStrictEqual(shown);
    expect(await store.shown(owned)).toBeUndefined();

    // Given again with a second report: the same grant, renewed, on both.
    vi.setSystemTime(Date.now() + HOUR_MS);
    let renewed = await account.user.grantAccountAdminAccess(owned);
    expect(renewed).toStrictEqual(
        { ...grant, reportId: owned, expiresAt: new Date(Date.now() + LIFETIME_MS) });
    shown = { ...shown, expiresAt: renewed.expiresAt };
    expect(await store.shown(home)).toStrictEqual(shown);
    expect(await store.shown(owned)).toStrictEqual(shown);

    // A renewal that names no report reaches them too.
    vi.setSystemTime(Date.now() + HOUR_MS);
    let again = await account.user.grantAccountAdminAccess();
    expect(again.reportId).toBe(owned);
    expect(await store.shown(home)).toStrictEqual({ ...shown, expiresAt: again.expiresAt });

    await account.user.revokeAccountAdminAccess();
    let ended = { ...shown, expiresAt: again.expiresAt, endedAt: new Date() };
    expect(await store.shown(home)).toStrictEqual(ended);
    expect(await store.shown(owned)).toStrictEqual(ended);
    expect(await auditRecords()).toStrictEqual(audit);
  }));

  it("refuses a report naming a workspace its reporter does not own, and gives no grant",
      () => withAccount(async account => {
    let store = reportStore(account);
    let shared = await store.file("workspace-of-bob", false);

    expect(await reportRefusalOf(account.user.grantAccountAdminAccess(shared)))
        .toBe(ISSUE_REPORT_ERROR_CODES.notFound);
    expect(await reportRefusalOf(account.user.grantAccountAdminAccess("no-such-report")))
        .toBe(ISSUE_REPORT_ERROR_CODES.notFound);
    expect(raw(account)).toBeUndefined();
    expect(store.calls).toStrictEqual(["checkGrantLink", "checkGrantLink"]);

    // A grant that is live is left as it was, not renewed.
    let live = put(account, grantOf());
    expect(await reportRefusalOf(account.user.grantAccountAdminAccess(shared)))
        .toBe(ISSUE_REPORT_ERROR_CODES.notFound);
    expect(raw(account)).toStrictEqual(live);
    expect(await store.shown(shared)).toBeUndefined();
  }));

  it("does not ask the store while the level in force is below content",
      () => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();
    account.config.adminWorkspaceAccess = "metadata";
    expect(await refusalOf(account.user.grantAccountAdminAccess(home)))
        .toStrictEqual(CONTENT_OFF);
    expect(store.calls).toStrictEqual([]);
    expect(raw(account)).toBeUndefined();
  }));

  it("ends a grant it gave when the link fails, and leaves one it renewed",
      () => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();

    store.fail.noteGrant = 1;
    await expect(account.user.grantAccountAdminAccess(home))
        .rejects.toThrow("The issue report store is unreachable.");
    expect(raw(account)).toMatchObject(
        { reportId: home, revokedAt: expect.any(Date), revokedBy: namedUser(ALICE) });
    expect(await account.user.liveAccountAdminGrant()).toBeNull();
    expect(await store.shown(home)).toBeUndefined();

    vi.useFakeTimers({ toFake: ["Date"] });
    let live = put(account, grantOf());
    store.fail.noteGrant = 1;
    await expect(account.user.grantAccountAdminAccess(home))
        .rejects.toThrow("The issue report store is unreachable.");
    // The grant named no report before, so it keeps the one this call named.
    expect(raw(account)).toStrictEqual(
        { ...live, reportId: home, expiresAt: new Date(Date.now() + LIFETIME_MS) });
    expect(await store.shown(home)).toBeUndefined();

    // A renewed grant that a report shows keeps that report, which takes the later end.
    let linked = await account.user.grantAccountAdminAccess(home);
    let other = await store.file();
    vi.setSystemTime(Date.now() + HOUR_MS);
    store.fail.noteGrant = 1;
    await expect(account.user.grantAccountAdminAccess(other))
        .rejects.toThrow("The issue report store is unreachable.");
    let renewed = { ...linked, expiresAt: new Date(Date.now() + LIFETIME_MS) };
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(linked.expiresAt.getTime());
    expect(raw(account)).toStrictEqual(renewed);
    expect(await store.shown(other)).toBeUndefined();
    expect(await store.shown(home))
        .toStrictEqual({ id: linked.id, scope: "account", expiresAt: renewed.expiresAt });
  }));

  it("tells a report linked by a call whose answer was lost of the renewed grant's end",
      () => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();
    vi.useFakeTimers({ toFake: ["Date"] });
    let live = put(account, grantOf());

    store.fail.noteGrantAnswer = 1;
    await expect(account.user.grantAccountAdminAccess(home))
        .rejects.toThrow("The issue report store's answer was lost.");
    let renewed = { ...live, reportId: home, expiresAt: new Date(Date.now() + LIFETIME_MS) };
    expect(raw(account)).toStrictEqual(renewed);
    let shown = { id: live.id, scope: "account", expiresAt: renewed.expiresAt };
    expect(await store.shown(home)).toStrictEqual(shown);

    vi.setSystemTime(Date.now() + HOUR_MS);
    await account.user.revokeAccountAdminAccess();
    let ended = raw(account) as AdminAccessGrant;
    expect(ended).toStrictEqual(
        { ...renewed, revokedAt: new Date(), revokedBy: namedUser(ALICE) });
    expect(await store.shown(home)).toStrictEqual({ ...shown, endedAt: ended.revokedAt });

    // The report shows an ended grant, so the next try gives a fresh one.
    let next = await account.user.grantAccountAdminAccess(home);
    expect(next.id).not.toBe(live.id);
    expect(raw(account)).toStrictEqual(next);
    expect(await store.shown(home))
        .toStrictEqual({ id: next.id, scope: "account", expiresAt: next.expiresAt });
  }));

  it("ends a grant it gave when the link fails on a report a call made meanwhile linked too",
      () => withAccount(async account => {
    let store = reportStore(account);
    let first = await store.file();
    let second = await store.file();

    // The first call gives the grant, and its link waits before it fails.
    let release!: () => void;
    store.fail.after = new Promise(resolve => { release = resolve; });
    store.fail.noteGrant = 1;
    let failed = account.user.grantAccountAdminAccess(first);
    await vi.waitFor(() => expect(store.calls).toContain("noteGrant"));

    // The second renews that grant and links its own report while the first waits.
    let given = await account.user.grantAccountAdminAccess(second);
    expect(raw(account)).toStrictEqual(given);
    let shown = { id: given.id, scope: "account", expiresAt: given.expiresAt };
    expect(await store.shown(second)).toStrictEqual(shown);

    release();
    await expect(failed).rejects.toThrow("The issue report store is unreachable.");
    let ended = raw(account) as AdminAccessGrant;
    expect(ended).toStrictEqual(
        { ...given, revokedAt: expect.any(Date), revokedBy: namedUser(ALICE) });
    expect(await account.user.liveAccountAdminGrant()).toBeNull();
    expect(await store.shown(first)).toBeUndefined();
    expect(await store.shown(second)).toStrictEqual({ ...shown, endedAt: ended.revokedAt });
  }));

  it("sends an end the reports missed again when the grant is ended again",
      () => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();
    let grant = await account.user.grantAccountAdminAccess(home);

    store.fail.noteGrant = 1;
    await account.user.revokeAccountAdminAccess();
    let ended = raw(account) as AdminAccessGrant;
    expect(ended.revokedAt).toBeInstanceOf(Date);
    expect(await store.shown(home))
        .toStrictEqual({ id: grant.id, scope: "account", expiresAt: grant.expiresAt });

    await account.user.revokeAccountAdminAccess();
    expect(raw(account)).toStrictEqual(ended);
    expect(await store.shown(home)).toMatchObject({ endedAt: ended.revokedAt });
  }));

  it.each([
    ["another report", true],
    ["no report", false],
  ])("sends an end the reports missed before a fresh grant given with %s replaces the ended one",
      (_name, withReport) => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();
    let other = await store.file();
    let ended = await endMissedBy(account, store, home);

    let fresh = await account.user.grantAccountAdminAccess(withReport ? other : undefined);
    expect(fresh.id).not.toBe(ended.id);
    expect(raw(account)).toStrictEqual(fresh);
    expect(await account.user.liveAccountAdminGrant()).toStrictEqual(fresh);
    expect(await store.shown(home)).toStrictEqual({
      id: ended.id, scope: "account", expiresAt: ended.expiresAt, endedAt: ended.revokedAt,
    });
    expect(await store.shown(other)).toStrictEqual(withReport
        ? { id: fresh.id, scope: "account", expiresAt: fresh.expiresAt } : undefined);
  }));

  it("gives a fresh grant with a report whose copy missed the end of its last one",
      () => withAccount(async account => {
    let store = reportStore(account);
    let home = await store.file();
    let ended = await endMissedBy(account, store, home);

    let fresh = await account.user.grantAccountAdminAccess(home);
    expect(fresh.id).not.toBe(ended.id);
    expect(fresh.reportId).toBe(home);
    expect(raw(account)).toStrictEqual(fresh);
    expect(await store.shown(home))
        .toStrictEqual({ id: fresh.id, scope: "account", expiresAt: fresh.expiresAt });
  }));

  it("calls the store not at all for a grant given with no report",
      () => withAccount(async account => {
    let store = reportStore(account);
    await account.user.revokeAccountAdminAccess();
    await account.user.grantAccountAdminAccess();
    await account.user.grantAccountAdminAccess();
    await account.user.revokeAccountAdminAccess();
    await account.user.revokeAccountAdminAccess();
    expect(store.calls).toStrictEqual([]);
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

    // Renewed with an issue report of the user's, which then shows it.
    let report = await session.submitIssueReport({ text: "The chart is blank.", priority: "high" });
    expect(report.grant).toBeUndefined();
    let renewed = await session.grantAccountAdminAccess({ reportId: report.id });
    expect(renewed).toStrictEqual({ ...grant, reportId: report.id, expiresAt: expect.any(Date) });
    let shown = { id: grant.id, scope: "account", expiresAt: renewed.expiresAt };
    expect((await session.getIssueReport(report.id)).grant).toStrictEqual(shown);

    account.config.adminWorkspaceAccess = "metadata";
    expect(await refusalOf(session.grantAccountAdminAccess())).toStrictEqual(CONTENT_OFF);

    expect(await session.revokeAccountAdminAccess()).toBeUndefined();
    let ended = await session.getAccountAdminGrant();
    expect(ended).toStrictEqual({
      ...renewed, revokedAt: expect.any(Date), revokedBy: { id: username, name: "Grace" },
    });
    expect((await session.getIssueReport(report.id)).grant)
        .toStrictEqual({ ...shown, endedAt: ended?.revokedAt });
    expect(await stub.liveAccountAdminGrant()).toBeNull();
  });
});
