// The bound on how long the admin audit log keeps a record, and the text a record keeps.
//
// This is the one place the bound is decided, and the one place audit text is bounded. The bound
// comes from the environment, beside ADMINS, so that a compromised admin session cannot change it:
// admins choose a retention within it (in AdminConfig), and adminAccessPolicy() holds that choice
// inside it wherever it is enforced. This is the reason authentication config stays in
// auth/config.ts rather than in AdminConfig.

import {
  ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT, DEFAULT_ADMIN_AUDIT_RETENTION_DAYS,
  MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_STATS_DAYS,
  MAX_ADMIN_AUDIT_VALUE_LENGTH,
  type AdminSettingChange, type AdminSettingRecord,
} from "@gadgets/workshop-shared/api";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.admin.access");

// --- The environment's bound ---

// The raw values already reported as invalid, so that each is logged once per isolate rather than
// on every request that reads it.
const reportedInvalidRetentionMin = new Set<unknown>();

function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || String(raw).trim() === "";
}

/** The fewest days ADMIN_AUDIT_RETENTION_MIN_DAYS lets admins keep audit records for: a positive
 * whole number (string or number), MAX_ADMIN_AUDIT_RETENTION_DAYS when larger;
 * DEFAULT_ADMIN_AUDIT_RETENTION_DAYS while it is unset or blank, and when it is anything else
 * (logged as an error once per isolate per value). */
export function minAdminAuditRetentionDays(env: Cloudflare.Env): number {
  let raw: unknown = env.ADMIN_AUDIT_RETENTION_MIN_DAYS;
  if (isBlank(raw)) return DEFAULT_ADMIN_AUDIT_RETENTION_DAYS;
  let days = Number(String(raw).trim());
  if (Number.isSafeInteger(days) && days >= 1) {
    return Math.min(days, MAX_ADMIN_AUDIT_RETENTION_DAYS);
  }

  if (!reportedInvalidRetentionMin.has(raw)) {
    reportedInvalidRetentionMin.add(raw);
    logger.error(
        "ADMIN_AUDIT_RETENTION_MIN_DAYS is not a positive whole number of days, so the default " +
            "minimum retention applies",
        { event: "admin.access.config.invalid" });
  }
  return DEFAULT_ADMIN_AUDIT_RETENTION_DAYS;
}

/** What the deployment enforces now: the admins' choices held within the environment's bound. */
export type AdminAccessPolicy = {
  /** How many days the audit log keeps a record: the chosen retention, at least
   * minAdminAuditRetentionDays(). */
  retentionDays: number;
};

/** The policy `config` and the environment give. Every enforcement point computes it from a config
 * it has just read; none holds one from earlier. */
export function adminAccessPolicy(
    config: Pick<AdminConfig, "adminAuditRetentionDays">, env: Cloudflare.Env): AdminAccessPolicy {
  return {
    retentionDays: Math.max(config.adminAuditRetentionDays, minAdminAuditRetentionDays(env)),
  };
}

// --- Who acts ---

/** Who changes a setting, and through which AdminApi method: what an AdminSettingRecord records of
 * the call besides its time and changes. AdminApiImpl passes one with every AdminSettings
 * mutation. */
export type AdminSettingActor = Pick<AdminSettingRecord, "admin" | "sessionId" | "via" | "method">;

// --- Validation ---

function isWholeNumberIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** The page size `limit` asks for; throws unless absent (ADMIN_LIST_DEFAULT_LIMIT) or a whole
 * number from 1 to ADMIN_LIST_MAX_LIMIT. */
export function adminListLimit(limit: number | undefined): number {
  if (limit === undefined) return ADMIN_LIST_DEFAULT_LIMIT;
  if (!isWholeNumberIn(limit, 1, ADMIN_LIST_MAX_LIMIT)) {
    throw new TypeError(`The page size must be a whole number from 1 to ${ADMIN_LIST_MAX_LIMIT}.`);
  }
  return limit;
}

/** The statistics window `days` asks for; throws unless absent (7) or a whole number from 1 to
 * MAX_ADMIN_AUDIT_STATS_DAYS. */
export function adminAuditStatsDays(days: number | undefined): number {
  if (days === undefined) return 7;
  if (!isWholeNumberIn(days, 1, MAX_ADMIN_AUDIT_STATS_DAYS)) {
    throw new TypeError(
        `The statistics window must be a whole number of days from 1 to ` +
            `${MAX_ADMIN_AUDIT_STATS_DAYS}.`);
  }
  return days;
}

// --- Audit text ---

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `text` as an audit record keeps it: whole while at most `maxLength` characters, else its first
 * `maxLength` - 1 characters and "…" (one fewer when the cut would split a surrogate pair). The one
 * cut the audit log applies, marked so that a record never passes a fragment off as the whole: to
 * setting keys. */
export function cutAdminAuditText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength - 1;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

// Canonical JSON: object keys sorted at every level, written out as text. Building a sorted copy
// by assignment instead would turn a "__proto__" key into a prototype change and drop it.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    let entries: string[] = [];
    for (let key of Object.keys(value).toSorted()) {
      let item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A value as an AdminSettingChange records it: a string as itself, anything else as JSON with
 * object keys sorted at every level; undefined for undefined. Reads own properties only and writes
 * the JSON text directly, so a "__proto__" or "constructor" key stays an ordinary entry. Never
 * cut: adminSettingChange() bounds it. */
export function adminAuditValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return canonicalJson(value);
}

/** How many characters before the first difference an AdminSettingChange excerpt starts. */
export const ADMIN_AUDIT_EXCERPT_CONTEXT = 100;

// At most MAX_ADMIN_AUDIT_VALUE_LENGTH characters of `value` from `offset`, without a trailing lone
// high surrogate.
function excerptOf(value: string, offset: number): string {
  let excerpt = value.slice(offset, offset + MAX_ADMIN_AUDIT_VALUE_LENGTH);
  if (excerpt.length > 0 && isHighSurrogate(excerpt.charCodeAt(excerpt.length - 1))) {
    excerpt = excerpt.slice(0, -1);
  }
  return excerpt;
}

/** The change from `before` to `after` (undefined for absent) of one setting or one entry of it,
 * or undefined when adminAuditValue() gives both the same. `key`, when given, is kept cut by
 * cutAdminAuditText() to MAX_ADMIN_AUDIT_ARG_LENGTH. Both values are kept whole while each is at
 * most MAX_ADMIN_AUDIT_VALUE_LENGTH characters; otherwise both become excerpts starting
 * ADMIN_AUDIT_EXCERPT_CONTEXT characters before the first character at which they differ (never
 * splitting a surrogate pair), with `excerpt` giving that offset and the whole lengths. */
export function adminSettingChange(setting: string, key: string | undefined, before: unknown,
    after: unknown): AdminSettingChange | undefined {
  let b = adminAuditValue(before);
  let a = adminAuditValue(after);
  if (b === a) return undefined;

  let change: AdminSettingChange = { setting };
  // No real entry's id is this long, but setResourceEnabled() takes an unvalidated vendor id,
  // which becomes a disabledResources key.
  if (key !== undefined) change.key = cutAdminAuditText(key, MAX_ADMIN_AUDIT_ARG_LENGTH);

  if ((b?.length ?? 0) <= MAX_ADMIN_AUDIT_VALUE_LENGTH &&
      (a?.length ?? 0) <= MAX_ADMIN_AUDIT_VALUE_LENGTH) {
    if (b !== undefined) change.before = b;
    if (a !== undefined) change.after = a;
    return change;
  }

  let x = b ?? "";
  let y = a ?? "";
  let common = 0;
  let shorter = Math.min(x.length, y.length);
  while (common < shorter && x.charCodeAt(common) === y.charCodeAt(common)) common++;
  let offset = Math.max(0, common - ADMIN_AUDIT_EXCERPT_CONTEXT);
  // The two values agree before `common`, so a pair split here is split in both.
  let probe = x.length > offset ? x : y;
  if (offset > 0 && isLowSurrogate(probe.charCodeAt(offset)) &&
      isHighSurrogate(probe.charCodeAt(offset - 1))) {
    offset--;
  }

  change.excerpt = { offset };
  if (b !== undefined) {
    change.before = excerptOf(b, offset);
    change.excerpt.beforeLength = b.length;
  }
  if (a !== undefined) {
    change.after = excerptOf(a, offset);
    change.excerpt.afterLength = a.length;
  }
  return change;
}
