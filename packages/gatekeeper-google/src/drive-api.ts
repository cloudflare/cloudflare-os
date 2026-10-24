// Structured Google Drive API client shared by configurators, sessions, and observer verification.

import type { DriveObservation } from "./drive-observers";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.drive", vendorId: "google" });

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_BATCH_URL = "https://www.googleapis.com/batch/drive/v3";
const MAX_BATCH_FILES = 100;
const MAX_BATCH_RESPONSE_BYTES = 1_000_000;
const MAX_JSON_RESPONSE_BYTES = 5_000_000;
/** Per-attempt budget for a file download, which carries far more than a metadata read. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/**
 * Parents one `q` may name. Drive documents no query-length limit, so this is ours: the batched
 * parent proof chunks at 100, and without a cap here a longer set would pass that and then fail
 * the search with an opaque provider 400.
 */
export const MAX_QUERY_PARENTS = 50;

const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/** Whether `id` has the shape of a Drive file ID, checked before it reaches a Drive request path. */
export function isDriveFileId(id: string): boolean {
  return DRIVE_FILE_ID_PATTERN.test(id);
}

function requireDriveFileId(id: string): void {
  if (!isDriveFileId(id)) throw new Error("Not a Google Drive file ID.");
}

/**
 * Loose on purpose: Docs and Sheets name comments `doco.…` and Slides an 11-character token. At
 * least one letter or digit, so a `.` or `..` segment cannot climb the request path.
 */
const DRIVE_COMMENT_ID_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]{1,256}$/;

/**
 * Whether `id` has the shape of a Drive comment ID, checked before it reaches a Drive request path.
 * Reply IDs share the shape.
 */
export function isDriveCommentId(id: string): boolean {
  return DRIVE_COMMENT_ID_PATTERN.test(id);
}

function requireDriveCommentId(id: string): void {
  if (!isDriveCommentId(id)) throw new Error("Not a Google Drive comment ID.");
}

/** Exact MIME type Drive gives a native folder. A shortcut to one has its own type, not this. */
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** MIME type of a shortcut, which stands for the file or folder in its `shortcutDetails`. */
export const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

/** The subset of Drive's file resource this gatekeeper asks for. */
export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  driveId?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  webViewLink?: string;
  trashed?: boolean;
  capabilities?: { canListChildren?: boolean };
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

/**
 * The minimal per-file facts a folder-scope descendant proof, or an observer check, rests on.
 *
 * Deliberately narrower than {@link DriveFile}: an ancestry walk touches folders the caller never
 * asked about and must never see, so it fetches only what membership is decided from, plus whether
 * this account may comment, which is what reading a file's comments is decided from.
 */
export type DriveScopeNode = {
  id: string;
  mimeType?: string;
  parents?: string[];
  driveId?: string;
  trashed?: boolean;
  canListChildren?: boolean;
  canComment?: boolean;
};

/** Field mask for the facts {@link DriveApi.getScopeNodes} uses to prove scope. */
const DRIVE_SCOPE_NODE_FIELDS =
  "id,mimeType,parents,driveId,trashed,capabilities(canListChildren,canComment)";

/**
 * Whether these facts describe a folder a binding may stand on: a live native folder whose
 * children this account can list.
 *
 * The one definition of that triple. Both record shapes reach it through the adapters below, so a
 * scope check can never accidentally assert two of the three.
 */
function listableFolder(
  mimeType: string | undefined, trashed: boolean | undefined,
  canListChildren: boolean | undefined,
): boolean {
  return mimeType === FOLDER_MIME_TYPE && trashed === false && canListChildren === true;
}

/** {@link listableFolder} for the narrow ancestry-proof shape. */
export function isListableFolderNode(node: DriveScopeNode): boolean {
  return listableFolder(node.mimeType, node.trashed, node.canListChildren);
}

/** {@link listableFolder} for a full file resource. */
export function isListableFolderFile(file: DriveFile): boolean {
  return listableFolder(file.mimeType, file.trashed, file.capabilities?.canListChildren);
}

/** The per-file field mask. `getFile` sends this; {@link DRIVE_FILE_FIELDS} wraps it for lists. */
export const DRIVE_FILE_ITEM_FIELDS = [
  "id", "name", "mimeType", "modifiedTime", "size", "parents", "driveId", "trashed",
  "owners(displayName,emailAddress)", "webViewLink", "capabilities(canListChildren)",
  "shortcutDetails(targetId,targetMimeType)",
].join(",");

/** Drive returns only requested fields, so this mask and {@link DriveFile} travel together. */
const DRIVE_FILE_FIELDS = `incompleteSearch,nextPageToken,files(${DRIVE_FILE_ITEM_FIELDS})`;

/** What converting a file reads of its source. */
export type DriveConversionSource = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  /** Bytes, as a decimal string. */
  size?: string;
  parents?: string[];
  driveId?: string;
  trashed?: boolean;
  canCopy?: boolean;
};

/** Field mask for {@link DriveConversionSource}; its own, so agent listings never widen. */
const CONVERSION_SOURCE_FIELDS =
  "id,name,mimeType,modifiedTime,size,parents,driveId,trashed,capabilities(canCopy)";

/** A native copy made from an Office file, as Drive describes it. */
export type DriveConvertedCopy = {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  createdTime?: string;
  trashed?: boolean;
  /** Whether the connected account may edit it; a copy another user made may be visible too. */
  canEdit?: boolean;
  appProperties?: Record<string, string>;
};

/** Field mask for {@link DriveConvertedCopy}. */
const CONVERTED_COPY_FIELDS =
  "id,name,mimeType,parents,createdTime,trashed,capabilities(canEdit),appProperties";

/** The app property naming the file a copy was converted from. */
export const CONVERTED_FROM_PROPERTY = "gadgetsConvertedFrom";
/** The app property recording the source's `modifiedTime` when it was copied. */
export const SOURCE_MODIFIED_PROPERTY = "gadgetsSourceModified";

/** Where a native copy landed: in the source's folder, or in My Drive when that could not take it. */
export type DriveCopyLocation = "besideOriginal" | "myDrive";

/** Drive's alias for the connected account's My Drive root folder. */
const MY_DRIVE_ROOT = "root";

/** Clauses only the gatekeeper's own lookups add, never built from agent or iframe input. */
type InternalDriveQuery = {
  /** Files whose {@link CONVERTED_FROM_PROPERTY} names this source. */
  convertedFrom?: string;
};

/** Structured Drive search clauses. Every populated field is AND-ed. */
export type DriveFileQuery = {
  /** Single-type shorthand. */
  mimeType?: string;
  mimeTypes?: string[];
  /** Name prefix; Drive spells its prefix-only operator `contains`. */
  namePrefix?: string;
  fullTextContains?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  /** Proven parent folders; a file matches when any one of them is its direct parent. */
  directParentIds?: readonly string[];
  /** Only files shared with this account by others, as Drive's "Shared with me" lists them. */
  sharedWithMe?: boolean;
};

/**
 * Which corpus `listFiles` searches.
 *
 * One value rather than the provider's independent `corpora`/`driveId` pair: a shared-drive
 * binding's whole boundary is those two travelling together, and `driveId` without
 * `corpora: "drive"` silently falls back to the user corpus. `allDrives` spans My Drive, "Shared
 * with me", and every shared drive this account is a member of.
 */
export type DriveCorpus =
  | { kind: "user" }
  | { kind: "allDrives" }
  | { kind: "drive"; driveId: string };

export type DriveListFilesOptions = DriveFileQuery & {
  pageSize?: number;
  pageToken?: string;
  /** `null` preserves Drive's relevance ordering for full-text search. */
  orderBy?: string | null;
  /** Defaults to the connected account's user corpus. */
  corpus?: DriveCorpus;
};

export type DriveFileList = { files: DriveFile[]; nextPageToken?: string };

/** A shared drive this account is a member of. Its id is also its root folder's. */
export type DriveSharedDrive = { id: string; name: string };

export type DriveSharedDriveList = { drives: DriveSharedDrive[]; nextPageToken?: string };

/** Drive refused because the API is not enabled on this OAuth project. */
export class DriveApiDisabledError extends Error {}

/** Sanitized HTTP failure from the Google Drive API. */
export class DriveApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string,
  ) {
    super(`Google Drive API request failed: ${status}${
      reason ? ` (${REASON_EXPLANATIONS[reason] ?? reason})` : ""}`);
  }

  /**
   * Whether this failure describes the account or the app rather than one file.
   *
   * A file-specific denial is a scope fact a caller may record; these are not, so recording one
   * would narrow a listing or deny a binding on an outage.
   */
  get isAccountWide(): boolean {
    return this.status === 403 && this.reason !== undefined &&
      ACCOUNT_WIDE_403_REASONS.has(this.reason);
  }
}

const MAX_ERROR_BODY_BYTES = 4096;
const API_DISABLED_REASON = "accessNotConfigured";
const ACCOUNT_WIDE_403_REASONS = new Set([
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  // The domain administrator has disabled Drive for this app, for every file it might ask about.
  "domainPolicy",
]);

/** Reasons whose bare code leaves a caller nothing to act on. */
const REASON_EXPLANATIONS: Record<string, string> = {
  teamDriveMembershipRequired:
    "the connected account is not a member of the shared drive this item belongs to",
};

function googleErrorReason(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || !Array.isArray(value.error.errors)) {
    return undefined;
  }
  let first = value.error.errors[0];
  if (!isRecord(first)) return undefined;
  let reason = first.reason;
  return typeof reason === "string" && /^\w{1,64}$/.test(reason) ? reason : undefined;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  if (!response.body) return "";
  let reader = response.body.getReader();
  let decoder = new TextDecoder();
  let chunks: string[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      let { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

function googleErrorReasonFromText(text: string): string | undefined {
  try {
    return googleErrorReason(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Parses a Drive JSON body without exposing its metadata in failures. */
function parseDriveJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Google Drive ${context} was not valid JSON (${text.length} UTF-16 code units)`);
  }
}

async function errorReason(response: Response): Promise<string | undefined> {
  let text = await readBoundedText(
    response, MAX_ERROR_BODY_BYTES, "Google Drive error response was too large").catch(() => "");
  return googleErrorReasonFromText(text);
}

async function driveError(response: Response): Promise<Error> {
  let reason = await errorReason(response);
  if (response.status === 403 && reason === API_DISABLED_REASON) {
    return new DriveApiDisabledError(
      "the Google Drive API is not enabled for this OAuth project");
  }
  return new DriveApiRequestError(response.status, reason);
}

function megabytes(bytes: number): string {
  return String(Math.ceil(bytes / (1024 * 1024)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid Google Drive ${field}`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid Google Drive ${field}`);
  return value;
}

function optionalFields(value: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  let result: Record<string, string> = {};
  for (let field of fields) {
    let parsed = optionalString(value[field], `file ${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  return result;
}

function optionalParents(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(parent => typeof parent !== "string")) {
    throw new Error("Invalid Google Drive file parents");
  }
  return value as string[];
}

function optionalCapability(value: unknown, capability: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid Google Drive file capabilities");
  return optionalBoolean(value[capability], `file capabilities.${capability}`);
}

function optionalCanListChildren(value: unknown): boolean | undefined {
  return optionalCapability(value, "canListChildren");
}

function parseDriveFile(value: unknown): DriveFile {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new Error("Invalid Google Drive file response");
  }
  let owners: DriveFile["owners"];
  if (value.owners !== undefined) {
    if (!Array.isArray(value.owners)) throw new Error("Invalid Google Drive file owners");
    owners = value.owners.map(owner => {
      if (!isRecord(owner)) throw new Error("Invalid Google Drive file owner");
      return optionalFields(owner, ["displayName", "emailAddress"]);
    });
  }
  let shortcutDetails: DriveFile["shortcutDetails"];
  if (value.shortcutDetails !== undefined) {
    if (!isRecord(value.shortcutDetails)) throw new Error("Invalid Google Drive shortcut details");
    shortcutDetails = optionalFields(value.shortcutDetails, ["targetId", "targetMimeType"]);
  }
  let capabilities: DriveFile["capabilities"];
  if (value.capabilities !== undefined) {
    let canListChildren = optionalCanListChildren(value.capabilities);
    capabilities = canListChildren === undefined ? {} : { canListChildren };
  }
  let parents = optionalParents(value.parents);
  let trashed = optionalBoolean(value.trashed, "file trashed");
  return {
    id: value.id,
    name: value.name,
    ...optionalFields(value, [
      "mimeType", "modifiedTime", "size", "driveId", "webViewLink",
    ]),
    ...(parents ? { parents } : {}),
    ...(owners ? { owners } : {}),
    ...(trashed === undefined ? {} : { trashed }),
    ...(capabilities ? { capabilities } : {}),
    ...(shortcutDetails ? { shortcutDetails } : {}),
  };
}

function optionalAppProperties(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some(entry => typeof entry !== "string")) {
    throw new Error("Invalid Google Drive file appProperties");
  }
  return value as Record<string, string>;
}

function requireIdAndName(value: unknown): Record<string, unknown> & { id: string; name: string } {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new Error("Invalid Google Drive file response");
  }
  return value as Record<string, unknown> & { id: string; name: string };
}

function parseConversionSource(value: unknown): DriveConversionSource {
  let file = requireIdAndName(value);
  let canCopy: boolean | undefined;
  if (file.capabilities !== undefined) {
    if (!isRecord(file.capabilities)) throw new Error("Invalid Google Drive file capabilities");
    canCopy = optionalBoolean(file.capabilities.canCopy, "file capabilities.canCopy");
  }
  let parents = optionalParents(file.parents);
  let trashed = optionalBoolean(file.trashed, "file trashed");
  return {
    id: file.id,
    name: file.name,
    ...optionalFields(file, ["mimeType", "modifiedTime", "size", "driveId"]),
    ...(parents ? { parents } : {}),
    ...(trashed === undefined ? {} : { trashed }),
    ...(canCopy === undefined ? {} : { canCopy }),
  };
}

function parseConvertedCopy(value: unknown): DriveConvertedCopy {
  let file = requireIdAndName(value);
  let canEdit: boolean | undefined;
  if (file.capabilities !== undefined) {
    if (!isRecord(file.capabilities)) throw new Error("Invalid Google Drive file capabilities");
    canEdit = optionalBoolean(file.capabilities.canEdit, "file capabilities.canEdit");
  }
  let parents = optionalParents(file.parents);
  let trashed = optionalBoolean(file.trashed, "file trashed");
  let appProperties = optionalAppProperties(file.appProperties);
  return {
    id: file.id,
    name: file.name,
    ...optionalFields(file, ["mimeType", "createdTime"]),
    ...(parents ? { parents } : {}),
    ...(trashed === undefined ? {} : { trashed }),
    ...(canEdit === undefined ? {} : { canEdit }),
    ...(appProperties ? { appProperties } : {}),
  };
}

/** Whether Drive refused because the token lacks a scope the request needs. */
export function isInsufficientScope(error: unknown): boolean {
  return error instanceof DriveApiRequestError && error.status === 403 &&
    error.reason === "insufficientPermissions";
}

/**
 * Drive's indistinguishable "absent or not permitted" answer about one file.
 *
 * One definition, because the session cores, the batch path and the configurator must agree on it:
 * a reason Google documents as account-wide is an outage, not a scope fact, and recording it would
 * narrow a listing or deny a binding for everyone.
 */
export function isFileInvisible(error: unknown): boolean {
  return error instanceof DriveApiRequestError && !error.isAccountWide &&
    (error.status === 403 || error.status === 404);
}

/**
 * Whether Drive refused to send a file's content because the token cannot read content at all.
 * A token holding only `drive.metadata.readonly` is refused a download with
 * `appNotAuthorizedToFile`, which {@link isInsufficientScope} does not match.
 */
export function lacksFileContentAccess(error: unknown): boolean {
  return isInsufficientScope(error) || (error instanceof DriveApiRequestError &&
    error.status === 403 && error.reason === "appNotAuthorizedToFile");
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]);

/**
 * A failed conversion request in our own words, from the status and reason alone; anything that
 * is not a Drive HTTP failure is returned as it is.
 */
export function conversionError(error: unknown): unknown {
  if (!(error instanceof DriveApiRequestError)) return error;
  let { status, reason } = error;
  if (status === 404) {
    return new Error(
      "Google Drive could not find this file, or the connected account cannot open it.");
  }
  if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
    return new Error("Google Drive is limiting requests from this account. Try again in a minute.");
  }
  if (status === 403 && reason === "cannotCopyFile") {
    return new Error("The owner of this file has turned off copying, so Google Drive cannot copy it.");
  }
  if (status === 403 && reason === "storageQuotaExceeded") {
    return new Error("The connected Google account has no Drive storage left for the copy.");
  }
  if (isInsufficientScope(error)) {
    return new Error("The connected Google account has not granted access to copy Drive files.");
  }
  return new Error(`Google Drive could not make the copy [http=${status}].`);
}

/**
 * Parses one batch part's body as the scope node for `fileId`.
 *
 * The echo check is load-bearing, not defensive noise: these nodes decide whether a file is inside
 * the bound folder, and a body answering for some other file would decide it from the wrong facts.
 */
function parseDriveScopeNode(body: string, fileId: string): DriveScopeNode {
  let value = parseDriveJson(body, "batch response part");
  if (!isRecord(value) || value.id !== fileId) {
    throw new Error("Google Drive batch response did not echo the requested file ID");
  }
  let parents = optionalParents(value.parents);
  let trashed = optionalBoolean(value.trashed, "file trashed");
  let canListChildren = optionalCanListChildren(value.capabilities);
  let canComment = optionalCapability(value.capabilities, "canComment");
  return {
    id: fileId,
    ...optionalFields(value, ["mimeType", "driveId"]),
    ...(parents ? { parents } : {}),
    ...(trashed === undefined ? {} : { trashed }),
    ...(canListChildren === undefined ? {} : { canListChildren }),
    ...(canComment === undefined ? {} : { canComment }),
  };
}

/** Escapes a value for interpolation into a Drive `q` string literal. */
export function escapeDriveQueryLiteral(value: string): string {
  let backslash = "\\";
  return value.replaceAll(backslash, backslash + backslash).replaceAll("'", backslash + "'");
}

function literalClause(field: string, operator: string, value: string): string {
  return `${field} ${operator} '${escapeDriveQueryLiteral(value)}'`;
}

/**
 * Assembles a Drive `q` from structured values. Trashed files are always excluded. `internal`
 * carries clauses only the gatekeeper's own lookups pass.
 */
export function buildDriveQuery(query: DriveFileQuery, internal: InternalDriveQuery = {}): string {
  let clauses = ["trashed = false"];
  if (query.mimeType?.trim()) {
    clauses.push(literalClause("mimeType", "=", query.mimeType.trim()));
  }
  let name = query.namePrefix?.trim();
  if (name) clauses.push(literalClause("name", "contains", name));
  let fullText = query.fullTextContains?.trim();
  if (fullText) clauses.push(literalClause("fullText", "contains", fullText));
  let mimeTypes = query.mimeTypes?.map(value => value.trim()).filter(Boolean);
  if (mimeTypes?.length) {
    clauses.push(`(${mimeTypes.map(value => literalClause("mimeType", "=", value)).join(" or ")})`);
  }
  if (query.modifiedAfter) clauses.push(literalClause("modifiedTime", ">", query.modifiedAfter));
  if (query.modifiedBefore) clauses.push(literalClause("modifiedTime", "<", query.modifiedBefore));
  if (query.directParentIds !== undefined) {
    let parents = query.directParentIds.map(id => id.trim()).filter(Boolean);
    if (!parents.length) {
      throw new Error(
        "directParentIds must name at least one parent; omit it to read the whole binding.");
    }
    if (parents.length > MAX_QUERY_PARENTS) {
      throw new Error(`directParentIds accepts at most ${MAX_QUERY_PARENTS} parents.`);
    }
    let inParents = (id: string) => `'${escapeDriveQueryLiteral(id)}' in parents`;
    clauses.push(parents.length === 1 ? inParents(parents[0]) : `(${parents.map(inParents).join(" or ")})`);
  }
  if (query.sharedWithMe) clauses.push("sharedWithMe = true");
  if (internal.convertedFrom !== undefined) {
    clauses.push(`appProperties has { key='${CONVERTED_FROM_PROPERTY}' and value='${
      escapeDriveQueryLiteral(internal.convertedFrom)}' }`);
  }
  return clauses.join(" and ");
}

type BatchAccessPart = { status: number; body: string };

/**
 * The inner HTTP response carried by one `multipart/mixed` part: a status line, headers, a blank
 * line, then the body.
 *
 * The body is located forward from the status line rather than taken as the part's last
 * blank-line-delimited chunk. A conforming emitter ends the body with a blank line before the next
 * boundary, so that chunk is empty, and reading it as the body turns every *successful* subrequest
 * into unparseable JSON. The status is read from the same match, so a body quoting a status line
 * cannot supply it either.
 */
function parseBatchPart(part: string): BatchAccessPart | undefined {
  let statusMatch = /HTTP\/1\.[01] (\d{3})/.exec(part);
  if (!statusMatch) return undefined;
  let afterStatus = part.slice(statusMatch.index);
  let headerEnd = /\r?\n\r?\n/.exec(afterStatus);
  return {
    status: Number(statusMatch[1]),
    body: headerEnd ? afterStatus.slice(headerEnd.index + headerEnd[0].length).trim() : "",
  };
}

/**
 * Split a Drive batch response and place each part by its echoed Content-ID.
 *
 * Google does not promise part order. These booleans gate observer admission, so a swapped pair
 * would let the wrong collaborator in (or lock the right one out). Refuse a missing or
 * unrecognised part rather than guessing.
 */
async function parseBatchAccessParts(
  response: Response, count: number,
): Promise<BatchAccessPart[]> {
  let contentType = response.headers.get("Content-Type") ?? "";
  let boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  let responseBoundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!responseBoundary) throw new Error("Invalid Google Drive batch response boundary");
  let text = await readBoundedText(
    response, MAX_BATCH_RESPONSE_BYTES, "Google Drive batch response was too large");
  let responseParts = text.split(`--${responseBoundary}`).filter(part => /HTTP\/1\.[01] \d{3}/.test(part));
  if (responseParts.length !== count) {
    throw new Error("Google Drive batch response did not contain one result per file");
  }
  let placed: Array<BatchAccessPart | undefined> = Array.from({ length: count });
  for (let part of responseParts) {
    let idMatch = /Content-ID:\s*<response-item-(\d+)>/i.exec(part);
    if (!idMatch) {
      throw new Error("Google Drive batch response part was missing a Content-ID");
    }
    let index = Number(idMatch[1]);
    if (index < 0 || index >= count || placed[index] !== undefined) {
      throw new Error("Google Drive batch response part had an unrecognised Content-ID");
    }
    let parsed = parseBatchPart(part);
    if (!parsed) throw new Error("Google Drive batch response part was missing a status line");
    placed[index] = parsed;
  }
  return placed.map(part => {
    if (part === undefined) {
      throw new Error("Google Drive batch response did not contain one result per file");
    }
    return part;
  });
}

function batchPartAllowed(part: BatchAccessPart): boolean {
  if (part.status >= 200 && part.status < 300) return true;
  let reason = googleErrorReasonFromText(part.body);
  if (part.status === 403 && reason === API_DISABLED_REASON) {
    throw new DriveApiDisabledError(
      "the Google Drive API is not enabled for this OAuth project");
  }
  if (part.status === 403 && reason !== undefined && ACCOUNT_WIDE_403_REASONS.has(reason)) {
    throw new Error("Google Drive batch subrequest failed: 403");
  }
  if (part.status === 403 || part.status === 404) return false;
  throw new Error(`Google Drive batch subrequest failed: ${part.status}`);
}

/** Google's limit on a comment's or reply's content, in bytes of UTF-8. */
export const MAX_COMMENT_BYTES = 4096;

/** Our own limit on the text a comment quotes or a suggested edit replaces, in characters. */
export const MAX_QUOTE_CHARS = 500;

/** Bytes `text` takes in UTF-8, which is what {@link MAX_COMMENT_BYTES} counts. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Refuses content Google would refuse, and content it would wrongly accept: an empty or
 * whitespace-only comment is created as an empty one. `what` names the content in the error.
 */
export function checkCommentContent(content: string, what: "comment" | "reply" = "comment"): void {
  if (!content.trim()) throw new Error(`The ${what} is empty.`);
  let bytes = utf8ByteLength(content);
  if (bytes > MAX_COMMENT_BYTES) {
    throw new Error(
      `The ${what} is ${bytes} bytes of UTF-8; Google Drive allows at most ${MAX_COMMENT_BYTES}.`);
  }
}

/**
 * Per-attempt budget for a comment write. A write makes at most three attempts (the first, one
 * after an auth refresh, one after a reconnect changed the stored token).
 */
const COMMENT_WRITE_TIMEOUT_MS = 20_000;

/**
 * The longest a comment write's requests can take before it settles or is abandoned, so a write
 * not found this long after it began was not left in flight by that attempt.
 */
export const COMMENT_WRITE_MAX_MS = 3 * COMMENT_WRITE_TIMEOUT_MS;

/** A comment's or reply's author, as Drive describes them to the connected account. */
export type DriveCommentAuthorRecord = {
  displayName: string;
  /** Whether the author is the connected account. */
  me: boolean;
};

/** One reply to a comment. A resolve with no text has content `""`. */
export type DriveReplyRecord = {
  id: string;
  content: string;
  author: DriveCommentAuthorRecord;
  createdTime: string;
  modifiedTime?: string;
  deleted: boolean;
  /** Set only on a reply that resolved or reopened its comment. */
  action?: "resolve" | "reopen";
};

/** One comment and its replies, as plain text: Drive derives `htmlContent`, which is never read. */
export type DriveCommentRecord = {
  id: string;
  content: string;
  author: DriveCommentAuthorRecord;
  createdTime: string;
  /** Bumped by every reply, so a later `startModifiedTime` lists the comment again. */
  modifiedTime?: string;
  /** Drive sends this only once a comment has been resolved; absent reads as unresolved. */
  resolved: boolean;
  deleted: boolean;
  replies: DriveReplyRecord[];
};

/** One page of comments. */
export type DriveCommentList = { comments: DriveCommentRecord[]; nextPageToken?: string };

/** One page of a comment's replies. */
export type DriveReplyList = { replies: DriveReplyRecord[]; nextPageToken?: string };

/**
 * Field masks for replies and comments. Each is the one mask its writes and its reads send: Drive
 * applies a write before it checks the mask, so an invalid one answers 400 having posted anyway.
 */
const REPLY_FIELDS = "id,content,author(displayName,me),createdTime,modifiedTime,deleted,action";
const COMMENT_FIELDS = "id,content,author(displayName,me),createdTime,modifiedTime,resolved,deleted," +
  `replies(${REPLY_FIELDS})`;

function parseCommentAuthor(value: unknown): DriveCommentAuthorRecord {
  if (!isRecord(value)) throw new Error("Invalid Google Drive comment author");
  return {
    displayName: optionalString(value.displayName, "comment author displayName") ?? "",
    me: optionalBoolean(value.me, "comment author me") ?? false,
  };
}

/** The fields comments and replies share. A deleted one comes without its content. */
function parseCommentCore(value: unknown, kind: string) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.createdTime !== "string") {
    throw new Error(`Invalid Google Drive ${kind} response`);
  }
  let modifiedTime = optionalString(value.modifiedTime, `${kind} modifiedTime`);
  return {
    value,
    core: {
      id: value.id,
      content: optionalString(value.content, `${kind} content`) ?? "",
      author: parseCommentAuthor(value.author),
      createdTime: value.createdTime,
      ...(modifiedTime === undefined ? {} : { modifiedTime }),
      deleted: optionalBoolean(value.deleted, `${kind} deleted`) ?? false,
    },
  };
}

function parseReply(raw: unknown): DriveReplyRecord {
  let { value, core } = parseCommentCore(raw, "reply");
  let action = value.action;
  if (action !== undefined && action !== "resolve" && action !== "reopen") {
    throw new Error("Invalid Google Drive reply action");
  }
  return { ...core, ...(action === undefined ? {} : { action }) };
}

function parseComment(raw: unknown): DriveCommentRecord {
  let { value, core } = parseCommentCore(raw, "comment");
  if (value.replies !== undefined && !Array.isArray(value.replies)) {
    throw new Error("Invalid Google Drive comment replies");
  }
  return {
    ...core,
    resolved: optionalBoolean(value.resolved, "comment resolved") ?? false,
    replies: (value.replies ?? []).map(parseReply),
  };
}

/** A list response's `key` array, parsed item by item, and its continuation token. */
function parseListPage<K extends string, T>(
  body: unknown, key: K, parse: (value: unknown) => T,
): Record<K, T[]> & { nextPageToken?: string } {
  let raw = isRecord(body) ? body[key] ?? [] : undefined;
  if (!isRecord(body) || !Array.isArray(raw)) {
    throw new Error(`Invalid Google Drive ${key} list response`);
  }
  let nextPageToken = optionalString(body.nextPageToken, "nextPageToken");
  return {
    [key]: raw.map(parse), ...(nextPageToken ? { nextPageToken } : {}),
  } as Record<K, T[]> & { nextPageToken?: string };
}

/**
 * What a failed comment write proves about whether it was posted.
 *
 * - `absent`: Drive refused it before posting anything (an invisible file or comment, a missing
 *   permission or scope, content over Google's limit), so it is safe to give up.
 * - `rateLimited`: nothing was posted, and the same write may succeed later.
 * - `unknown`: anything else. Drive can post a comment and still answer 400, and a 5xx, a network
 *   failure or an unreadable success leaves the outcome open too, so the write must be looked for
 *   before it is sent again.
 */
export type CommentWriteFailure = "absent" | "rateLimited" | "unknown";

/** Classifies an error thrown by {@link DriveApi.createComment} or {@link DriveApi.createReply}. */
export function commentWriteFailure(error: unknown): CommentWriteFailure {
  if (error instanceof DriveApiDisabledError) return "absent";
  if (!(error instanceof DriveApiRequestError)) return "unknown";
  let { status, reason } = error;
  let rateLimited = status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason);
  if (status === 429 || rateLimited) return "rateLimited";
  // Google authenticates and authorizes before it acts. A 403 here is a refused permission or
  // scope, an invisible file, a domain policy, or `commentLengthLimitExceeded`; a 404 an absent
  // file or comment.
  if (status === 401 || status === 403 || status === 404) return "absent";
  return "unknown";
}

export class DriveApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  /** One page of matching files, most recently modified first by default. */
  async listFiles(options: DriveListFilesOptions = {}): Promise<DriveFileList> {
    let params = new URLSearchParams({
      q: buildDriveQuery(options),
      pageSize: String(options.pageSize ?? 100),
      fields: DRIVE_FILE_FIELDS,
      spaces: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (options.orderBy !== null) params.set("orderBy", options.orderBy ?? "modifiedTime desc");
    if (options.pageToken) params.set("pageToken", options.pageToken);
    let corpus = options.corpus ?? { kind: "user" };
    params.set("corpora", corpus.kind);
    if (corpus.kind === "drive") params.set("driveId", corpus.driveId);
    let body = await this.#getUnknown("/files", params);
    if (!isRecord(body)) throw new Error("Invalid Google Drive file-list response");
    // A cross-corpus search Drive could not finish is indistinguishable from a complete one.
    if (optionalBoolean(body.incompleteSearch, "incompleteSearch")) {
      throw new Error("Google Drive could not complete this search. Try again.");
    }
    let files: DriveFile[] = [];
    if (body.files !== undefined) {
      if (!Array.isArray(body.files)) throw new Error("Invalid Google Drive file-list response");
      files = body.files.map(parseDriveFile);
    }
    let nextPageToken = optionalString(body.nextPageToken, "nextPageToken");
    return { files, ...(nextPageToken ? { nextPageToken } : {}) };
  }

  /** Current metadata for one file. */
  async getFile(fileId: string): Promise<DriveFile> {
    let params = new URLSearchParams({ fields: DRIVE_FILE_ITEM_FIELDS, supportsAllDrives: "true" });
    return parseDriveFile(await this.#getUnknown(`/files/${encodeURIComponent(fileId)}`, params));
  }

  /** One page of the shared drives this account is a member of. */
  async listSharedDrives(options: { pageSize?: number; pageToken?: string } = {}):
      Promise<DriveSharedDriveList> {
    let params = new URLSearchParams({
      pageSize: String(options.pageSize ?? 100),
      fields: "nextPageToken,drives(id,name)",
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    let body = await this.#getUnknown("/drives", params);
    let rawDrives = isRecord(body) ? body.drives ?? [] : undefined;
    if (!isRecord(body) || !Array.isArray(rawDrives)) {
      throw new Error("Invalid Google Drive shared-drive list response");
    }
    let drives = rawDrives.map((drive: unknown) => {
      if (!isRecord(drive) || typeof drive.id !== "string" || typeof drive.name !== "string") {
        throw new Error("Invalid Google Drive shared drive");
      }
      return { id: drive.id, name: drive.name };
    });
    let nextPageToken = optionalString(body.nextPageToken, "nextPageToken");
    return { drives, ...(nextPageToken ? { nextPageToken } : {}) };
  }

  /**
   * One file's content as a stream, of whatever size. Nothing is buffered: the caller pulls the
   * body through, and cancels it to stop the download.
   */
  async openDownload(fileId: string): Promise<ReadableStream<Uint8Array>> {
    requireDriveFileId(fileId);
    let params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params}`, {},
      this.getAccessToken, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!response.ok) throw await driveError(response);
    return response.body ?? new ReadableStream({ start: controller => controller.close() });
  }

  /** Whether the connected account may edit a file's content, as Drive reports it. */
  async canEdit(fileId: string): Promise<boolean> {
    let params = new URLSearchParams({ fields: "capabilities(canEdit)", supportsAllDrives: "true" });
    let body = await this.#getUnknown(`/files/${encodeURIComponent(fileId)}`, params);
    let capabilities = isRecord(body) ? body.capabilities : undefined;
    if (capabilities !== undefined && !isRecord(capabilities)) {
      throw new Error("Invalid Google Drive file capabilities");
    }
    return optionalBoolean(capabilities?.canEdit, "file capabilities") === true;
  }

  /** What converting `fileId` needs to know about it. */
  async getConversionSource(fileId: string): Promise<DriveConversionSource> {
    let params = new URLSearchParams({ fields: CONVERSION_SOURCE_FIELDS, supportsAllDrives: "true" });
    return parseConversionSource(await this.#getUnknown(`/files/${encodeURIComponent(fileId)}`, params));
  }

  /** A copy {@link copyAsNative} may have made, with the app properties that say what from. */
  async getConvertedCopy(fileId: string): Promise<DriveConvertedCopy> {
    let params = new URLSearchParams({ fields: CONVERTED_COPY_FIELDS, supportsAllDrives: "true" });
    return parseConvertedCopy(await this.#getUnknown(`/files/${encodeURIComponent(fileId)}`, params));
  }

  /**
   * Untrashed native copies of `sourceId` this OAuth client made that the account can edit, newest
   * first. App properties are private to the client that set them, so another app's copies never
   * match; they are not private to a user, so a copy another user of this client made in a folder
   * the account can see may match too. Edit access only ensures that edits to the copy work.
   */
  async findConvertedCopies(sourceId: string, nativeMimeType: string): Promise<DriveConvertedCopy[]> {
    let params = new URLSearchParams({
      q: buildDriveQuery({ mimeType: nativeMimeType }, { convertedFrom: sourceId }),
      pageSize: "10",
      orderBy: "createdTime desc",
      fields: `files(${CONVERTED_COPY_FIELDS})`,
      spaces: "drive",
      corpora: "allDrives",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    let body = await this.#getUnknown("/files", params);
    if (!isRecord(body)) throw new Error("Invalid Google Drive file-list response");
    if (body.files === undefined) return [];
    if (!Array.isArray(body.files)) throw new Error("Invalid Google Drive file-list response");
    return body.files.map(parseConvertedCopy).filter(copy =>
      copy.appProperties?.[CONVERTED_FROM_PROPERTY] === sourceId &&
      copy.mimeType === nativeMimeType && copy.trashed !== true && copy.canEdit === true);
  }

  /** Whether the connected account may add files to folder `folderId`, as Drive reports it. */
  async canAddChildren(folderId: string): Promise<boolean> {
    let params = new URLSearchParams({
      fields: "capabilities(canAddChildren)", supportsAllDrives: "true",
    });
    let body = await this.#getUnknown(`/files/${encodeURIComponent(folderId)}`, params);
    let capabilities = isRecord(body) ? body.capabilities : undefined;
    if (capabilities !== undefined && !isRecord(capabilities)) {
      throw new Error("Invalid Google Drive file capabilities");
    }
    return optionalBoolean(capabilities?.canAddChildren, "file capabilities") === true;
  }

  /** The largest file, in bytes, Drive converts into native `mimeType`, if it says. */
  async getMaxImportSize(mimeType: string): Promise<number | undefined> {
    let body = await this.#getUnknown("/about", new URLSearchParams({ fields: "maxImportSizes" }));
    let sizes = isRecord(body) ? body.maxImportSizes : undefined;
    if (!isRecord(sizes)) return undefined;
    let size = Number(optionalString(sizes[mimeType], "maxImportSizes"));
    return Number.isSafeInteger(size) && size > 0 ? size : undefined;
  }

  /**
   * Copies `fileId` into a file of native `mimeType`, which Drive converts, in folder `parents`.
   * The folder is always named: Drive gives a copy without parents the original's.
   *
   * Never replayed on a 5xx or a network error: a lost response may still have made a copy, and a
   * replay would make a second. {@link findConvertedCopies} is the recovery.
   */
  async copyAsNative(fileId: string, copy: {
    name: string;
    mimeType: string;
    parents: string[];
    appProperties: Record<string, string>;
  }): Promise<DriveConvertedCopy> {
    let params = new URLSearchParams({ supportsAllDrives: "true", fields: CONVERTED_COPY_FIELDS });
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/copy?${params}`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          name: copy.name,
          mimeType: copy.mimeType,
          parents: copy.parents,
          appProperties: copy.appProperties,
        }),
      },
      this.getAccessToken);
    if (!response.ok) throw await driveError(response);
    let text = await readBoundedText(
      response, MAX_JSON_RESPONSE_BYTES, "Google Drive response was too large");
    let made = parseConvertedCopy(parseDriveJson(text, "response"));
    if (made.mimeType !== copy.mimeType) {
      throw new Error("Google Drive made a copy of a different type than was asked for");
    }
    return made;
  }

  /**
   * Converts `source` into a native file named `name`, beside the original when its folder takes
   * new files and in My Drive's root otherwise, tagged with the app properties that let a later
   * lookup find it.
   *
   * The folder is chosen from its `canAddChildren`, not from a failed copy, and always named: a
   * copy without parents would inherit the original's. A source larger than Drive imports into
   * `mimeType` is refused before anything is copied; when Drive's limit cannot be read, the copy
   * is attempted and Drive decides.
   */
  async makeNativeCopy(source: DriveConversionSource, name: string, mimeType: string)
      : Promise<{ copy: DriveConvertedCopy; location: DriveCopyLocation }> {
    let size = source.size === undefined ? NaN : Number(source.size);
    if (Number.isFinite(size)) {
      let max = await this.getMaxImportSize(mimeType).catch((error: unknown) => {
        logger.warn("could not read Drive's import size limit; copying without the check", {
          event: "google.office.import-size.unavailable", fileId: source.id,
          ...(error instanceof DriveApiRequestError ? {
            httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}),
          } : { error }),
        });
        return undefined;
      });
      if (max !== undefined && size > max) {
        throw new Error(
          `This file is ${megabytes(size)} MB, larger than the ${megabytes(max)} MB Google Drive ` +
          "converts into this format.");
      }
    }
    let parent = source.parents?.[0];
    let besideOriginal = parent !== undefined && await this.canAddChildren(parent).catch(() => false);
    let copy = await this.copyAsNative(source.id, {
      name,
      mimeType,
      parents: [besideOriginal ? parent! : MY_DRIVE_ROOT],
      appProperties: {
        [CONVERTED_FROM_PROPERTY]: source.id,
        ...(source.modifiedTime ? { [SOURCE_MODIFIED_PROPERTY]: source.modifiedTime } : {}),
      },
    });
    return { copy, location: besideOriginal ? "besideOriginal" : "myDrive" };
  }

  /** Whether the connected account may comment on a file, as Drive reports it. */
  async canComment(fileId: string): Promise<boolean> {
    requireDriveFileId(fileId);
    let params = new URLSearchParams({
      fields: "capabilities(canComment)", supportsAllDrives: "true",
    });
    let body = await this.#getUnknown(`/files/${encodeURIComponent(fileId)}`, params);
    if (!isRecord(body)) throw new Error("Invalid Google Drive file response");
    return optionalCapability(body.capabilities, "canComment") === true;
  }

  /**
   * One page of a file's comments, deleted ones left out. `startModifiedTime` (RFC 3339) keeps
   * only comments modified at or after it, a reply counting as a modification of its comment.
   */
  async listComments(
    fileId: string, options: { pageToken?: string; startModifiedTime?: string } = {},
  ): Promise<DriveCommentList> {
    requireDriveFileId(fileId);
    let params = new URLSearchParams({
      pageSize: "100", fields: `nextPageToken,comments(${COMMENT_FIELDS})`,
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (options.startModifiedTime) params.set("startModifiedTime", options.startModifiedTime);
    return parseListPage(
      await this.#getUnknown(`/files/${encodeURIComponent(fileId)}/comments`, params),
      "comments", parseComment);
  }

  /** One comment and its replies. */
  async getComment(fileId: string, commentId: string): Promise<DriveCommentRecord> {
    requireDriveFileId(fileId);
    requireDriveCommentId(commentId);
    let params = new URLSearchParams({ fields: COMMENT_FIELDS });
    let comment = parseComment(await this.#getUnknown(
      `/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}`, params));
    if (comment.id !== commentId) throw new Error("Google Drive returned a different comment");
    return comment;
  }

  /** One page of a comment's replies, deleted ones left out. */
  async listReplies(fileId: string, commentId: string, options: { pageToken?: string } = {})
      : Promise<DriveReplyList> {
    requireDriveFileId(fileId);
    requireDriveCommentId(commentId);
    let params = new URLSearchParams({
      pageSize: "100", fields: `nextPageToken,replies(${REPLY_FIELDS})`,
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    return parseListPage(
      await this.#getUnknown(
        `/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies`,
        params),
      "replies", parseReply);
  }

  /**
   * Posts a plain comment on a file. Never anchored and never quoting the file: Docs shows a
   * comment carrying either as "Original content deleted".
   *
   * Never replayed: an error does not prove nothing was posted (see {@link commentWriteFailure}).
   */
  async createComment(fileId: string, content: string): Promise<DriveCommentRecord> {
    requireDriveFileId(fileId);
    checkCommentContent(content);
    return parseComment(await this.#postJson(
      `/files/${encodeURIComponent(fileId)}/comments`, COMMENT_FIELDS, { content }));
  }

  /**
   * Posts a reply to a comment, or resolves it with `action: "resolve"`, in which case `content`
   * may be left out and Drive stores `""`. A plain reply to a resolved comment reopens it.
   *
   * Never replayed: an error does not prove nothing was posted (see {@link commentWriteFailure}).
   */
  async createReply(
    fileId: string, commentId: string, reply: { content?: string; action?: "resolve" },
  ): Promise<DriveReplyRecord> {
    requireDriveFileId(fileId);
    requireDriveCommentId(commentId);
    // Only a resolve may go without content.
    if (reply.content !== undefined || reply.action !== "resolve") {
      checkCommentContent(reply.content ?? "", "reply");
    }
    return parseReply(await this.#postJson(
      `/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies`,
      REPLY_FIELDS,
      {
        ...(reply.content === undefined ? {} : { content: reply.content }),
        ...(reply.action === undefined ? {} : { action: reply.action }),
      }));
  }

  /**
   * Fresh access checks for typed file, folder and comments disclosure units. A comments unit
   * passes only when this account may comment on the file, so a collaborator who can only view it
   * is never admitted to its comments.
   */
  async checkObservations(observations: readonly DriveObservation[]): Promise<boolean[]> {
    return this.#batchGetFiles(
      observations.map(observation => observation.fileId),
      DRIVE_SCOPE_NODE_FIELDS,
      (part, _fileId, index) => {
        if (!batchPartAllowed(part)) return false;
        let observation = observations[index];
        switch (observation.kind) {
          case "file": return true;
          case "folder":
            return isListableFolderNode(parseDriveScopeNode(part.body, observation.fileId));
          case "comments":
            return parseDriveScopeNode(part.body, observation.fileId).canComment === true;
        }
      },
    );
  }

  /**
   * Fresh ancestry facts for a folder-scope proof, in the requested order.
   *
   * `undefined` marks a file-specific denial (403/404). API disabled, quota, an account-wide policy
   * block, malformed multipart, a bad Content-ID, and a body answering for another file all throw,
   * so none of them can be read as "not a descendant" and quietly narrow a listing. A 403 whose
   * reason Google does not document as account-wide still counts as a denial.
   */
  async getScopeNodes(fileIds: readonly string[]): Promise<(DriveScopeNode | undefined)[]> {
    return this.#batchGetFiles(fileIds, DRIVE_SCOPE_NODE_FIELDS, (part, fileId) =>
      batchPartAllowed(part) ? parseDriveScopeNode(part.body, fileId) : undefined);
  }

  /** Runs `files.get` batches of at most 100 IDs, mapping each placed part back to its ID. */
  async #batchGetFiles<T>(
    fileIds: readonly string[],
    fields: string,
    mapPart: (part: BatchAccessPart, fileId: string, index: number) => T,
  ): Promise<T[]> {
    let result: T[] = [];
    for (let offset = 0; offset < fileIds.length; offset += MAX_BATCH_FILES) {
      let chunk = fileIds.slice(offset, offset + MAX_BATCH_FILES);
      let parts = await this.#batchGetChunk(chunk, fields);
      result.push(...parts.map((part, index) => mapPart(part, chunk[index], offset + index)));
    }
    return result;
  }

  async #batchGetChunk(
    fileIds: readonly string[], fields: string,
  ): Promise<BatchAccessPart[]> {
    let boundary = `gadgets_drive_${crypto.randomUUID()}`;
    let parts = fileIds.map((fileId, index) => [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <item-${index}>`,
      "",
      `GET /drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}` +
        "&supportsAllDrives=true HTTP/1.1",
      "Accept: application/json",
      "",
      "",
    ].join("\r\n"));
    let body = `${parts.join("")}--${boundary}--\r\n`;

    // Capture the token this batch actually sent so an inner 401 can invalidate the same cache
    // entry `fetchWithAuthRetry` would have refreshed, had the outer POST not been 200.
    let lastToken: string | undefined;
    let getToken: AccessTokenProvider = async opts => {
      lastToken = await this.getAccessToken(opts);
      return lastToken;
    };

    let replayed = false;
    for (;;) {
      let response = await fetchWithAuthRetry(DRIVE_BATCH_URL, {
        method: "POST",
        headers: {
          Accept: "multipart/mixed",
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
        },
        body,
      }, getToken, { idempotent: true });
      if (!response.ok) throw await driveError(response);

      let placed = await parseBatchAccessParts(response, fileIds.length);
      if (placed.some(part => part.status === 401)) {
        // The batch POST itself returns 200 when a subrequest 401s, so fetchWithAuthRetry's
        // one-shot refresh never sees it and a stale cached token would deny every file forever.
        // Force the same cache invalidation the helper uses, then replay the (read-only) batch once.
        if (replayed) {
          throw new Error("Google Drive batch subrequest failed: 401");
        }
        replayed = true;
        await this.getAccessToken({ forceRefresh: true, staleToken: lastToken });
        continue;
      }

      return placed;
    }
  }

  /** A write, sent once with its own timeout and read back through `fields`. */
  async #postJson(path: string, fields: string, body: Record<string, unknown>): Promise<unknown> {
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}${path}?${new URLSearchParams({ fields })}`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.getAccessToken, { timeoutMs: COMMENT_WRITE_TIMEOUT_MS });
    if (!response.ok) throw await driveError(response);
    let text = await readBoundedText(
      response, MAX_JSON_RESPONSE_BYTES, "Google Drive response was too large");
    return parseDriveJson(text, "response");
  }

  async #getUnknown(path: string, params: URLSearchParams): Promise<unknown> {
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}${path}?${params}`,
      { headers: { Accept: "application/json" } },
      this.getAccessToken);
    if (!response.ok) throw await driveError(response);
    let text = await readBoundedText(
      response, MAX_JSON_RESPONSE_BYTES, "Google Drive response was too large");
    return parseDriveJson(text, "response");
  }
}
