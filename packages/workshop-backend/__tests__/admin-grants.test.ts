// The pure parts of grants for admin content reads (admin-grants.ts): when a grant is live, what
// counts as a live account-wide grant, what a fresh grant holds, and when an ended one may be
// deleted.

import { describe, expect, it } from "vitest";
import {
  ADMIN_GRANT_LIFETIME_SECONDS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAccessGrant, type AiChatAuthorInfo,
} from "@gadgets/workshop-shared/api";
import {
  isAdminGrantLive, isAdminGrantPrunable, isLiveAccountGrant, newAdminGrant,
  newestAdminGrantFirst,
} from "../src/admin-grants.js";

const NOW = Date.UTC(2030, 0, 15, 12);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION = 90;
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };

// A grant given an hour before NOW and ending an hour after it, with `overrides`.
function grantOf(overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  return {
    id: "grant-id", level: "content", source: "owner", scope: "workspace",
    grantedBy: { id: OWNER.id, name: OWNER.name },
    grantedAt: new Date(NOW - HOUR_MS), expiresAt: new Date(NOW + HOUR_MS),
    ...overrides,
  };
}

describe("isAdminGrantLive", () => {
  it("is live until its end, and not at it", () => {
    let grant = grantOf();
    expect(isAdminGrantLive(grant, grant.expiresAt.getTime() - 1)).toBe(true);
    expect(isAdminGrantLive(grant, grant.expiresAt.getTime())).toBe(false);
    expect(isAdminGrantLive(grant, grant.expiresAt.getTime() + 1)).toBe(false);
  });

  it("reads the clock when it is given no time", () => {
    expect(isAdminGrantLive(grantOf({ expiresAt: new Date(Date.now() + HOUR_MS) }))).toBe(true);
    expect(isAdminGrantLive(grantOf({ expiresAt: new Date(Date.now() - 1) }))).toBe(false);
  });

  it("is not live once revoked, whenever the revocation is dated", () => {
    expect(isAdminGrantLive(grantOf({ revokedAt: new Date(NOW - 1) }), NOW)).toBe(false);
    expect(isAdminGrantLive(grantOf({ revokedAt: new Date(NOW + HOUR_MS) }), NOW)).toBe(false);
    expect(isAdminGrantLive(grantOf({ revokedAt: new Date(NaN) }), NOW)).toBe(false);
  });

  it("is not live with an end that is not a valid time", () => {
    expect(isAdminGrantLive(grantOf({ expiresAt: new Date(NaN) }), NOW)).toBe(false);
    for (let end of [undefined, null, "2999-01-01T00:00:00.000Z", NOW + HOUR_MS]) {
      expect(isAdminGrantLive(grantOf({ expiresAt: end as never }), NOW)).toBe(false);
    }
  });

  it("is not live at a level this server reads no content under", () => {
    expect(isAdminGrantLive(grantOf({ level: "other" as never }), NOW)).toBe(false);
    expect(isAdminGrantLive(grantOf({ level: undefined as never }), NOW)).toBe(false);
  });
});

describe("isLiveAccountGrant", () => {
  it("is true for a live account-wide grant of the owner's", () => {
    expect(isLiveAccountGrant(grantOf({ scope: "account" }), NOW)).toBe(true);
  });

  it("is false for no answer", () => {
    expect(isLiveAccountGrant(null, NOW)).toBe(false);
    expect(isLiveAccountGrant(undefined, NOW)).toBe(false);
    expect(isLiveAccountGrant("grant" as never, NOW)).toBe(false);
  });

  it("is false for a grant on one workspace", () => {
    expect(isLiveAccountGrant(grantOf({ scope: "workspace" }), NOW)).toBe(false);
  });

  it("is false for a grant an approval gave", () => {
    expect(isLiveAccountGrant(grantOf({ scope: "account", source: "admins" }), NOW)).toBe(false);
  });

  it("is false for an ended grant", () => {
    let expired = grantOf({ scope: "account", expiresAt: new Date(NOW) });
    let revoked = grantOf({ scope: "account", revokedAt: new Date(NOW - 1) });
    expect(isLiveAccountGrant(expired, NOW)).toBe(false);
    expect(isLiveAccountGrant(revoked, NOW)).toBe(false);
  });
});

describe("newAdminGrant", () => {
  it("gives a live grant lasting the lifetime, with an id of its own", () => {
    let before = Date.now();
    let grant = newAdminGrant({ source: "owner", scope: "workspace", grantedBy: OWNER });
    let after = Date.now();

    expect(grant).toStrictEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      level: "content", source: "owner", scope: "workspace",
      grantedBy: { id: OWNER.id, name: OWNER.name },
      grantedAt: expect.any(Date), expiresAt: expect.any(Date),
    });
    expect(grant.grantedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(grant.grantedAt.getTime()).toBeLessThanOrEqual(after);
    expect(grant.expiresAt.getTime() - grant.grantedAt.getTime())
        .toBe(ADMIN_GRANT_LIFETIME_SECONDS * 1000);
    expect(ADMIN_GRANT_LIFETIME_SECONDS).toBe(72 * 60 * 60);
    expect(isAdminGrantLive(grant)).toBe(true);

    let other = newAdminGrant({ source: "owner", scope: "workspace", grantedBy: OWNER });
    expect(other.id).not.toBe(grant.id);
  });

  it("keeps the fields an approval's grant carries", () => {
    let grant = newAdminGrant({
      source: "admins", scope: "workspace", grantedBy: OWNER,
      requestedBy: "requester@example.test", requestId: "request-1", reason: "Asked to look",
    });
    expect(grant).toMatchObject({
      source: "admins", requestedBy: "requester@example.test", requestId: "request-1",
      reason: "Asked to look",
    });
  });

  it("keeps an id and a bounded name of its giver, and nothing else of a profile", () => {
    let profile = {
      ...OWNER, name: "n".repeat(1_000_000), commitEmail: "owner@example.test",
      description: "d".repeat(1000),
    };
    let grant = newAdminGrant({ source: "owner", scope: "workspace", grantedBy: profile });

    expect(Object.keys(grant.grantedBy).toSorted()).toStrictEqual(["id", "name"]);
    expect(grant.grantedBy.id).toBe(OWNER.id);
    expect(grant.grantedBy.name).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(grant.grantedBy.name.endsWith("…")).toBe(true);
    expect(JSON.stringify(grant).length).toBeLessThan(1024);
  });

  it("drops what a grant does not hold", () => {
    let fields = {
      source: "owner", scope: "workspace", grantedBy: OWNER,
      requestId: undefined, level: "other", revokedAt: new Date(0), extra: "x",
    } as const;
    let grant = newAdminGrant(fields);
    expect(Object.keys(grant).toSorted()).toStrictEqual(
        ["expiresAt", "grantedAt", "grantedBy", "id", "level", "scope", "source"]);
    expect(grant.level).toBe("content");
  });
});

describe("isAdminGrantPrunable", () => {
  it("is never true of a live grant", () => {
    expect(isAdminGrantPrunable(grantOf(), RETENTION, NOW)).toBe(false);
    expect(isAdminGrantPrunable(grantOf(), 0, NOW)).toBe(false);
    // Given long ago and renewed since: its age does not count.
    let old = grantOf({ grantedAt: new Date(NOW - 1000 * DAY_MS) });
    expect(isAdminGrantPrunable(old, RETENTION, NOW)).toBe(false);
  });

  it("is true once an expired grant ended longer ago than the retention", () => {
    let ended = NOW - RETENTION * DAY_MS;
    expect(isAdminGrantPrunable(grantOf({ expiresAt: new Date(ended) }), RETENTION, NOW))
        .toBe(false);
    expect(isAdminGrantPrunable(grantOf({ expiresAt: new Date(ended - 1) }), RETENTION, NOW))
        .toBe(true);
    expect(isAdminGrantPrunable(grantOf({ expiresAt: new Date(NOW - 1) }), RETENTION, NOW))
        .toBe(false);
  });

  it("counts a revoked grant from its revocation", () => {
    let ended = NOW - RETENTION * DAY_MS;
    // Revoked long ago, though its end is still ahead.
    let longRevoked = grantOf({ revokedAt: new Date(ended - 1) });
    expect(isAdminGrantPrunable(longRevoked, RETENTION, NOW)).toBe(true);
    expect(isAdminGrantPrunable(grantOf({ revokedAt: new Date(ended) }), RETENTION, NOW))
        .toBe(false);
    // Revoked a moment ago, though it would have expired long ago.
    let justRevoked = grantOf({ expiresAt: new Date(ended - DAY_MS), revokedAt: new Date(NOW - 1) });
    expect(isAdminGrantPrunable(justRevoked, RETENTION, NOW)).toBe(false);
  });

  it("is true of a record whose end is not a valid time", () => {
    expect(isAdminGrantPrunable(grantOf({ expiresAt: new Date(NaN) }), RETENTION, NOW)).toBe(true);
    expect(isAdminGrantPrunable(grantOf({ expiresAt: undefined as never }), RETENTION, NOW))
        .toBe(true);
    expect(isAdminGrantPrunable(grantOf({ revokedAt: new Date(NaN) }), RETENTION, NOW)).toBe(true);
  });
});

describe("newestAdminGrantFirst", () => {
  it("sorts by when each grant was given, newest first", () => {
    let grants = [3, 1, 2].map(
        hours => grantOf({ id: `grant-${hours}`, grantedAt: new Date(NOW - hours * HOUR_MS) }));
    expect(grants.toSorted(newestAdminGrantFirst).map(grant => grant.id))
        .toStrictEqual(["grant-1", "grant-2", "grant-3"]);
  });
});
