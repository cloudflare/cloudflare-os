// The pure parts of grants for admin content reads: what is computed from its arguments alone,
// with no storage read and no call made.
//
// A grant is stored as the API returns it (AdminAccessGrant): there is no server-only field.

import {
  ADMIN_GRANT_LIFETIME_SECONDS,
  type AdminAccessGrant, type AiChatAuthorInfo,
} from "@gadgets/workshop-shared/api";
import { namedUser } from "./admin-access.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `grant` lets content be read at `now`: its level is "content", it carries no
 * `revokedAt`, and `now` is before `expiresAt`. It fails closed: a record whose end is not a
 * valid time (NaN compares false), or whose level is not one this server reads content under, is
 * not live. The one liveness test: every path that asks whether a grant still lets content be
 * read decides through it.
 */
export function isAdminGrantLive(
    grant: Pick<AdminAccessGrant, "level" | "expiresAt" | "revokedAt">,
    now: number = Date.now()): boolean {
  return grant.level === "content" && grant.revokedAt === undefined &&
      grant.expiresAt instanceof Date && now < grant.expiresAt.getTime();
}

/**
 * Whether `answer`, what an owner's account said when a workspace asked, is a live account-wide
 * grant: isAdminGrantLive(), with scope "account" and source "owner". Anything else an account
 * answers (null, a grant of another scope or source, an ended one) is no grant.
 */
export function isLiveAccountGrant(answer: AdminAccessGrant | null | undefined,
    now: number = Date.now()): answer is AdminAccessGrant {
  return typeof answer === "object" && answer !== null && answer.scope === "account" &&
      answer.source === "owner" && isAdminGrantLive(answer, now);
}

/** A fresh grant: a random id (`id` when its caller has recorded one for it), level "content",
 * given now, ending ADMIN_GRANT_LIFETIME_SECONDS from now. `grantedBy` is kept as namedUser()
 * gives it, so that no caller stores a profile. */
export function newAdminGrant(
    fields: Pick<AdminAccessGrant,
        "source" | "scope" | "requestedBy" | "requestId" | "reason" | "reportId"> &
        { id?: string; grantedBy: Pick<AiChatAuthorInfo, "id" | "name"> }): AdminAccessGrant {
  let { source, scope, requestedBy, requestId, reason, reportId } = fields;
  let now = Date.now();
  return {
    id: fields.id ?? crypto.randomUUID(),
    level: "content",
    source,
    scope,
    grantedBy: namedUser(fields.grantedBy),
    ...requestedBy !== undefined && { requestedBy },
    ...requestId !== undefined && { requestId },
    ...reason !== undefined && { reason },
    ...reportId !== undefined && { reportId },
    grantedAt: new Date(now),
    expiresAt: new Date(now + ADMIN_GRANT_LIFETIME_SECONDS * 1000),
  };
}

/** Orders grants newest first, by when each was given: a comparator for sorting. */
export function newestAdminGrantFirst(a: AdminAccessGrant, b: AdminAccessGrant): number {
  return b.grantedAt.getTime() - a.grantedAt.getTime();
}

/** Whether an ended grant has been kept long enough to delete: it is not live, and it ended
 * (`revokedAt`, else `expiresAt`) more than `retentionDays` days before `now`. A record whose
 * end is not a valid time is deletable. */
export function isAdminGrantPrunable(grant: AdminAccessGrant, retentionDays: number,
    now: number = Date.now()): boolean {
  if (isAdminGrantLive(grant, now)) return false;
  let end = grant.revokedAt ?? grant.expiresAt;
  let endedAt = end instanceof Date ? end.getTime() : NaN;
  // NaN compares false, so an end that is not a valid time is past any retention.
  return !(now - endedAt <= retentionDays * DAY_MS);
}
