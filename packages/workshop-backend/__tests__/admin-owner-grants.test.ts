// The grants a workspace's owner gives deployment admins to read its content
// (Overseer.grantAdminAccess(), renewAdminAccess(), revokeAdminAccess() and listAdminGrants()):
// who may call them, what each stores and returns, how the answers are bounded, that nothing is
// written to the admin audit log or anywhere else in the workspace, that they never touch a
// grant a second admin's approval gave, and how a grant given with an issue report reaches the
// report that shows it.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) whose impl.env is replaced
// per test, over real sessions opened on it. The deployment-wide log is the real
// AdminAuditDurableObject the Overseer reaches through ctx.exports, read back through the
// TEST_ADMIN_AUDIT binding.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, ADMIN_GRANT_LIFETIME_SECONDS,
  ISSUE_REPORT_ERROR_CODES, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_GRANTS_LISTED,
  getAdminAccessErrorCode, getAdminGrantErrorCode, getIssueReportErrorCode,
  type AdminAccessGrant, type AdminWorkspaceAccess, type AiChatAuthorInfo,
  type CollaboratorRole, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { IssueReportsDurableObject } from "../src/issue-reports.js";
import { namedUser } from "../src/admin-access.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
    TEST_ISSUE_REPORTS: DurableObjectNamespace<IssueReportsDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
const BOB: AiChatAuthorInfo = { type: "user", id: "bob@example.test", name: "Bob" };
const ADMIN = { id: "deployment-admin@example.test", name: "Ada Admin" };
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LIFETIME_MS = ADMIN_GRANT_LIFETIME_SECONDS * 1000;
const OWNER_ONLY = "Only the workspace owner can give admins access to it.";
const USE_ONLY = "Unauthorized: this collaborator only has permission to use the gadget's UI.";
// The prefix of the keys the workspace stores its grants under.
const GRANT_KEYS = "adminGrants:";

// A user object's id, as the fake namespace derives it from the account's name.
function userIdOf(name: string): string {
  return `user-do:${name}`;
}
const OWNER_USER_ID = userIdOf(OWNER.id);

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  id: string;
  // The accounts that exist, by name: what whoami() answers.
  accounts: Map<string, AiChatAuthorInfo>;
  // The deployment's stored settings, as the fake KV serves them.
  config: { adminWorkspaceAccess: AdminWorkspaceAccess; adminAuditRetentionDays: number };
  // Replaces the KV read when set, so a test can hold a call at its config read.
  kvGet?: (key: string) => Promise<string | null>;
  // Replaces an account's whoami() when set, so a test can hold a call at its profile read.
  whoami?: (profile: AiChatAuthorInfo) => Promise<AiChatAuthorInfo>;
};

// The fake user objects: each answers what a workspace asks of an account, and nothing is kept.
function fakeUsers(ws: Workspace) {
  let user = (id: string) => ({
    id,
    whoami: async () => {
      let profile = ws.accounts.get(id.slice(userIdOf("").length));
      if (!profile) throw new Error(`No account behind ${id}.`);
      return ws.whoami ? ws.whoami(profile) : profile;
    },
    listGatekeeperVendors: async () => [],
    setWorkspaceLastActive: async () => {},
    recordSharedWorkspaceOpen: async () => {},
    workspaceRemoved: async () => {},
    messageArrived: async () => {},
    getWorkspace: async () => null,
    getGadget: async () => null,
    syncWorkspaceOutputs: async () => {},
  });
  return { idFromString: (id: string) => id, idFromName: userIdOf, get: user };
}

// Sets impl.env to the pool's env with a cap of "content", a fake BLUEPRINTS serving
// `ws.config`, and `vars`.
function setEnv(ws: Workspace, vars: Record<string, unknown> = {}): void {
  ws.impl.env = {
    ...env,
    ADMIN_WORKSPACE_ACCESS_MAX: "content",
    BLUEPRINTS: {
      get: async (key: string) => ws.kvGet ? ws.kvGet(key)
          : key === ADMIN_CONFIG_KEY ? JSON.stringify(ws.config) : null,
    },
    ...vars,
  };
}

// An initialised workspace whose deployment lets content be granted: the level in force is
// "content".
async function withWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`admin-owner-grants-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = {
      impl, instance, state, id: state.id.toString(),
      accounts: new Map([[OWNER.id, OWNER], [BOB.id, BOB]]),
      config: { adminWorkspaceAccess: "content", adminAuditRetentionDays: RETENTION },
    };
    setEnv(ws);
    impl.directories = {
      getByName: () => ({ syncWorkspace: async () => {}, removeWorkspace: async () => {} }),
    };
    impl.users = fakeUsers(ws);
    // The side effects of opening and deleting that reach outside the workspace.
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.scheduleAccessRestart = async () => {};
    impl.ownerId = OWNER_USER_ID;
    impl.ownerProfileId = OWNER.id;
    impl.storage.ownerId.put(OWNER_USER_ID);
    impl.storage.title.put("Quarterly plan");
    await fn(ws);
  });
}

// Runs `fn` over a real owner session on the workspace.
async function asOwner<T>(ws: Workspace, fn: (client: Overseer) => Promise<T>): Promise<T> {
  // Disposed with the session: the session holds a duplicate of the stub until then.
  using notifyClosed = new NativeRpcStub<() => void>(() => {});
  using client = await ws.instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
  return await fn(client);
}

// Runs `fn` over a real session of BOB's, a collaborator with `role`.
async function asCollaborator<T>(ws: Workspace, role: CollaboratorRole,
                                 fn: (client: Overseer) => Promise<T>): Promise<T> {
  // What open() consults for someone who is not the owner: their access, and the sharing manager,
  // which it reaches only to redeem a share key.
  let authorize = vi.spyOn(ws.impl, "authorizeCollaborator")
      .mockResolvedValue(role === "use" ? { role, gadgetIds: "all" } : { role });
  let sharing = vi.spyOn(ws.impl, "getSharingManager").mockResolvedValue({});
  try {
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await ws.instance.open(userIdOf(BOB.id), BOB.id, notifyClosed);
    return await fn(client);
  } finally {
    authorize.mockRestore();
    sharing.mockRestore();
  }
}

// A grant given an hour ago and live for another, with `overrides`.
function grantOf(overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  return {
    id: crypto.randomUUID(), level: "content", source: "owner", scope: "workspace",
    grantedBy: namedUser(OWNER),
    grantedAt: new Date(Date.now() - HOUR_MS), expiresAt: new Date(Date.now() + HOUR_MS),
    ...overrides,
  };
}

// A grant a second admin's approval gave, as the workspace stores one.
function approvalGrantOf(overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  return grantOf({
    source: "admins", grantedBy: ADMIN, requestedBy: "requester-admin@example.test",
    requestId: `request-${crypto.randomUUID()}`, reason: "Asked to look", ...overrides,
  });
}

// Puts `grant` into the workspace's storage directly, and returns it.
function put(ws: Workspace, grant: AdminAccessGrant): AdminAccessGrant {
  ws.impl.storage.adminGrants.put(grant);
  return grant;
}

// Puts `count` grants given a minute apart, the first the newest, each built by `make`.
function putMany(ws: Workspace, count: number, startMinutesAgo: number,
                 make: (grantedAt: Date) => AdminAccessGrant): AdminAccessGrant[] {
  return Array.from({ length: count }, (_, i) =>
      put(ws, make(new Date(Date.now() - (startMinutesAgo + i) * 60_000))));
}

// A promise a test settles when it chooses.
function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let { promise, resolve } = Promise.withResolvers<T>();
  return { promise, release: resolve };
}

// Lets what has been started reach the call it is held at.
async function settle(): Promise<void> {
  await scheduler.wait(20);
}

// The grants the workspace stores, in no particular order.
function storedGrants(ws: Workspace): AdminAccessGrant[] {
  return [...ws.impl.storage.adminGrants.list()];
}

// One stored grant exactly as it is kept: the raw value under its key.
function raw(ws: Workspace, id: string): unknown {
  return ws.state.storage.kv.get(`${GRANT_KEYS}${id}`);
}

// Everything the workspace stores but its grants, keys and values.
function storedBesidesGrants(ws: Workspace): [string, unknown][] {
  return [...ws.state.storage.kv.list()].filter(([key]) => !key.startsWith(GRANT_KEYS));
}

// The deployment-wide audit log, newest first.
async function auditRecords(): Promise<unknown[]> {
  return (await env.TEST_ADMIN_AUDIT.getByName("").list({ limit: 200 }, RETENTION)).records;
}

// What a call is refused with: its code, of either family, and its message.
async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return {
      code: getAdminGrantErrorCode(err) ?? getAdminAccessErrorCode(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
  throw new Error("Expected a refusal.");
}

const NOT_FOUND = { code: ADMIN_GRANT_ERROR_CODES.notFound, message: "No such grant." };

afterEach(() => {
  vi.useRealTimers();
});

describe("who may call the grant methods", () => {
  it("refuses a collaborator who builds, with the owner-only error", () => withWorkspace(async ws => {
    let live = put(ws, grantOf());
    await asCollaborator(ws, "build", async client => {
      for (let call of [
        () => client.grantAdminAccess(), () => client.renewAdminAccess(live.id),
        () => client.revokeAdminAccess(live.id), () => client.listAdminGrants(),
      ]) {
        expect(await refusalOf(call())).toStrictEqual({ code: undefined, message: OWNER_ONLY });
      }
    });
    expect(storedGrants(ws)).toStrictEqual([live]);
  }));

  it("refuses a collaborator who only uses a gadget, with the use-only error",
      () => withWorkspace(async ws => {
    let live = put(ws, grantOf());
    await asCollaborator(ws, "use", async client => {
      for (let call of [
        () => client.grantAdminAccess(), () => client.renewAdminAccess(live.id),
        () => client.revokeAdminAccess(live.id), () => client.listAdminGrants(),
      ]) {
        expect(await refusalOf(call())).toStrictEqual({ code: undefined, message: USE_ONLY });
      }
    });
    expect(storedGrants(ws)).toStrictEqual([live]);
  }));
});

describe("giving a grant", () => {
  it("stores a grant for 72 hours and returns it", () => withWorkspace(async ws => {
    await asOwner(ws, async client => {
      expect(await client.listAdminGrants()).toStrictEqual([]);

      let before = Date.now();
      let grant = await client.grantAdminAccess();
      let after = Date.now();

      expect(grant).toStrictEqual({
        id: expect.any(String), level: "content", source: "owner", scope: "workspace",
        grantedBy: { id: OWNER.id, name: OWNER.name },
        grantedAt: expect.any(Date), expiresAt: expect.any(Date),
      });
      expect(grant.grantedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(grant.grantedAt.getTime()).toBeLessThanOrEqual(after);
      expect(grant.expiresAt.getTime() - grant.grantedAt.getTime()).toBe(LIFETIME_MS);
      expect(storedGrants(ws)).toStrictEqual([grant]);
      expect(await client.listAdminGrants()).toStrictEqual([grant]);
      expect(ws.impl.liveAdminGrants()).toStrictEqual([grant]);
    });
  }));

  it("lets two live grants coexist, the newest first", () => withWorkspace(async ws => {
    await asOwner(ws, async client => {
      let older = put(ws, grantOf({ grantedAt: new Date(Date.now() - 2 * HOUR_MS) }));
      let approval = put(ws, approvalGrantOf({ grantedAt: new Date(Date.now() - HOUR_MS) }));
      let newest = await client.grantAdminAccess();

      expect(ws.impl.liveAdminGrants()).toStrictEqual([newest, approval, older]);
      expect(await client.listAdminGrants()).toStrictEqual([newest, older]);
    });
  }));

  it("keeps an id and a bounded name of the owner, and nothing else of their profile",
      () => withWorkspace(async ws => {
    ws.accounts.set(OWNER.id, {
      ...OWNER, name: "n".repeat(1_000_000), commitEmail: "owner@example.test",
      description: "About the owner",
    });
    await asOwner(ws, async client => {
      let grant = await client.grantAdminAccess();
      let owner = { id: OWNER.id, name: `${"n".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…` };
      expect(grant.grantedBy).toStrictEqual(owner);
      expect(storedGrants(ws)[0]!.grantedBy).toStrictEqual(owner);

      await client.revokeAdminAccess(grant.id);
      let [revoked] = await client.listAdminGrants();
      expect(revoked!.revokedBy).toStrictEqual(owner);
      expect(storedGrants(ws)[0]!.revokedBy).toStrictEqual(owner);
      expect(JSON.stringify(storedGrants(ws)).length).toBeLessThan(2048);
    });
  }));

  it("is refused while the level in force is below content, and stores nothing",
      () => withWorkspace(async ws => {
    await asOwner(ws, async client => {
      for (let level of ["metadata", "off"] as const) {
        ws.config.adminWorkspaceAccess = level;
        expect((await refusalOf(client.grantAdminAccess())).code)
            .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
      }
      // The admins chose content, and the environment's cap is below it.
      ws.config.adminWorkspaceAccess = "content";
      setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: undefined });
      expect((await refusalOf(client.grantAdminAccess())).code)
          .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);

      expect(storedGrants(ws)).toStrictEqual([]);
      expect(await client.listAdminGrants()).toStrictEqual([]);
    });
  }));
});

describe("renewing a grant", () => {
  it("moves the end 72 hours from now, any number of times", () => withWorkspace(async ws => {
    await asOwner(ws, async client => {
      let grant = await client.grantAdminAccess();
      // As though given two days ago, with a day left.
      let grantedAt = new Date(Date.now() - 2 * DAY_MS);
      put(ws, { ...grant, grantedAt, expiresAt: new Date(grantedAt.getTime() + LIFETIME_MS) });

      let last = grantedAt.getTime() + LIFETIME_MS;
      for (let i = 0; i < 60; i++) {
        let before = Date.now();
        let renewed = await client.renewAdminAccess(grant.id);
        let after = Date.now();

        expect(renewed).toStrictEqual({ ...grant, grantedAt, expiresAt: expect.any(Date) });
        expect(renewed.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LIFETIME_MS);
        expect(renewed.expiresAt.getTime()).toBeLessThanOrEqual(after + LIFETIME_MS);
        expect(renewed.expiresAt.getTime()).toBeGreaterThanOrEqual(last);
        expect(storedGrants(ws)).toStrictEqual([renewed]);
        last = renewed.expiresAt.getTime();
      }
    });
  }));

  it("refuses a grant that has expired or was revoked", () => withWorkspace(async ws => {
    let expired = put(ws, grantOf({ expiresAt: new Date(Date.now() - 1) }));
    let revoked = put(ws, grantOf({ revokedAt: new Date(), revokedBy: namedUser(OWNER) }));
    await asOwner(ws, async client => {
      expect(await refusalOf(client.renewAdminAccess(expired.id))).toStrictEqual(NOT_FOUND);
      expect(await refusalOf(client.renewAdminAccess(revoked.id))).toStrictEqual(NOT_FOUND);
    });
    expect(raw(ws, expired.id)).toStrictEqual({ ...expired, id: null });
    expect(raw(ws, revoked.id)).toStrictEqual({ ...revoked, id: null });
  }));

  it("refuses a stored grant whose end is not a valid time", () => withWorkspace(async ws => {
    let invalid = put(ws, grantOf({ expiresAt: new Date(NaN) }));
    let live = put(ws, grantOf());

    expect(storedGrants(ws)).toHaveLength(2);
    expect(ws.impl.liveAdminGrants()).toStrictEqual([live]);
    await asOwner(ws, async client => {
      expect(await refusalOf(client.renewAdminAccess(invalid.id))).toStrictEqual(NOT_FOUND);
    });
    expect(ws.impl.liveAdminGrants()).toStrictEqual([live]);
  }));

  it("is refused while the level in force is below content, and stores nothing",
      () => withWorkspace(async ws => {
    let live = put(ws, grantOf());
    ws.config.adminWorkspaceAccess = "metadata";
    await asOwner(ws, async client => {
      expect((await refusalOf(client.renewAdminAccess(live.id))).code)
          .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
      // An id that names no live grant is refused as such first.
      expect(await refusalOf(client.renewAdminAccess(crypto.randomUUID())))
          .toStrictEqual(NOT_FOUND);
    });
    expect(storedGrants(ws)).toStrictEqual([live]);
  }));
});

describe("ending a grant", () => {
  it("ends it now, naming the owner", () => withWorkspace(async ws => {
    await asOwner(ws, async client => {
      let grant = await client.grantAdminAccess();

      let before = Date.now();
      await client.revokeAdminAccess(grant.id);
      let after = Date.now();

      let [ended] = storedGrants(ws);
      expect(ended).toStrictEqual({
        ...grant, revokedAt: expect.any(Date), revokedBy: { id: OWNER.id, name: OWNER.name },
      });
      expect(ended!.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(ended!.revokedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(ws.impl.liveAdminGrants()).toStrictEqual([]);
      expect(await client.listAdminGrants()).toStrictEqual([ended]);
      expect(await refusalOf(client.renewAdminAccess(grant.id))).toStrictEqual(NOT_FOUND);
    });
  }));

  it("changes nothing the second time", () => withWorkspace(async ws => {
    await asOwner(ws, async client => {
      let grant = await client.grantAdminAccess();
      await client.revokeAdminAccess(grant.id);
      let ended = raw(ws, grant.id);

      await scheduler.wait(5);
      await client.revokeAdminAccess(grant.id);
      expect(raw(ws, grant.id)).toStrictEqual(ended);
    });
  }));

  it("leaves an expired grant as it is", () => withWorkspace(async ws => {
    let expired = put(ws, grantOf({ expiresAt: new Date(Date.now() - 1) }));
    await asOwner(ws, client => client.revokeAdminAccess(expired.id));
    expect(storedGrants(ws)).toStrictEqual([expired]);
  }));

  it("refuses an id that names no grant", () => withWorkspace(async ws => {
    put(ws, grantOf());
    await asOwner(ws, async client => {
      expect(await refusalOf(client.revokeAdminAccess("not-a-grant"))).toStrictEqual(NOT_FOUND);
      expect(await refusalOf(client.revokeAdminAccess(""))).toStrictEqual(NOT_FOUND);
    });
  }));

  it("works, as the listing does, whatever the level in force", () => withWorkspace(async ws => {
    let live = put(ws, grantOf());
    await asOwner(ws, async client => {
      for (let level of ["metadata", "off"] as const) {
        ws.config.adminWorkspaceAccess = level;
        expect(await client.listAdminGrants()).toStrictEqual([live]);
      }
      await client.revokeAdminAccess(live.id);
      expect(await client.listAdminGrants())
          .toMatchObject([{ id: live.id, revokedBy: namedUser(OWNER) }]);
    });
    expect(ws.impl.liveAdminGrants()).toStrictEqual([]);
  }));
});

describe("listing grants", () => {
  it("lists the newest live grants when there are more than it returns",
      () => withWorkspace(async ws => {
    // A giver whose id and name are as long as a grant keeps.
    let grantedBy = namedUser({ id: "i".repeat(1000), name: "n".repeat(1000) });
    // The ended ones were given after the live ones: being newer does not put them first.
    let ended = putMany(ws, 10, 0, grantedAt => grantOf(
        { grantedBy, grantedAt, revokedAt: new Date(), revokedBy: grantedBy }));
    let live = putMany(ws, 30, 60, grantedAt => grantOf({ grantedBy, grantedAt }));

    let listed = await asOwner(ws, client => client.listAdminGrants());
    expect(listed).toHaveLength(MAX_ADMIN_GRANTS_LISTED);
    expect(listed).toStrictEqual(live.slice(0, MAX_ADMIN_GRANTS_LISTED));
    expect(JSON.stringify(listed).length).toBeLessThan(64 * 1024);

    expect(ws.impl.liveAdminGrants()).toStrictEqual(live);
    expect(storedGrants(ws)).toHaveLength(ended.length + live.length);
  }));

  it("lists the live grants, then the newest ended ones", () => withWorkspace(async ws => {
    let ended = putMany(ws, 25, 0, grantedAt => grantOf({ grantedAt, revokedAt: new Date() }));
    let live = putMany(ws, 3, 60, grantedAt => grantOf({ grantedAt }));

    let listed = await asOwner(ws, client => client.listAdminGrants());
    expect(listed).toStrictEqual([...live, ...ended.slice(0, MAX_ADMIN_GRANTS_LISTED - 3)]);
  }));

  it("deletes a grant that ended longer ago than the retention, and lists a newer one",
      () => withWorkspace(async ws => {
    let cutoff = Date.now() - RETENTION * DAY_MS;
    let longExpired = put(ws, grantOf({ expiresAt: new Date(cutoff - HOUR_MS) }));
    let longRevoked = put(ws, grantOf({ revokedAt: new Date(cutoff - HOUR_MS) }));
    let invalid = put(ws, grantOf({ expiresAt: new Date(NaN) }));
    let recent = put(ws, grantOf(
        { grantedAt: new Date(cutoff), expiresAt: new Date(cutoff + HOUR_MS) }));

    let listed = await asOwner(ws, client => client.listAdminGrants());
    expect(listed).toStrictEqual([recent]);
    expect(storedGrants(ws)).toStrictEqual([recent]);
    for (let gone of [longExpired, longRevoked, invalid]) {
      expect(raw(ws, gone.id)).toBeUndefined();
    }
  }));

  it("keeps ended grants for the retention the environment's floor gives",
      () => withWorkspace(async ws => {
    // The admins chose a day; the floor holds it at 90.
    ws.config.adminAuditRetentionDays = 1;
    let ended = put(ws, grantOf({ expiresAt: new Date(Date.now() - 30 * DAY_MS) }));
    await asOwner(ws, async client => {
      expect(await client.listAdminGrants()).toStrictEqual([ended]);

      setEnv(ws, { ADMIN_AUDIT_RETENTION_MIN_DAYS: "7" });
      expect(await client.listAdminGrants()).toStrictEqual([]);
    });
    expect(storedGrants(ws)).toStrictEqual([]);
  }));
});

describe("an owner grant that ended longer ago than the retention", () => {
  it("is deleted by the owner's next call, whichever it is", () => withWorkspace(async ws => {
    let longAgo = new Date(Date.now() - RETENTION * DAY_MS - HOUR_MS);
    let live = put(ws, grantOf());
    await asOwner(ws, async client => {
      // The listing is never called: each of the other three deletes on its own.
      for (let call of [
        () => client.grantAdminAccess(), () => client.renewAdminAccess(live.id),
        () => client.revokeAdminAccess(live.id),
      ]) {
        let gone = [
          put(ws, grantOf({ expiresAt: longAgo })),
          put(ws, grantOf({ revokedAt: longAgo, revokedBy: namedUser(OWNER) })),
        ];
        for (let grant of gone) expect(raw(ws, grant.id)).toBeDefined();

        await call();
        for (let grant of gone) expect(raw(ws, grant.id)).toBeUndefined();
      }
    });
    // What is left: the grant the first call gave, and the one the last call ended.
    expect(storedGrants(ws)).toHaveLength(2);
    expect(ws.impl.liveAdminGrants()).toMatchObject([{ source: "owner", scope: "workspace" }]);
    expect(raw(ws, live.id)).toMatchObject({ revokedBy: namedUser(OWNER) });
  }));
});

describe("what the grant methods leave alone", () => {
  it("write no admin audit record, and nothing else the workspace stores",
      () => withWorkspace(async ws => {
    put(ws, grantOf({ expiresAt: new Date(Date.now() - 2 * RETENTION * DAY_MS) }));
    await asOwner(ws, async client => {
      let audit = await auditRecords();
      let stored = storedBesidesGrants(ws);
      let metadata = await client.getMetadata();
      // What a session subscribed to the workspace's metadata and actions is delivered.
      let delivered: unknown[] = [];
      using onMetadata = new NativeRpcStub((update: unknown) => { delivered.push(update); });
      using onAction = new NativeRpcStub({
        ready: async () => {}, onRpcBroken: () => {},
        entry: async (entry: unknown) => { delivered.push(entry); },
      } as any);
      let subscriptions = [
        await client.subscribeToMetadata(onMetadata as any),
        await client.subscribeToActions(onAction as any),
      ];
      await scheduler.wait(50);
      expect(delivered).toStrictEqual([metadata]);

      let grant = await client.grantAdminAccess();
      await client.renewAdminAccess(grant.id);
      expect(await client.listAdminGrants()).toHaveLength(1);
      await client.revokeAdminAccess(grant.id);
      await client.revokeAdminAccess(grant.id);
      expect(await refusalOf(client.renewAdminAccess(grant.id))).toStrictEqual(NOT_FOUND);
      ws.config.adminWorkspaceAccess = "metadata";
      expect((await refusalOf(client.grantAdminAccess())).code)
          .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);

      expect(await auditRecords()).toStrictEqual(audit);
      expect(storedBesidesGrants(ws)).toStrictEqual(stored);
      expect(await client.getMetadata()).toStrictEqual(metadata);
      expect((await client.listActions({ filter: "all" })).entries).toStrictEqual([]);
      // Long enough for a delivery to have arrived, had one been made.
      await scheduler.wait(50);
      expect(delivered).toStrictEqual([metadata]);
      for (let subscription of subscriptions) {
        (subscription as unknown as Disposable)[Symbol.dispose]();
      }
    });
  }));

  it("never touch a grant a second admin's approval gave", () => withWorkspace(async ws => {
    let live = put(ws, approvalGrantOf());
    let longEnded = put(ws, approvalGrantOf({
      revokedAt: new Date(Date.now() - 2 * RETENTION * DAY_MS), revokedBy: ADMIN,
    }));
    // One that ran out an hour ago, which nothing recorded.
    let ranOut = put(ws, approvalGrantOf({ expiresAt: new Date(Date.now() - HOUR_MS) }));
    let kept = () => [raw(ws, live.id), raw(ws, longEnded.id), raw(ws, ranOut.id)];
    let before = kept();
    expect(before).toStrictEqual(
        [{ ...live, id: null }, { ...longEnded, id: null }, { ...ranOut, id: null }]);

    await asOwner(ws, async client => {
      let audit = await auditRecords();
      // What an id that names nothing is refused with.
      let renewNothing = await refusalOf(client.renewAdminAccess(crypto.randomUUID()));
      let revokeNothing = await refusalOf(client.revokeAdminAccess(crypto.randomUUID()));
      expect(renewNothing).toStrictEqual(NOT_FOUND);
      expect(revokeNothing).toStrictEqual(NOT_FOUND);

      let own = await client.grantAdminAccess();
      expect(kept()).toStrictEqual(before);

      for (let grant of [live, longEnded, ranOut]) {
        expect(await refusalOf(client.renewAdminAccess(grant.id))).toStrictEqual(renewNothing);
        expect(kept()).toStrictEqual(before);
        expect(await refusalOf(client.revokeAdminAccess(grant.id))).toStrictEqual(revokeNothing);
        expect(kept()).toStrictEqual(before);
      }

      expect(await client.listAdminGrants()).toStrictEqual([own]);
      expect(kept()).toStrictEqual(before);
      await client.renewAdminAccess(own.id);
      await client.revokeAdminAccess(own.id);
      expect(kept()).toStrictEqual(before);

      expect(await auditRecords()).toStrictEqual(audit);
    });

    expect(ws.impl.liveAdminGrants()).toStrictEqual([live]);
    expect(storedGrants(ws)).toHaveLength(4);
  }));

  it("delete an approval's long-ended grant only when no source is named",
      () => withWorkspace(async ws => {
    let ended = new Date(Date.now() - 2 * RETENTION * DAY_MS);
    let approval = put(ws, approvalGrantOf({ revokedAt: ended, revokedBy: ADMIN }));
    let own = put(ws, grantOf({ revokedAt: ended, revokedBy: namedUser(OWNER) }));
    let live = put(ws, grantOf());

    ws.impl.pruneAdminGrants(RETENTION, "owner");
    expect(raw(ws, own.id)).toBeUndefined();
    expect(raw(ws, approval.id)).toStrictEqual({ ...approval, id: null });

    ws.impl.pruneAdminGrants(RETENTION);
    expect(storedGrants(ws)).toStrictEqual([live]);
  }));
});

describe("a workspace that is deleted", () => {
  it("stores nothing for a call that was reading the deployment's settings",
      () => withWorkspace(async ws => {
    let live = put(ws, grantOf());
    await asOwner(ws, async client => {
      // Each call is held at its read of the settings, then finds the workspace deleted.
      let config = held<string | null>();
      ws.kvGet = () => config.promise;
      let calls = [
        client.grantAdminAccess(), client.renewAdminAccess(live.id),
        client.revokeAdminAccess(live.id), client.listAdminGrants(),
      ].map(call => call.then(value => ({ value }), error => ({ error })));
      await settle();

      ws.impl.beginDeletion(new Set());
      config.release(JSON.stringify(ws.config));
      let [granted, renewed, revoked, listed] = await Promise.all(calls);

      expect(getAdminGrantErrorCode((granted as { error: unknown }).error))
          .toBe(ADMIN_GRANT_ERROR_CODES.notFound);
      expect(getAdminGrantErrorCode((renewed as { error: unknown }).error))
          .toBe(ADMIN_GRANT_ERROR_CODES.notFound);
      expect(revoked).toStrictEqual({ value: undefined });
      expect(listed).toStrictEqual({ value: [] });
      expect(storedGrants(ws)).toStrictEqual([live]);
    });
  }));

  it("stores nothing for a call that was reading the owner's profile",
      () => withWorkspace(async ws => {
    let live = put(ws, grantOf());
    let profile = held<AiChatAuthorInfo>();
    ws.whoami = () => profile.promise;
    await asOwner(ws, async client => {
      let calls = [client.grantAdminAccess(), client.revokeAdminAccess(live.id)]
          .map(call => call.then(value => ({ value }), error => ({ error })));
      await settle();

      ws.impl.beginDeletion(new Set());
      profile.release(OWNER);
      let [granted, revoked] = await Promise.all(calls);

      expect(getAdminGrantErrorCode((granted as { error: unknown }).error))
          .toBe(ADMIN_GRANT_ERROR_CODES.notFound);
      expect(revoked).toStrictEqual({ value: undefined });
      expect(storedGrants(ws)).toStrictEqual([live]);
    });
  }));

  it("takes its grants with it", () => withWorkspace(async ws => {
    put(ws, approvalGrantOf());
    await asOwner(ws, async client => {
      await client.grantAdminAccess();
      expect(storedGrants(ws)).toHaveLength(2);

      await client.deleteSelf();
      expect([...ws.state.storage.kv.list()]).toStrictEqual([]);
      expect(await client.listAdminGrants()).toStrictEqual([]);
      expect([...ws.state.storage.kv.list()]).toStrictEqual([]);
    });
  }));
});

// A fresh issue report store of the real class, which the workspace reaches in place of the
// deployment's. `calls` names each call the workspace makes to it; `fail.noteGrant` is how many
// of the next noteGrant() calls reject without reaching it, and `fail.noteGrantAnswer` how many
// reach it and then reject, as a call whose answer was lost does.
function reportStore(ws: Workspace) {
  let stub = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
  let calls: string[] = [];
  let fail = { noteGrant: 0, noteGrantAnswer: 0 };
  ws.impl.issueReports = { getByName: () => ({
    checkGrantLink: (...args: Parameters<IssueReportsDurableObject["checkGrantLink"]>) => {
      calls.push("checkGrantLink");
      return stub.checkGrantLink(...args);
    },
    noteGrant: async (...args: Parameters<IssueReportsDurableObject["noteGrant"]>) => {
      calls.push("noteGrant");
      if (fail.noteGrant-- > 0) throw new Error("The issue report store is unreachable.");
      await stub.noteGrant(...args);
      if (fail.noteGrantAnswer-- > 0) throw new Error("The issue report store's answer was lost.");
    },
  }) };
  return {
    stub, calls, fail,
    // Files a report about the workspace (or about `workspaceId`) for `reporter`.
    file: async (reporter: AiChatAuthorInfo = OWNER, workspaceId: string = ws.id) =>
        (await stub.submit(reporter, {
          text: "The chart is blank.", priority: "high", context: { workspaceId },
        }, reporter === OWNER)).id,
    // The grant a report shows, as admins and as its reporter read it.
    shown: async (reportId: string, reporter: AiChatAuthorInfo = OWNER) => {
      let grant = (await stub.get(reportId)).grant;
      expect((await stub.getOwn(reporter.id, reportId)).grant).toStrictEqual(grant);
      return grant;
    },
    grantRows: () => runInDurableObject(stub, (_reports, state) =>
        state.storage.sql.exec("SELECT id FROM grants").toArray().length),
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

describe("a grant given with an issue report", () => {
  it("is shown by the report, through its renewal and its end", () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    await asOwner(ws, async client => {
      let audit = await auditRecords();
      let grant = await client.grantAdminAccess({ reportId });
      expect(grant).toMatchObject({ source: "owner", scope: "workspace", reportId });
      expect(storedGrants(ws)).toStrictEqual([grant]);
      expect(await store.shown(reportId))
          .toStrictEqual({ id: grant.id, scope: "workspace", expiresAt: grant.expiresAt });

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + HOUR_MS });
      let renewed = await client.renewAdminAccess(grant.id);
      expect(renewed.expiresAt.getTime()).toBeGreaterThan(grant.expiresAt.getTime());
      expect(await store.shown(reportId))
          .toStrictEqual({ id: grant.id, scope: "workspace", expiresAt: renewed.expiresAt });

      await client.revokeAdminAccess(grant.id);
      let [ended] = storedGrants(ws);
      expect(await store.shown(reportId)).toStrictEqual({
        id: grant.id, scope: "workspace", expiresAt: renewed.expiresAt, endedAt: ended.revokedAt,
      });
      expect(await auditRecords()).toStrictEqual(audit);
    });
  }));

  it("refuses a report that cannot show the grant, and gives none", () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let bobs = await store.file(BOB);
    let elsewhere = await store.file(OWNER, "another-workspace");
    let linked = await store.file();
    await asOwner(ws, async client => {
      let live = await client.grantAdminAccess({ reportId: linked });
      let before = await client.listAdminGrants();
      for (let reportId of [bobs, elsewhere, linked, "no-such-report"]) {
        expect(await reportRefusalOf(client.grantAdminAccess({ reportId })))
            .toBe(ISSUE_REPORT_ERROR_CODES.notFound);
      }
      expect(await client.listAdminGrants()).toStrictEqual(before);
      expect(await store.shown(bobs, BOB)).toBeUndefined();
      expect(await store.shown(elsewhere)).toBeUndefined();
      expect(await store.shown(linked)).toMatchObject({ id: live.id });
      // Each refusal came from the question asked before anything was stored.
      expect(store.calls.slice(2)).toStrictEqual(Array(4).fill("checkGrantLink"));
    });
  }));

  it("does not ask the store while the level in force is below content",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    ws.config.adminWorkspaceAccess = "metadata";
    await asOwner(ws, async client => {
      expect((await refusalOf(client.grantAdminAccess({ reportId }))).code)
          .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
    });
    expect(store.calls).toStrictEqual([]);
    expect(storedGrants(ws)).toStrictEqual([]);
  }));

  it("is refused a collaborator, who can file a report but not give a grant",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file(BOB);
    await asCollaborator(ws, "build", async client => {
      await expect(client.grantAdminAccess({ reportId })).rejects.toThrow(OWNER_ONLY);
    });
    await asCollaborator(ws, "use", async client => {
      await expect(client.grantAdminAccess({ reportId })).rejects.toThrow(USE_ONLY);
    });
    expect(store.calls).toStrictEqual([]);
    expect(storedGrants(ws)).toStrictEqual([]);
  }));

  it("replaces the report's grant once that one was revoked or has expired",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    await asOwner(ws, async client => {
      let first = await client.grantAdminAccess({ reportId });
      await client.revokeAdminAccess(first.id);
      let second = await client.grantAdminAccess({ reportId });
      expect(await store.shown(reportId)).toMatchObject({ id: second.id });

      // The second grant expires: aged in the workspace and in the store's copy.
      let past = new Date(Date.now() - HOUR_MS);
      put(ws, { ...second, expiresAt: past });
      await runInDurableObject(store.stub, (_reports, state) => {
        state.storage.sql.exec("UPDATE grants SET expires_at = ?", past.getTime());
      });
      let third = await client.grantAdminAccess({ reportId });
      expect(await store.shown(reportId))
          .toStrictEqual({ id: third.id, scope: "workspace", expiresAt: third.expiresAt });
      expect(await store.grantRows()).toBe(1);
    });
  }));

  it("ends the grant at once when the link fails after it was stored",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    await asOwner(ws, async client => {
      store.fail.noteGrant = 1;
      await expect(client.grantAdminAccess({ reportId }))
          .rejects.toThrow("The issue report store is unreachable.");
      // The second call tells the store of the end, which no report shows.
      expect(store.calls).toStrictEqual(["checkGrantLink", "noteGrant", "noteGrant"]);
      expect(storedGrants(ws)).toStrictEqual([{
        id: expect.any(String), level: "content", source: "owner", scope: "workspace",
        grantedBy: namedUser(OWNER), reportId, grantedAt: expect.any(Date),
        expiresAt: expect.any(Date), revokedAt: expect.any(Date), revokedBy: namedUser(OWNER),
      }]);
      expect(ws.impl.liveAdminGrants()).toStrictEqual([]);
      expect(await store.shown(reportId)).toBeUndefined();
    });
  }));

  it("tells the report of the end when the link was made and its answer was lost",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    await asOwner(ws, async client => {
      store.fail.noteGrantAnswer = 1;
      await expect(client.grantAdminAccess({ reportId }))
          .rejects.toThrow("The issue report store's answer was lost.");
      let [ended] = storedGrants(ws);
      expect(ended.revokedAt).toBeInstanceOf(Date);
      expect(ws.impl.liveAdminGrants()).toStrictEqual([]);
      expect(await store.shown(reportId)).toStrictEqual({
        id: ended.id, scope: "workspace", expiresAt: ended.expiresAt, endedAt: ended.revokedAt,
      });

      // The report shows an ended grant, so the owner's next try gives a fresh one.
      let next = await client.grantAdminAccess({ reportId });
      expect(next.id).not.toBe(ended.id);
      expect(ws.impl.liveAdminGrants()).toStrictEqual([next]);
      expect(await store.shown(reportId))
          .toStrictEqual({ id: next.id, scope: "workspace", expiresAt: next.expiresAt });
    });
  }));

  it("sends an end the report missed again when the grant is ended again",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    await asOwner(ws, async client => {
      let grant = await client.grantAdminAccess({ reportId });
      store.fail.noteGrant = 1;
      await client.revokeAdminAccess(grant.id);
      let [ended] = storedGrants(ws);
      expect(ended.revokedAt).toBeInstanceOf(Date);
      expect(await store.shown(reportId))
          .toStrictEqual({ id: grant.id, scope: "workspace", expiresAt: grant.expiresAt });

      await client.revokeAdminAccess(grant.id);
      expect(storedGrants(ws)).toStrictEqual([ended]);
      expect(await store.shown(reportId)).toMatchObject({ endedAt: ended.revokedAt });

      // A renewal's push is best effort too.
      let next = await client.grantAdminAccess({ reportId });
      store.fail.noteGrant = 1;
      let renewed = await client.renewAdminAccess(next.id);
      expect(ws.impl.liveAdminGrants()).toStrictEqual([renewed]);
    });
  }));

  it("calls the store not at all for a grant given with no report", () => withWorkspace(async ws => {
    let store = reportStore(ws);
    await asOwner(ws, async client => {
      let grant = await client.grantAdminAccess();
      await client.renewAdminAccess(grant.id);
      await client.revokeAdminAccess(grant.id);
      await client.revokeAdminAccess(grant.id);
    });
    expect(store.calls).toStrictEqual([]);
  }));

  it("keeps one row in the store through fifty grants and ends on one report",
      () => withWorkspace(async ws => {
    let store = reportStore(ws);
    let reportId = await store.file();
    await asOwner(ws, async client => {
      for (let turn = 0; turn < 50; turn++) {
        let grant = await client.grantAdminAccess({ reportId });
        await client.revokeAdminAccess(grant.id);
      }
    });
    expect(storedGrants(ws)).toHaveLength(50);
    expect(await store.grantRows()).toBe(1);
  }));
});
