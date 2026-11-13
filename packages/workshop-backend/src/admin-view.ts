// What the admin views share: the check of the terms a view is minted on, and the one way a view's
// call is checked, run and recorded, so that no view re-implements any of it.
//
// Not in admin-access.ts, which admin-config.ts imports: a call reads the deployment's setting with
// admin-config.ts's readAdminConfig().

import {
  ADMIN_ACCESS_ERROR_CODES, MAX_ADMIN_VIEW_LIFETIME_SECONDS, createAdminAccessError,
  type AdminAccessRecord, type AdminUserAccessRecord,
} from "@gadgets/workshop-shared/api";
import {
  adminAccessPolicy, validateAdminAccessReason, type AdminViewTerms,
} from "./admin-access.js";
import { readAdminConfig } from "./admin-config.js";
import type { AdminAuditDurableObject } from "./admin-audit.js";
import type { WorkshopLogger } from "./observability.js";

/** `reason`, trimmed, for a view to be minted on `terms`; throws TypeError for a malformed open
 * (the checks OverseerDurableObject.openForAdmin() documents). An expiry already past is not
 * malformed. */
export function assertAdminViewTerms(reason: string, terms: AdminViewTerms): string {
  let trimmedReason = validateAdminAccessReason(reason);
  if (terms.via !== "api" && terms.via !== "cli") {
    throw new TypeError("An admin view's via must be \"api\" or \"cli\".");
  }
  let expiresAt = terms.expiresAt instanceof Date ? terms.expiresAt.getTime() : NaN;
  if (Number.isNaN(expiresAt) ||
      expiresAt > Date.now() + (MAX_ADMIN_VIEW_LIFETIME_SECONDS + 60) * 1000) {
    throw new TypeError(
        "An admin view's expiry must be a valid time within its longest lifetime.");
  }
  return trimmedReason;
}

/** What adminViewCall() needs of the view whose call it runs. */
export type AdminViewCallHost = {
  /** The environment the call reads the deployment's setting and the environment's bounds from. A
   * function, so that each use reads the environment of the object that holds the view as it then
   * is. */
  readonly env: () => Cloudflare.Env;
  /** The deployment-wide audit log's namespace. */
  readonly audits: DurableObjectNamespace<AdminAuditDurableObject>;
  /** Where a record that could not be appended is reported. */
  readonly logger: WorkshopLogger;
  /** Throws the refusal that stops a call unrecorded: assertAdminViewLive(), then the view's own
   * once what it reads no longer exists. */
  assertLive(): void;
  /** Builds the call's record, as refused when `refused` names why. Synchronous: adminViewCall()
   * builds and sends a record with nothing awaited since its last check. */
  recordOf(refused?: AdminAccessRecord["refused"]): AdminAccessRecord | AdminUserAccessRecord;
};

/**
 * Runs one call of an admin view, of a workspace or of a user's account, so that every view records
 * the same way. Checks the view, reads the deployment's setting and checks again. While the
 * setting is "off" the call is recorded and refused, having read nothing. Any other call reads its
 * answer with `read`, is checked once more, and is recorded. Only then is it answered, so nothing
 * it read leaves the server unrecorded. A read that fails is recorded as an attempt, and the call
 * fails with the read's error. Each record is view.recordOf()'s, appended to
 * view.audits.getByName("") with no retention (the policy comes from the KV mirror, and a stale one
 * must not prune); an append that fails is logged through view.logger (warn, event
 * "admin.audit.append.failed", operation: the record's method, error) and rethrown, so the call
 * returns nothing.
 */
export async function adminViewCall<T>(view: AdminViewCallHost, read: () => T | Promise<T>)
    : Promise<T> {
  view.assertLive();
  let config = await readAdminConfig(view.env());
  // Checked again, with nothing awaited from here to a refusal's record: the read may have
  // spanned the expiry, a demotion or the deletion of what the view reads, and what was deleted
  // must stay empty, with nothing appended for it deployment-wide either.
  view.assertLive();

  if (adminAccessPolicy(config, view.env()).access === "off") {
    await append(view, ADMIN_ACCESS_ERROR_CODES.accessOff);
    throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessOff);
  }

  let answer: T;
  try {
    answer = await read();
  } catch (err) {
    view.assertLive();
    await append(view);
    throw err;
  }
  // Checked again, with nothing awaited before the record, for the same reasons: the read may
  // have awaited.
  view.assertLive();
  await append(view);
  return answer;
}

// Records one call in the deployment-wide log, as refused when `refused` names why. The record
// is built and sent before the first await, so that the caller's last check still holds.
async function append(view: AdminViewCallHost, refused?: AdminAccessRecord["refused"])
    : Promise<void> {
  let record = view.recordOf(refused);
  try {
    // No retention: the policy comes from the KV mirror, and a stale one must not prune.
    await view.audits.getByName("").append(record);
  } catch (err) {
    // The record holds the reason and the arguments, so only its method is logged.
    view.logger.warn("failed to append to the admin audit log", {
      event: "admin.audit.append.failed", operation: record.method, error: err,
    });
    throw err;
  }
}
