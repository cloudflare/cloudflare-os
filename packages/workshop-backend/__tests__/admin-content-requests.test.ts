// The deployment-wide store of requests to read a workspace's content without its owner
// (AdminSettings): a request and a denial recorded before they are stored, the one pending request
// per workspace and the deployment-wide cap, the claim an approval makes for an admin other than
// the requester at level "content", the settling of the workspace's answer, and the sweep that
// expires, fails and forgets requests as they are read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_CONTENT_REQUEST_LIFETIME_SECONDS, ADMIN_GRANT_ERROR_CODES,
  MAX_PENDING_CONTENT_REQUESTS, getAdminAccessErrorCode, getAdminGrantErrorCode,
  type AdminContentRequest, type AdminContentRequestQuery, type AdminGrantRecord,
} from "@gadgets/workshop-shared/api";
import type { AdminGrantActor } from "../src/admin-access.js";
import type { AdminSettings } from "../src/admin-settings.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";
import { ADMIN, OTHER_ADMIN, adminSettingsHarness } from "./admin-settings-harness";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

let harness: ReturnType<typeof adminSettingsHarness>;

// A harness whose admins chose level "content", which the default environment's cap allows.
beforeEach(async () => {
  harness = adminSettingsHarness();
  await harness.inDo(admin => harness.storageOf(admin).adminConfig.put(
      { ...DEFAULT_ADMIN_CONFIG, adminWorkspaceAccess: "content" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A pending request as AdminApiImpl builds one, made by ADMIN from the CLI. */
function pendingRequest(overrides: Partial<AdminContentRequest> = {}): AdminContentRequest {
  const requestedAt = new Date();
  return {
    id: crypto.randomUUID(), workspaceId: "a".repeat(64), workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test", reason: "Ticket 7: the owner cannot be reached",
    requestedBy: ADMIN, via: "cli", requestedAt,
    expiresAt: new Date(requestedAt.getTime() + ADMIN_CONTENT_REQUEST_LIFETIME_SECONDS * 1000),
    state: "pending",
    ...overrides,
  };
}

function actor(admin: string): AdminGrantActor {
  return { admin, sessionId: `session of ${admin}`, via: "api" };
}

/** What `call` rejects with. Awaited inside the Durable Object, so the error is the one thrown. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject.");
}

const codeOf = async (call: Promise<unknown>) => {
  const error = await rejection(call);
  return getAdminGrantErrorCode(error) ?? getAdminAccessErrorCode(error);
};

/** Makes a request through the object, by its requester, and returns it. */
async function request(overrides: Partial<AdminContentRequest> = {}): Promise<AdminContentRequest> {
  const made = pendingRequest(overrides);
  await harness.inDo(admin => admin.requestContentAccess(made, actor(made.requestedBy)));
  return made;
}

const stored = (id: string) =>
  harness.inDo(admin => harness.storageOf(admin).contentAccessRequests.get(id));

const grantRecords = () =>
  harness.appended.filter((record): record is AdminGrantRecord => record.kind === "grant");

describe("a request", () => {
  it("is recorded, then stored", async () => {
    let atAppend: unknown = "unread";
    const made = pendingRequest();
    await harness.inDo(admin => {
      harness.audit.before = async () => {
        atAppend = harness.storageOf(admin).contentAccessRequests.get(made.id);
      };
      return admin.requestContentAccess(made, actor(ADMIN));
    });

    expect(atAppend).toBeUndefined();
    expect(await stored(made.id)).toStrictEqual(made);
    expect(grantRecords()).toStrictEqual([{
      kind: "grant", method: "requestContentAccess", at: expect.any(Date), admin: ADMIN,
      sessionId: `session of ${ADMIN}`, via: "api", workspaceId: made.workspaceId,
      workspaceOwner: made.workspaceOwner, workspaceTitle: made.workspaceTitle,
      reason: made.reason, requestId: made.id, requestedBy: ADMIN,
    }]);
  });

  it("is not stored when its record cannot be written", async () => {
    harness.audit.fail = true;
    const made = pendingRequest();
    await expect(harness.inDo(admin => admin.requestContentAccess(made, actor(ADMIN))))
        .rejects.toThrow("audit log unavailable");
    expect(await stored(made.id)).toBeUndefined();
  });

  it("is refused while the workspace has one pending, recording nothing", async () => {
    await request();
    const before = harness.appended.length;
    expect(await codeOf(harness.inDo(admin =>
        admin.requestContentAccess(pendingRequest({ requestedBy: OTHER_ADMIN }), actor(OTHER_ADMIN)))))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestPending);
    expect(harness.appended).toHaveLength(before);

    // Another workspace's is taken.
    await request({ workspaceId: "b".repeat(64) });
  });

  it("is refused once MAX_PENDING_CONTENT_REQUESTS are pending", async () => {
    await harness.inDo(admin => {
      for (let i = 0; i < MAX_PENDING_CONTENT_REQUESTS; i++) {
        harness.storageOf(admin).contentAccessRequests.put(
            pendingRequest({ workspaceId: i.toString(16).padStart(64, "0") }));
      }
    });
    expect(await codeOf(harness.inDo(admin =>
        admin.requestContentAccess(pendingRequest(), actor(ADMIN)))))
        .toBe(ADMIN_GRANT_ERROR_CODES.tooManyRequests);
    expect(grantRecords()).toStrictEqual([]);
  });

  it("is refused to a requester no longer an admin in the object's own environment", async () => {
    expect(await codeOf(harness.inDo(admin =>
        admin.requestContentAccess(pendingRequest(), actor(ADMIN)), { ADMINS: [OTHER_ADMIN] })))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(grantRecords()).toStrictEqual([]);
  });
});

describe("the claim of an approval", () => {
  it("leaves pending once, for an admin other than the requester, recording nothing", async () => {
    const made = await request();
    const claimed = await harness.inDo(admin => admin.claimContentAccess(made.id, actor(OTHER_ADMIN)));
    expect(claimed).toStrictEqual({
      ...made, state: "approved", resolvedBy: OTHER_ADMIN, resolvedAt: expect.any(Date),
    });
    expect(await stored(made.id)).toStrictEqual(claimed);
    // The workspace records the approval; the claim gives nothing on its own.
    expect(grantRecords().map(record => record.method)).toStrictEqual(["requestContentAccess"]);

    expect(await codeOf(harness.inDo(admin => admin.claimContentAccess(made.id, actor(OTHER_ADMIN)))))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestNotPending);
  });

  it.each([ADMIN, "Admin@Example.test"])(
      "refuses the requester (%s), leaving the request pending", async requester => {
    const made = await request();
    expect(await codeOf(harness.inDo(admin => admin.claimContentAccess(made.id, actor(requester)),
        { ADMINS: [ADMIN, OTHER_ADMIN, requester] })))
        .toBe(ADMIN_GRANT_ERROR_CODES.secondAdminRequired);
    expect((await stored(made.id))?.state).toBe("pending");
  });

  it("refuses below level content, leaving the request pending", async () => {
    const made = await request();
    expect(await codeOf(harness.inDo(admin => admin.claimContentAccess(made.id, actor(OTHER_ADMIN)),
        { ADMIN_WORKSPACE_ACCESS_MAX: "metadata" })))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
    expect((await stored(made.id))?.state).toBe("pending");
  });

  it("refuses an id that names no request", async () => {
    for (let id of [crypto.randomUUID(), "short", ""]) {
      expect(await codeOf(harness.inDo(admin => admin.claimContentAccess(id, actor(OTHER_ADMIN)))))
          .toBe(ADMIN_GRANT_ERROR_CODES.requestNotFound);
    }
  });
});

describe("settling", () => {
  it("stores the grant the workspace gave, or why it gave none, once", async () => {
    const granted = await request();
    const refused = await request({ workspaceId: "b".repeat(64) });
    for (let made of [granted, refused]) {
      await harness.inDo(admin => admin.claimContentAccess(made.id, actor(OTHER_ADMIN)));
    }

    const grantId = crypto.randomUUID();
    expect(await harness.inDo(admin => admin.settleContentAccess(granted.id, { grantId })))
        .toMatchObject({ state: "approved", grantId });
    expect(await harness.inDo(admin => admin.settleContentAccess(refused.id, { error: "e".repeat(400) })))
        .toMatchObject({ state: "failed", error: `${"e".repeat(255)}…` });

    // A second answer changes nothing.
    expect(await harness.inDo(admin => admin.settleContentAccess(granted.id, { error: "late" })))
        .toMatchObject({ state: "approved", grantId });
  });
});

describe("a denial", () => {
  it("is recorded, then stored, by any admin, the requester included", async () => {
    for (let denier of [OTHER_ADMIN, ADMIN]) {
      const made = await request({ workspaceId: denier === ADMIN ? "c".repeat(64) : "d".repeat(64) });
      await harness.inDo(admin => admin.denyContentAccess(made.id, actor(denier)));
      expect(await stored(made.id)).toMatchObject({ state: "denied", resolvedBy: denier });
      expect(grantRecords().at(-1)).toMatchObject(
          { method: "denyContentAccess", admin: denier, requestId: made.id, requestedBy: ADMIN });
    }
  });

  it("leaves the request pending when its record cannot be written", async () => {
    const made = await request();
    harness.audit.fail = true;
    await expect(harness.inDo(admin => admin.denyContentAccess(made.id, actor(OTHER_ADMIN))))
        .rejects.toThrow("audit log unavailable");
    expect((await stored(made.id))?.state).toBe("pending");
  });

  it("is refused for a request no longer pending", async () => {
    const made = await request();
    await harness.inDo(admin => admin.denyContentAccess(made.id, actor(OTHER_ADMIN)));
    expect(await codeOf(harness.inDo(admin => admin.denyContentAccess(made.id, actor(OTHER_ADMIN)))))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestNotPending);
  });
});

describe("the sweep", () => {
  it("expires a request at its time and one whose requester is no longer an admin, recording nothing",
      async () => {
    const overdue = await request({
      expiresAt: new Date(Date.now() + 1000), workspaceId: "1".repeat(64),
    });
    const demoted = await request({ requestedBy: OTHER_ADMIN, workspaceId: "2".repeat(64) });
    vi.useFakeTimers({ now: Date.now() + 2000, toFake: ["Date"] });

    const listed = await harness.inDo(admin => admin.listContentAccessRequests(),
        { ADMINS: [ADMIN] });
    expect(listed.find(r => r.id === overdue.id))
        .toMatchObject({ state: "expired", resolvedAt: overdue.expiresAt });
    expect(listed.find(r => r.id === overdue.id)).not.toHaveProperty("error");
    expect(listed.find(r => r.id === demoted.id)).toMatchObject(
        { state: "expired", error: "Its requester is no longer a deployment admin." });
    expect(grantRecords().map(record => record.method))
        .toStrictEqual(["requestContentAccess", "requestContentAccess"]);
  });

  it("fails an approval whose workspace never answered, and forgets a request a day after it ended",
      async () => {
    const lost = await request({ workspaceId: "1".repeat(64) });
    const denied = await request({ workspaceId: "2".repeat(64) });
    await harness.inDo(async admin => {
      await admin.claimContentAccess(lost.id, actor(OTHER_ADMIN));
      await admin.denyContentAccess(denied.id, actor(OTHER_ADMIN));
    });

    vi.useFakeTimers({ now: Date.now() + 16 * MINUTE_MS, toFake: ["Date"] });
    expect(await harness.inDo(admin => admin.getContentAccessRequest(lost.id))).toMatchObject({
      state: "failed",
      error: "The workspace's answer never arrived, so whether it gave the grant is unknown.",
    });

    // A grant the workspace confirms after all replaces the lost answer; a refusal does not.
    expect(await harness.inDo(admin => admin.settleContentAccess(lost.id, { error: "late" })))
        .toMatchObject({ state: "failed" });
    const confirmed = await harness.inDo(admin => admin.settleContentAccess(lost.id, { grantId: "grant-9" }));
    expect(confirmed).toMatchObject({ state: "approved", grantId: "grant-9" });
    expect(confirmed).not.toHaveProperty("error");
    expect(await harness.inDo(admin => admin.settleContentAccess(lost.id, { grantId: "grant-10" })))
        .toMatchObject({ grantId: "grant-9" });

    vi.useFakeTimers({ now: Date.now() + DAY_MS, toFake: ["Date"] });
    expect(await harness.inDo(admin => admin.listContentAccessRequests())).toStrictEqual([]);
    expect(await codeOf(harness.inDo(admin => admin.getContentAccessRequest(denied.id))))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestNotFound);
  });
});

describe("the listing", () => {
  it("lists the pending first, soonest to expire first, then the rest, latest resolved first",
      async () => {
    const now = Date.now();
    const later = await request({ workspaceId: "1".repeat(64), expiresAt: new Date(now + 2 * DAY_MS / 3) });
    const sooner = await request({ workspaceId: "2".repeat(64), expiresAt: new Date(now + DAY_MS / 3) });
    const deniedFirst = await request({ workspaceId: "3".repeat(64) });
    const deniedLast = await request({ workspaceId: "4".repeat(64) });
    await harness.inDo(async (admin: AdminSettings) => {
      await admin.denyContentAccess(deniedFirst.id, actor(OTHER_ADMIN));
      await new Promise(resolve => setTimeout(resolve, 5));
      await admin.denyContentAccess(deniedLast.id, actor(OTHER_ADMIN));
    });
    expect((await harness.inDo(admin => admin.listContentAccessRequests())).map(r => r.id))
        .toStrictEqual([sooner.id, later.id, deniedLast.id, deniedFirst.id]);

    // Filtered to the pending, to some ids, or to both, in the same order.
    const ids = (query: AdminContentRequestQuery) =>
      harness.inDo(async admin => (await admin.listContentAccessRequests(query)).map(r => r.id));
    expect(await ids({ pending: true })).toStrictEqual([sooner.id, later.id]);
    expect(await ids({ ids: [deniedFirst.id, later.id, "no-such-request"] }))
        .toStrictEqual([later.id, deniedFirst.id]);
    expect(await ids({ pending: true, ids: [deniedFirst.id, later.id] })).toStrictEqual([later.id]);
    expect(await ids({ ids: [] })).toStrictEqual([]);
  });

  it("sweeps only the requests a lookup by id reads", async () => {
    const overdue = pendingRequest({ workspaceId: "5".repeat(64), expiresAt: new Date(Date.now() - 1) });
    const elsewhere = pendingRequest({ workspaceId: "6".repeat(64), expiresAt: new Date(Date.now() - 1) });
    await harness.inDo(admin => {
      harness.storageOf(admin).contentAccessRequests.put(overdue);
      harness.storageOf(admin).contentAccessRequests.put(elsewhere);
    });
    const listed = await harness.inDo(admin => admin.listContentAccessRequests({ ids: [overdue.id] }));
    expect(listed.map(r => [r.id, r.state])).toStrictEqual([[overdue.id, "expired"]]);
    expect((await harness.inDo(admin => admin.getContentAccessRequest(overdue.id))).state).toBe("expired");
    // The request no lookup read is as it was stored until a method reads it.
    expect(await harness.inDo(admin => harness.storageOf(admin).contentAccessRequests.get(elsewhere.id)?.state))
        .toBe("pending");
    expect(await harness.inDo(admin => admin.listContentAccessRequests({ pending: true }))).toStrictEqual([]);
  });
});
