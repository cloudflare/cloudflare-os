// Deployment admin status, the bounds on admin access to workspaces, and the text an audit record
// keeps.
//
// This is the one place the admin access bounds are decided, and the one place audit text is
// bounded (admin status is isDeploymentAdmin() in auth/config.ts). The bounds come from the environment, beside ADMINS, so that a compromised
// admin session can change neither: admins choose an access level and a retention within them (in
// AdminConfig), and adminAccessPolicy() holds that choice inside them wherever it is enforced. This
// is the reason authentication config stays in auth/config.ts rather than in AdminConfig.

import { createHash } from "node:crypto";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT,
  ADMIN_WORKSPACE_ACCESS_LEVELS, DEFAULT_ADMIN_AUDIT_RETENTION_DAYS,
  DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS, MAX_ADMIN_ACCESS_REASON_LENGTH, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ADMIN_AUDIT_RETENTION_DAYS, MAX_ADMIN_AUDIT_STATS_DAYS, MAX_ADMIN_AUDIT_VALUE_LENGTH,
  MAX_ADMIN_VIEW_LIFETIME_SECONDS, createAdminAccessError, isAdminWorkspaceAccess,
  type ActionLogEntry, type AdminAccessRecord, type AdminChatState, type AdminSettingChange,
  type AdminSettingRecord, type AdminViewAccess, type AdminVia, type AdminWorkspaceAccess,
  type AdminWorkspaceMethod, type AiChatHistoryPage, type AiChatMetadata, type BoundHookInfo,
  type FileAtCommit, type WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import { isDeploymentAdmin } from "./auth/config.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.admin.access");

// --- The environment's bounds ---

// The raw values already reported as invalid, so that each is logged once per isolate rather than
// on every request that reads it.
const reportedInvalidAccessMax = new Set<unknown>();
const reportedInvalidRetentionMin = new Set<unknown>();

function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || String(raw).trim() === "";
}

/** The most access ADMIN_WORKSPACE_ACCESS_MAX lets admins choose: "off", "metadata" or "full", in
 * any case and trimmed; "metadata" while it is unset or blank. Any other value misconfigures a
 * security bound, so it fails closed to "off" and is logged as an error (once per isolate per
 * value, never the value itself). */
export function maxAdminWorkspaceAccess(env: Cloudflare.Env): AdminWorkspaceAccess {
  let raw: unknown = env.ADMIN_WORKSPACE_ACCESS_MAX;
  if (isBlank(raw)) return "metadata";
  let level = String(raw).trim().toLowerCase();
  if (isAdminWorkspaceAccess(level)) return level;

  // This bounds a security setting, so a value meant to turn inspection off ("none", "false", a
  // typo of "off") must fail closed, never grant the default.
  if (!reportedInvalidAccessMax.has(raw)) {
    reportedInvalidAccessMax.add(raw);
    logger.error(
        "ADMIN_WORKSPACE_ACCESS_MAX is not off, metadata or full, so admin access to workspaces " +
            "is off",
        { event: "admin.access.config.invalid" });
  }
  return "off";
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

/** The lower of two access levels (ADMIN_WORKSPACE_ACCESS_LEVELS lists them in order). */
export function lowerAdminWorkspaceAccess<L extends AdminWorkspaceAccess>(a: L, b: L): L {
  let order = ADMIN_WORKSPACE_ACCESS_LEVELS;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/** What the deployment enforces now: the admins' choices held within the environment's bounds. */
export type AdminAccessPolicy = {
  /** The level views get: the chosen level, at most maxAdminWorkspaceAccess(). */
  access: AdminWorkspaceAccess;
  /** How many days the audit log keeps a record: the chosen retention, at least
   * minAdminAuditRetentionDays(). */
  retentionDays: number;
};

/** The policy `config` and the environment give. Every enforcement point computes it from a config
 * it has just read; none holds one from earlier. */
export function adminAccessPolicy(
    config: Pick<AdminConfig, "adminWorkspaceAccess" | "adminAuditRetentionDays">,
    env: Cloudflare.Env): AdminAccessPolicy {
  return {
    access: lowerAdminWorkspaceAccess(config.adminWorkspaceAccess, maxAdminWorkspaceAccess(env)),
    retentionDays: Math.max(config.adminAuditRetentionDays, minAdminAuditRetentionDays(env)),
  };
}

// --- Who acts, and on what terms ---

/** Who changes a setting, and through which AdminApi method: what an AdminSettingRecord records of
 * the call besides its time and changes. AdminApiImpl passes one with every AdminSettings
 * mutation. */
export type AdminSettingActor = Pick<AdminSettingRecord, "admin" | "sessionId" | "via" | "method">;

/** What an AdminWorkspaceView is minted with (see OverseerDurableObject.openForAdmin()), fixed for
 * the view's life. */
export type AdminViewTerms = {
  /** Recorded on every record the view makes (see AdminVia). */
  via: AdminVia;
  /** The level the open asked for (AdminInspectOptions.access), recorded on every record the view
   * makes (AdminAccessRecord.requested). */
  requested: AdminViewAccess;
  /** The view's level when minted: the lower of `requested` and the deployment's policy then. Each
   * call runs at this level or lower (see adminViewCallAccess()). */
  access: AdminViewAccess;
  /** When the view stops working. */
  expiresAt: Date;
};

/** The view methods that read only content, refused below "full". */
export const ADMIN_CONTENT_METHODS: ReadonlySet<AdminWorkspaceMethod> =
    new Set<AdminWorkspaceMethod>(["getChat", "readChatAttachment", "readFile"]);

// --- Validation ---

function isWholeNumberIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** `reason`, trimmed; throws unless it is non-blank and at most MAX_ADMIN_ACCESS_REASON_LENGTH. */
export function validateAdminAccessReason(reason: string): string {
  let trimmed = reason.trim();
  if (!trimmed || trimmed.length > MAX_ADMIN_ACCESS_REASON_LENGTH) {
    throw new TypeError(
        `A reason is required, and must be at most ${MAX_ADMIN_ACCESS_REASON_LENGTH} characters.`);
  }
  return trimmed;
}

/** The lifetime `lifetimeSeconds` asks for, in ms; throws unless absent
 * (DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS) or a whole number from 1 to MAX_ADMIN_VIEW_LIFETIME_SECONDS. */
export function adminViewLifetimeMs(lifetimeSeconds: number | undefined): number {
  if (lifetimeSeconds === undefined) return DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS * 1000;
  if (!isWholeNumberIn(lifetimeSeconds, 1, MAX_ADMIN_VIEW_LIFETIME_SECONDS)) {
    throw new TypeError(
        `The view's lifetime must be a whole number of seconds from 1 to ` +
            `${MAX_ADMIN_VIEW_LIFETIME_SECONDS}.`);
  }
  return lifetimeSeconds * 1000;
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

// --- View calls ---

/** Throws the refusal that stops a view call before anything is recorded: `viewExpired` at or after
 * `terms.expiresAt`, then `notAdmin` once `adminId` is no longer a deployment admin. */
export function assertAdminViewLive(terms: AdminViewTerms, adminId: string, env: Cloudflare.Env,
    now: number = Date.now()): void {
  if (now >= terms.expiresAt.getTime()) {
    throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired);
  }
  if (!isDeploymentAdmin(env, adminId)) {
    throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin);
  }
}

/** The level one view call runs at (the view's own lowered to `policy.access`) and the refusal that
 * level makes, if any: accessOff at "off", contentWithheld for one of ADMIN_CONTENT_METHODS at
 * "metadata". Never throws: the caller records a refused call before refusing it. */
export function adminViewCallAccess(terms: AdminViewTerms, method: AdminWorkspaceMethod,
    policy: AdminAccessPolicy)
    : { access: AdminWorkspaceAccess; refused?: AdminAccessRecord["refused"] } {
  let access = lowerAdminWorkspaceAccess(terms.access, policy.access);
  if (access === "off") return { access, refused: ADMIN_ACCESS_ERROR_CODES.accessOff };
  if (access === "metadata" && ADMIN_CONTENT_METHODS.has(method)) {
    return { access, refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld };
  }
  return { access };
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
 * cut the audit stores apply, marked so that a record never passes a fragment off as the whole: to
 * arguments, workspace titles and setting keys. */
export function cutAdminAuditText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength - 1;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

// Hex digits of a long owner id's SHA-256 its audit form keeps: 80 bits, so that no two ids, however
// alike, share one.
const OWNER_DIGEST_LENGTH = 20;

/** A workspace owner's id as an audit record keeps it (see AdminAccessRecord.workspaceOwner): whole
 * while at most MAX_ADMIN_AUDIT_ARG_LENGTH characters, else its start, "…#" and a digest of the
 * whole id, MAX_ADMIN_AUDIT_ARG_LENGTH characters in all. An id is an identity, so unlike
 * cutAdminAuditText() this keeps two long ids sharing a start apart. Applied to its own result it
 * returns it unchanged, so the owner filter takes either form. */
export function auditOwnerId(id: string): string {
  if (id.length <= MAX_ADMIN_AUDIT_ARG_LENGTH) return id;
  let digest = createHash("sha256").update(id).digest("hex").slice(0, OWNER_DIGEST_LENGTH);
  let start = cutAdminAuditText(id, MAX_ADMIN_AUDIT_ARG_LENGTH - OWNER_DIGEST_LENGTH - 1);
  return `${start}#${digest}`;
}

/** The arguments an AdminAccessRecord keeps (see AdminAccessRecord.args): undefined ones left out,
 * each string cut by cutAdminAuditText() to MAX_ADMIN_AUDIT_ARG_LENGTH. */
export function redactAdminAuditArgs(args: Record<string, string | number | undefined>)
    : Record<string, string | number> {
  let kept: Record<string, string | number> = {};
  for (let [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    kept[name] = typeof value === "string"
        ? cutAdminAuditText(value, MAX_ADMIN_AUDIT_ARG_LENGTH) : value;
  }
  return kept;
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

// --- What a view below "full" withholds, and whether an answer holds any of it ---
//
// Each *HoldsContent() predicate takes what a view returns at any level and says whether it holds
// something the "metadata" level withholds (AdminAccessRecord.exposed). Present but empty is not
// content, so each is false for anything its withholder returns.

/** A copy of `meta` as a view below "full" lists it: without `queuedSteers`. */
export function withholdChatContent(meta: AiChatMetadata): AiChatMetadata {
  let { queuedSteers: _queuedSteers, ...rest } = meta;
  return rest;
}

/** Whether `meta` holds what withholdChatContent() drops: a queued steer. */
export function chatHoldsContent(meta: AiChatMetadata): boolean {
  return (meta.queuedSteers?.length ?? 0) > 0;
}

/** A copy of `state` as a view below "full" reports it: each queued call's `argsSummary`
 * emptied. */
export function withholdChatStateContent(state: AdminChatState): AdminChatState {
  return { ...state, queuedCalls: state.queuedCalls.map(call => ({ ...call, argsSummary: "" })) };
}

/** Whether `state` holds what withholdChatStateContent() empties: a queued call's argument
 * summary. */
export function chatStateHoldsContent(state: AdminChatState): boolean {
  return state.queuedCalls.some(call => call.argsSummary !== "");
}

/** A copy of `entry` as a view below "full" lists it: `description.description` emptied for an
 * action, observation or hook entry, and `description.fields` dropped; never mutates `entry`. */
export function withholdActionContent(entry: ActionLogEntry): ActionLogEntry {
  switch (entry.type) {
    case "action": {
      let { fields: _fields, ...description } = entry.description;
      return { ...entry, description: { ...description, description: "" } };
    }
    case "observation": {
      let { fields: _fields, ...description } = entry.description;
      return { ...entry, description: { ...description, description: "" } };
    }
    case "bindHook":
      return { ...entry, description: { ...entry.description, description: "" } };
  }
}

/** Whether `entry` holds what withholdActionContent() withholds: a description, or a field. */
export function actionHoldsContent(entry: ActionLogEntry): boolean {
  return entry.description.description !== "" ||
      (entry.type !== "bindHook" && (entry.description.fields?.length ?? 0) > 0);
}

/** A copy of `hook` as a view below "full" lists it: `description.description` emptied. */
export function withholdHookContent(hook: BoundHookInfo): BoundHookInfo {
  return { ...hook, description: { ...hook.description, description: "" } };
}

/** Whether `hook` holds what withholdHookContent() empties: a description. */
export function hookHoldsContent(hook: BoundHookInfo): boolean {
  return hook.description.description !== "";
}

/** Whether `summary` holds what workpieceSummary() drops below "full": the blueprint a gadget
 * follows (`upstream: {}` marks a gadget built from scratch, which follows none). */
export function workpieceHoldsContent(summary: WorkpieceSummary): boolean {
  return summary.type === "gadget" && summary.upstream?.blueprintId !== undefined;
}

/** Whether `page` holds what getChat() refuses below "full": a message or a compaction summary. */
export function chatPageHoldsContent(page: AiChatHistoryPage): boolean {
  return page.messages.length > 0 || page.compacted !== undefined;
}

/** Whether `file` holds what readFile() refuses below "full": any file found at the path, an
 * unreadable one too, since its message can quote the file (a symlink's quotes its target). */
export function fileHoldsContent(file: FileAtCommit): boolean {
  return file.kind !== "absent";
}
