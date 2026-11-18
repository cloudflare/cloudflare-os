// Deployment admin status, the bounds on admin access to workspaces and to users' accounts, and
// the text an audit record keeps.
//
// This is the one place the admin access bounds are decided, and the one place audit text is
// bounded (admin status is isDeploymentAdmin() in auth/config.ts). The bounds come from the environment, beside ADMINS, so that a compromised
// admin session can change neither: admins choose an access level and a retention within them (in
// AdminConfig), and adminAccessPolicy() holds that choice inside them wherever it is enforced. This
// is the reason authentication config stays in auth/config.ts rather than in AdminConfig.
//
// Whether admins may change a workspace at all is a third bound read from the environment
// (adminWorkspaceWritesEnabled()): a switch, with no admin setting under it.

import { createHash } from "node:crypto";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_LIST_DEFAULT_LIMIT, ADMIN_LIST_MAX_LIMIT,
  ADMIN_WORKSPACE_ACCESS_LEVELS, DEFAULT_ADMIN_AUDIT_RETENTION_DAYS, DEFAULT_ADMIN_COMMIT_LOG_DEPTH,
  DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS,
  MAX_ADMIN_ACCESS_REASON_LENGTH, MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_RETENTION_DAYS,
  MAX_ADMIN_AUDIT_STATS_DAYS, MAX_ADMIN_AUDIT_VALUE_LENGTH, MAX_ADMIN_COMMIT_LOG_DEPTH,
  MAX_ADMIN_VIEW_LIFETIME_SECONDS, createAdminAccessError,
  isAdminWorkspaceAccess,
  type ActionLogEntry, type AdminAccessRecord, type AdminChatState, type AdminFileContent,
  type AdminContentRequest, type AdminGrantRecord, type AdminSettingChange,
  type AdminSettingRecord, type AdminVia, type AdminViewAccess,
  type AdminWorkspaceAccess, type AdminWorkspaceMethod, type AiChatAuthorInfo,
  type AiChatHistoryPage, type AiChatMetadata, type BlueprintGadgetSummary, type BoundHookInfo,
  type CommitInfo, type GatekeeperCreationSpec, type NamedUser, type WorkpieceSummary,
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
const reportedInvalidWrites = new Set<unknown>();

// Never String(raw) of a value that is neither a string nor a number: that throws for a JSON
// binding whose toString is not a function.
function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

/** The most access ADMIN_WORKSPACE_ACCESS_MAX lets admins choose: "off", "metadata" or "content",
 * a string in any case and trimmed; "metadata" while it is unset or a blank string, so content is
 * allowed only where the variable says so. Anything else, a JSON binding included, misconfigures
 * a security bound, so it fails closed to "off" and is logged as an error (once per isolate per
 * value, never the value itself). */
export function maxAdminWorkspaceAccess(env: Cloudflare.Env): AdminWorkspaceAccess {
  let raw: unknown = env.ADMIN_WORKSPACE_ACCESS_MAX;
  if (raw === undefined || raw === null) return "metadata";
  // Never String(raw): that reads a JSON binding of ["content"] as "content" and of [] as blank.
  let level = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
  if (level === "") return "metadata";
  if (level !== undefined && isAdminWorkspaceAccess(level)) return level;

  // This bounds a security setting, so a value meant to turn inspection off ("none", "false", a
  // typo of "off") must fail closed, never grant the default.
  if (!reportedInvalidAccessMax.has(raw)) {
    reportedInvalidAccessMax.add(raw);
    logger.error(
        "ADMIN_WORKSPACE_ACCESS_MAX is not off, metadata or content, so admin access to " +
            "workspaces and users is off",
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
  let days = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
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

/** Whether ADMIN_WORKSPACE_WRITES lets admins change workspaces: only the string "on", in any case
 * and trimmed. Unset, blank and "off" are off. Any other value misconfigures a security bound, so
 * it is off too, logged as an error (once per isolate per value, never the value itself). A bound
 * of its own: neither ADMIN_WORKSPACE_ACCESS_MAX nor the level admins chose holds a write back. */
export function adminWorkspaceWritesEnabled(env: Cloudflare.Env): boolean {
  let raw: unknown = env.ADMIN_WORKSPACE_WRITES;
  // Never String(raw): that reads a JSON binding of ["on"] as "on" and of [] as blank, and throws
  // for an object whose toString is not a function.
  let value = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
  if (raw === undefined || raw === null || value === "") return false;
  if (value === "on") return true;

  // This turns on a privileged surface, so only its one documented value does: "true", "1" and a
  // typo of "on" all leave writes off.
  if (value !== "off" && !reportedInvalidWrites.has(raw)) {
    reportedInvalidWrites.add(raw);
    logger.error(
        "ADMIN_WORKSPACE_WRITES is not on or off, so admin writes to workspaces are off",
        { event: "admin.access.config.invalid" });
  }
  return false;
}

/** The lower of two access levels (ADMIN_WORKSPACE_ACCESS_LEVELS lists them in order). */
export function lowerAdminWorkspaceAccess(a: AdminWorkspaceAccess, b: AdminWorkspaceAccess)
    : AdminWorkspaceAccess {
  let order = ADMIN_WORKSPACE_ACCESS_LEVELS;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/** What the deployment enforces now: the admins' choices held within the environment's bounds. */
export type AdminAccessPolicy = {
  /** The level in force: the chosen level, at most maxAdminWorkspaceAccess(). */
  access: AdminWorkspaceAccess;
  /** How many days the audit log keeps a record: the chosen retention, at least
   * minAdminAuditRetentionDays(). */
  retentionDays: number;
};

/** The policy `config` and the environment give. Every enforcement point computes it from a config
 * it has just read; none holds one from earlier. `config` is a normalized one, so its chosen level
 * is a level (see normalizeAdminConfig()). */
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

/** Who takes a step of a request to read a workspace's content without its owner, as its
 * AdminGrantRecord says. */
export type AdminGrantActor = Pick<AdminGrantRecord, "admin" | "sessionId" | "via">;

/** What OverseerDurableObject.grantAdminContent() is given: a claimed content access request, and
 * the admin who approved it, through which session, for the AdminGrantRecord the workspace
 * appends. `workspaceOwner` is the owner the request named: the workspace refuses
 * (`workspaceChanged`) a call naming another owner than its own, since a deleted workspace's id
 * can be initialised again for someone else. */
export type AdminContentGrantCall = AdminGrantActor &
    Pick<AdminContentRequest, "reason" | "requestedBy" | "workspaceOwner"> & { requestId: string };

/** What an admin view is minted with (see OverseerDurableObject.openForAdmin() and
 * UserDurableObject.openForAdmin()), fixed for the view's life. */
export type AdminViewTerms = {
  /** Recorded on every record the view makes (see AdminVia). */
  via: AdminVia;
  /** When the view stops working. */
  expiresAt: Date;
};

/** What an AdminWorkspaceView is minted with (see OverseerDurableObject.openForAdmin()): an admin
 * view's terms, and what the view was opened for. */
export type AdminWorkspaceViewTerms = AdminViewTerms & {
  /** What the view was opened for (AdminWorkspaceInspectOptions.access): recorded on every
   * record the view makes, and the most any of its calls returns. */
  access: AdminViewAccess;
};

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

/** The depth `depth` asks AdminWorkspaceView.getCommitLog() for; throws unless absent
 * (DEFAULT_ADMIN_COMMIT_LOG_DEPTH) or a whole number from 1 to MAX_ADMIN_COMMIT_LOG_DEPTH. */
export function adminCommitLogDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_ADMIN_COMMIT_LOG_DEPTH;
  if (!isWholeNumberIn(depth, 1, MAX_ADMIN_COMMIT_LOG_DEPTH)) {
    throw new TypeError(
        `The commit log's depth must be a whole number from 1 to ${MAX_ADMIN_COMMIT_LOG_DEPTH}.`);
  }
  return depth;
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

/**
 * What each view method's answer can hold, which decides whether its call looks for a grant:
 *   - "metadata": metadata alone. The call never looks for a grant.
 *   - "mixed":    content under a grant and metadata without one. Without a grant it answers as
 *                 the "metadata" level does; it is not refused.
 *   - "content":  content alone. Without a grant the call is recorded and refused.
 * One table over every AdminWorkspaceMethod, so that a method added to ADMIN_WORKSPACE_METHODS
 * does not compile until it is classified: AdminWorkspaceViewImpl.#call reads the kind from here
 * and from nowhere else.
 */
export const ADMIN_METHOD_ANSWERS = {
  // The open itself, which AdminWorkspaceViewImpl.open() records through #call as the view's
  // first call: its record never holds content, and a view is opened for content without a
  // grant being looked for.
  inspectWorkspace: "metadata",
  describe: "mixed",
  listChats: "mixed",
  getChat: "content",
  getChatState: "mixed",
  listChatAttachments: "metadata",
  readChatAttachment: "content",
  listActions: "mixed",
  listFiles: "metadata",
  readFile: "content",
  getCommitLog: "mixed",
  listFilesAtCommit: "metadata",
  readFileAtCommit: "content",
  listChangedPaths: "metadata",
  listPendingChanges: "metadata",
  readPendingFile: "content",
  listGatekeepers: "mixed",
  listObservers: "metadata",
  listObserverRequirements: "metadata",
  listShareLinks: "metadata",
  listAutoApprovals: "metadata",
  listBlueprints: "mixed",
  getDiagnostics: "metadata",
} as const satisfies Record<AdminWorkspaceMethod, "metadata" | "mixed" | "content">;

/** Why a call may return no content before any grant is looked for: `contentNotRequested` for a
 * view opened for metadata, then `contentOff` while `policy.access` is below "content";
 * undefined when both allow content. Never throws. */
export function adminContentRefusal(
    terms: AdminWorkspaceViewTerms, policy: Pick<AdminAccessPolicy, "access">)
    : AdminAccessRecord["refused"] | undefined {
  if (terms.access !== "content") return ADMIN_ACCESS_ERROR_CODES.contentNotRequested;
  if (policy.access !== "content") return ADMIN_ACCESS_ERROR_CODES.contentOff;
  return undefined;
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

/** The id of the user an admin view's record is about, as the record keeps it: a workspace's owner
 * (AdminAccessRecord.workspaceOwner) or an account's user (AdminUserAccessRecord.userId). Whole
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

/** `user` as a record that admins read keeps them (NamedUser): the id as auditOwnerId() gives it,
 * the name cut by cutAdminAuditText() to MAX_ADMIN_AUDIT_ARG_LENGTH, and no other field of a
 * profile. The one place a profile becomes a NamedUser, so that no such record holds a profile:
 * neither an id nor a display name has a bound of its own. */
export function namedUser(user: Pick<AiChatAuthorInfo, "id" | "name">): NamedUser {
  return {
    id: auditOwnerId(user.id),
    name: cutAdminAuditText(user.name, MAX_ADMIN_AUDIT_ARG_LENGTH),
  };
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

// --- What a call made without a grant withholds, and whether an answer holds any of it ---
//
// Each *HoldsContent() predicate takes what a view returns, with a grant or without, and says
// whether it holds something the "metadata" level withholds (AdminAccessRecord.exposed). Present
// but empty is not content, so each is false for anything its withholder returns.

/** A copy of `meta` as a call without a grant lists it: without `queuedSteers`. */
export function withholdChatContent(meta: AiChatMetadata): AiChatMetadata {
  let { queuedSteers: _queuedSteers, ...rest } = meta;
  return rest;
}

/** Whether `meta` holds what withholdChatContent() drops: a queued steer. */
export function chatHoldsContent(meta: AiChatMetadata): boolean {
  return (meta.queuedSteers?.length ?? 0) > 0;
}

/** A copy of `state` as a call without a grant reports it: each queued call without its
 * `argsSummary`. */
export function withholdChatStateContent(state: AdminChatState): AdminChatState {
  return {
    ...state,
    queuedCalls: state.queuedCalls.map(({ argsSummary: _argsSummary, ...call }) => call),
  };
}

/** Whether `state` holds what withholdChatStateContent() drops: a queued call's argument
 * summary. */
export function chatStateHoldsContent(state: AdminChatState): boolean {
  return state.queuedCalls.some(call => (call.argsSummary ?? "") !== "");
}

/** A copy of `commit` as a call without a grant lists it: `message` emptied. */
export function withholdCommitContent(commit: CommitInfo): CommitInfo {
  return { ...commit, message: "" };
}

/** Whether `commit` holds what withholdCommitContent() empties: a message. */
export function commitHoldsContent(commit: CommitInfo): boolean {
  return commit.message !== "";
}

/** A copy of `entry` as a call without a grant lists it: `description.description` emptied for an
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

/** A copy of `hook` as a call without a grant lists it: `description.description` emptied. */
export function withholdHookContent(hook: BoundHookInfo): BoundHookInfo {
  return { ...hook, description: { ...hook.description, description: "" } };
}

/** Whether `hook` holds what withholdHookContent() empties: a description. */
export function hookHoldsContent(hook: BoundHookInfo): boolean {
  return hook.description.description !== "";
}

/** A copy of `spec` as a call without a grant lists it: without `configuration`, which is text
 * the agent that created the resource wrote. */
export function withholdCreationContent(spec: GatekeeperCreationSpec): GatekeeperCreationSpec {
  if (spec.type !== "gatekeeper") return spec;
  let { configuration: _configuration, ...rest } = spec;
  return rest;
}

/** Whether `spec` holds what withholdCreationContent() drops: a configuration. */
export function creationHoldsContent(spec: GatekeeperCreationSpec): boolean {
  return spec.type === "gatekeeper" && (spec.configuration ?? "") !== "";
}

/** Whether `summary` holds what describe() leaves out without a grant: the blueprint a gadget
 * follows (`upstream: {}` marks a gadget built from scratch, which follows none). */
export function workpieceHoldsContent(summary: WorkpieceSummary): boolean {
  return summary.type === "gadget" && summary.upstream?.blueprintId !== undefined;
}

/** A copy of `blueprint` as a call without a grant lists it: `id` emptied, and `screenshotUrl`,
 * which holds the id, left out. A blueprint's id is a share link to its code, which is why
 * describe() leaves a gadget's `upstream` out without a grant too. */
export function withholdBlueprintContent(blueprint: BlueprintGadgetSummary)
    : BlueprintGadgetSummary {
  let { screenshotUrl: _screenshotUrl, ...rest } = blueprint;
  return { ...rest, id: "" };
}

/** Whether `blueprint` holds what withholdBlueprintContent() empties: an id. */
export function blueprintHoldsContent(blueprint: BlueprintGadgetSummary): boolean {
  return blueprint.id !== "";
}

/** Whether `page` holds what getChat() reads: a message, or a compaction summary. */
export function chatPageHoldsContent(page: AiChatHistoryPage): boolean {
  return page.messages.length > 0 || page.compacted !== undefined;
}

/** Whether `file` holds what a file read (readFile(), readFileAtCommit(), readPendingFile())
 * reads: any file found at the path, an unreadable one too, since its message can quote the file
 * (a symlink's quotes its target). */
export function fileHoldsContent(file: AdminFileContent): boolean {
  return file.kind !== "absent";
}
