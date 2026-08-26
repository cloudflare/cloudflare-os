// Structured Google Drive API client shared by configurators, sessions, and observer verification.

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_BATCH_URL = "https://www.googleapis.com/batch/drive/v3";
const MAX_BATCH_FILES = 100;
const MAX_BATCH_RESPONSE_BYTES = 1_000_000;
const MAX_JSON_RESPONSE_BYTES = 5_000_000;

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
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
};

/** Current metadata for one shared drive. */
export type DriveInfo = { id: string; name: string };

/** The per-file field mask. `getFile` sends this; {@link DRIVE_FILE_FIELDS} wraps it for lists. */
export const DRIVE_FILE_ITEM_FIELDS = [
  "id", "name", "mimeType", "modifiedTime", "size", "parents", "driveId", "trashed",
  "owners(displayName,emailAddress)", "webViewLink",
  "shortcutDetails(targetId,targetMimeType)",
].join(",");

/** Drive returns only requested fields, so this mask and {@link DriveFile} travel together. */
export const DRIVE_FILE_FIELDS = `nextPageToken,files(${DRIVE_FILE_ITEM_FIELDS})`;

/** Structured Drive search clauses. Every populated field is AND-ed. */
export type DriveFileQuery = {
  /** Single-type shorthand retained for configurator lookups. */
  mimeType?: string;
  mimeTypes?: string[];
  /** Internal configurator filter; not exposed to agents. */
  excludeMimeTypes?: string[];
  /** Name prefix; Drive spells its prefix-only operator `contains`. */
  namePrefix?: string;
  fullTextContains?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  directParentId?: string;
};

/**
 * Which corpus `listFiles` searches.
 *
 * One value rather than the provider's independent `corpora`/`driveId` pair: a shared-drive
 * binding's whole boundary is those two travelling together, and `driveId` without
 * `corpora: "drive"` silently falls back to the user corpus.
 */
export type DriveCorpus = { kind: "user" } | { kind: "drive"; driveId: string };

export type DriveListFilesOptions = DriveFileQuery & {
  pageSize?: number;
  pageToken?: string;
  /** `null` preserves Drive's relevance ordering for full-text search. */
  orderBy?: string | null;
  /** Defaults to the connected account's user corpus. */
  corpus?: DriveCorpus;
};

export type DriveFileList = { files: DriveFile[]; nextPageToken?: string };
export type DriveListDrivesOptions = { pageSize?: number; pageToken?: string; namePrefix?: string };
export type DriveList = { drives: DriveInfo[]; nextPageToken?: string };

/** Drive refused because the API is not enabled on this OAuth project. */
export class DriveApiDisabledError extends Error {}

/** Sanitized HTTP failure from the Google Drive API. */
export class DriveApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string,
  ) {
    super(`Google Drive API request failed: ${status}${reason ? ` (${reason})` : ""}`);
  }

  /** Whether this failure reports one of Google's documented quota reasons. */
  get isQuotaExceeded(): boolean {
    return this.status === 403 && this.reason !== undefined && QUOTA_403_REASONS.has(this.reason);
  }
}

const MAX_ERROR_BODY_BYTES = 4096;
const API_DISABLED_REASON = "accessNotConfigured";
const QUOTA_403_REASONS = new Set([
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
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
  let parents: string[] | undefined;
  if (value.parents !== undefined) {
    if (!Array.isArray(value.parents) || value.parents.some(parent => typeof parent !== "string")) {
      throw new Error("Invalid Google Drive file parents");
    }
    parents = value.parents as string[];
  }
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
    ...(shortcutDetails ? { shortcutDetails } : {}),
  };
}

function parseDriveInfo(value: unknown): DriveInfo {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    throw new Error("Invalid Google shared-drive response");
  }
  return { id: value.id, name: value.name };
}

/** Escapes a value for interpolation into a Drive `q` string literal. */
export function escapeDriveQueryLiteral(value: string): string {
  let backslash = "\\";
  return value.replaceAll(backslash, backslash + backslash).replaceAll("'", backslash + "'");
}

function literalClause(field: string, operator: string, value: string): string {
  return `${field} ${operator} '${escapeDriveQueryLiteral(value)}'`;
}

/** Assembles a Drive `q` from structured values. Trashed files are always excluded. */
export function buildDriveQuery(query: DriveFileQuery): string {
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
  for (let mimeType of query.excludeMimeTypes ?? []) {
    if (mimeType.trim()) clauses.push(literalClause("mimeType", "!=", mimeType.trim()));
  }
  if (query.modifiedAfter) clauses.push(literalClause("modifiedTime", ">", query.modifiedAfter));
  if (query.modifiedBefore) clauses.push(literalClause("modifiedTime", "<", query.modifiedBefore));
  if (query.directParentId?.trim()) {
    clauses.push(`'${escapeDriveQueryLiteral(query.directParentId.trim())}' in parents`);
  }
  return clauses.join(" and ");
}

type BatchAccessPart = { status: number; body: string };

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
    let status = Number(/HTTP\/1\.[01] (\d{3})/.exec(part)?.[1]);
    placed[index] = { status, body: part.split(/\r?\n\r?\n/).at(-1) ?? "" };
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
  if (part.status === 403 && reason !== undefined && QUOTA_403_REASONS.has(reason)) {
    throw new Error("Google Drive batch subrequest failed: 403");
  }
  if (part.status === 403 || part.status === 404) return false;
  throw new Error(`Google Drive batch subrequest failed: ${part.status}`);
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

  /** Current metadata for one shared drive. */
  async getDrive(driveId: string): Promise<DriveInfo> {
    let params = new URLSearchParams({ fields: "id,name" });
    return parseDriveInfo(await this.#getUnknown(`/drives/${encodeURIComponent(driveId)}`, params));
  }

  /** One page of shared drives visible to the connected account. */
  async listDrives(options: DriveListDrivesOptions = {}): Promise<DriveList> {
    let params = new URLSearchParams({
      pageSize: String(options.pageSize ?? 100), fields: "nextPageToken,drives(id,name)",
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (options.namePrefix?.trim()) {
      params.set("q", literalClause("name", "contains", options.namePrefix.trim()));
    }
    let body = await this.#getUnknown("/drives", params);
    if (!isRecord(body)) throw new Error("Invalid Google shared-drive list response");
    let drives: DriveInfo[] = [];
    if (body.drives !== undefined) {
      if (!Array.isArray(body.drives)) throw new Error("Invalid Google shared-drive list response");
      drives = body.drives.map(parseDriveInfo);
    }
    let nextPageToken = optionalString(body.nextPageToken, "nextPageToken");
    return { drives, ...(nextPageToken ? { nextPageToken } : {}) };
  }

  /** Every shared drive visible to the connected account. */
  async listAllDrives(
    options: Omit<DriveListDrivesOptions, "pageToken"> = {},
  ): Promise<DriveInfo[]> {
    let drives: DriveInfo[] = [];
    let pageToken: string | undefined;
    do {
      let page = await this.listDrives({
        ...options,
        ...(pageToken ? { pageToken } : {}),
      });
      drives.push(...page.drives);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return drives;
  }

  /** Fresh access checks, issued as multipart `files.get` batches of at most 100 IDs. */
  async checkFileAccess(fileIds: readonly string[]): Promise<boolean[]> {
    let result: boolean[] = [];
    for (let offset = 0; offset < fileIds.length; offset += MAX_BATCH_FILES) {
      result.push(...await this.#checkFileAccessBatch(fileIds.slice(offset, offset + MAX_BATCH_FILES)));
    }
    return result;
  }

  async #checkFileAccessBatch(fileIds: readonly string[]): Promise<boolean[]> {
    let boundary = `gadgets_drive_${crypto.randomUUID()}`;
    let parts = fileIds.map((fileId, index) => [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <item-${index}>`,
      "",
      `GET /drive/v3/files/${encodeURIComponent(fileId)}?fields=id&supportsAllDrives=true HTTP/1.1`,
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

      return placed.map(batchPartAllowed);
    }
  }

  async #getUnknown(path: string, params: URLSearchParams): Promise<unknown> {
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}${path}?${params}`,
      { headers: { Accept: "application/json" } },
      this.getAccessToken);
    if (!response.ok) throw await driveError(response);
    let text = await readBoundedText(
      response, MAX_JSON_RESPONSE_BYTES, "Google Drive response was too large");
    return JSON.parse(text);
  }
}
