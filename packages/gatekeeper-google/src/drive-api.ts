// Structured Google Drive API client shared by configurators, sessions, and observer verification.

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { obsContext } from "./observability";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_BATCH_URL = "https://www.googleapis.com/batch/drive/v3";
const MAX_BATCH_FILES = 100;
const MAX_BATCH_RESPONSE_BYTES = 1_000_000;
const MAX_JSON_RESPONSE_BYTES = 5_000_000;
const DRIVE_API_TIMEOUT_MS = 30_000;
const CREATION_REQUEST_PROPERTY = "gadgetsCreationRequestId";
const MAX_CREATION_MARKER_PAGES = 100;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive-api", vendorId: "google",
});

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
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  trashed?: boolean;
  appProperties?: { gadgetsCreationRequestId?: string };
  capabilities?: { canAddChildren?: boolean; canTrash?: boolean };
};

/** Whether current metadata proves that this OAuth client created the file. */
export function hasDriveCreationMarker(file: DriveFile): boolean {
  let requestId = file.appProperties?.[CREATION_REQUEST_PROPERTY];
  return requestId !== undefined && UUID_V4_PATTERN.test(requestId);
}

/** Current metadata for one shared drive. */
export type DriveInfo = { id: string; name: string };

const DRIVE_FILE_ITEM_FIELDS = [
  "id", "name", "mimeType", "modifiedTime", "size", "parents", "driveId",
  "owners(displayName,emailAddress)", "webViewLink",
  "shortcutDetails(targetId,targetMimeType)", "trashed", "appProperties",
  "capabilities(canAddChildren,canTrash)",
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
  nameContains?: string;
  fullTextContains?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  directParentId?: string;
};

export type DriveListFilesOptions = DriveFileQuery & {
  pageSize?: number;
  pageToken?: string;
  /** `null` preserves Drive's relevance ordering for full-text search. */
  orderBy?: string | null;
  corpora?: "user" | "drive";
  driveId?: string;
};

export type DriveFileList = { files: DriveFile[]; nextPageToken?: string };
export type DriveListDrivesOptions = { pageSize?: number; pageToken?: string; nameContains?: string };
export type DriveList = { drives: DriveInfo[]; nextPageToken?: string };

/** Metadata-only native Drive file creation parameters. */
export type DriveCreateFileOptions = {
  /** Name sent to Drive without display sanitization. */
  name: string;
  /** Native Google MIME type for the new item. */
  mimeType: string;
  /** Already-authorized immutable destination folder ID. */
  parentId: string;
  /** Gatekeeper-generated UUID used as a private idempotency marker. */
  requestId: string;
};

/** Drive refused because the API is not enabled on this OAuth project. */
export class DriveApiDisabledError extends Error {}

const MAX_ERROR_BODY_BYTES = 4096;
const API_DISABLED_REASON = "accessNotConfigured";
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

async function driveError(response: Response, operation: string): Promise<Error> {
  let reason = await errorReason(response);
  logger.warn("Google Drive API request failed", {
    event: "google.drive.api.request.failed", provider: "Google Drive", operation,
    httpStatus: response.status, ...(reason ? { providerReasons: [reason] } : {}),
  });
  if (response.status === 403 && reason === API_DISABLED_REASON) {
    return new DriveApiDisabledError(
      "the Google Drive API is not enabled for this OAuth project");
  }
  return new Error(
    `Google Drive API request failed: ${response.status}${reason ? ` (${reason})` : ""}`);
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

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid Google Drive ${field}`);
  let result: string[] = [];
  for (let item of value) {
    if (typeof item !== "string") throw new Error(`Invalid Google Drive ${field}`);
    result.push(item);
  }
  return result;
}

function parseDriveCapabilities(value: unknown): DriveFile["capabilities"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid Google Drive file capabilities");
  let canAddChildren = optionalBoolean(value.canAddChildren, "file capability canAddChildren");
  let canTrash = optionalBoolean(value.canTrash, "file capability canTrash");
  return {
    ...(canAddChildren === undefined ? {} : { canAddChildren }),
    ...(canTrash === undefined ? {} : { canTrash }),
  };
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
  let parents = optionalStringArray(value.parents, "file parents");
  let trashed = optionalBoolean(value.trashed, "file trashed state");
  let appProperties: DriveFile["appProperties"];
  if (value.appProperties !== undefined) {
    if (!isRecord(value.appProperties)) throw new Error("Invalid Google Drive app properties");
    let requestId = optionalString(
      value.appProperties[CREATION_REQUEST_PROPERTY], "creation request app property",
    );
    appProperties = requestId ? { [CREATION_REQUEST_PROPERTY]: requestId } : {};
  }
  let capabilities = parseDriveCapabilities(value.capabilities);
  return {
    id: value.id,
    name: value.name,
    ...optionalFields(value, [
      "mimeType", "modifiedTime", "size", "driveId", "webViewLink",
    ]),
    ...(parents ? { parents } : {}),
    ...(owners ? { owners } : {}),
    ...(shortcutDetails ? { shortcutDetails } : {}),
    ...(trashed === undefined ? {} : { trashed }),
    ...(appProperties ? { appProperties } : {}),
    ...(capabilities ? { capabilities } : {}),
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
  let backslash = String.fromCharCode(92);
  return value.replaceAll(backslash, backslash + backslash).replaceAll("'", backslash + "'");
}

function literalClause(field: string, operator: string, value: string): string {
  return `${field} ${operator} '${escapeDriveQueryLiteral(value)}'`;
}

function validateCreationRequestId(requestId: string): void {
  if (!UUID_V4_PATTERN.test(requestId)) {
    throw new Error("Invalid Google Drive creation request ID");
  }
}

/** Assembles a Drive `q` from structured values. Trashed files are always excluded. */
export function buildDriveQuery(query: DriveFileQuery): string {
  let clauses = ["trashed = false"];
  let mimeTypes = query.mimeTypes?.map(value => value.trim()).filter(Boolean);
  if (!mimeTypes?.length && query.mimeType?.trim()) {
    clauses.push(literalClause("mimeType", "=", query.mimeType.trim()));
  }
  let name = query.nameContains?.trim();
  if (name) clauses.push(literalClause("name", "contains", name));
  let fullText = query.fullTextContains?.trim();
  if (fullText) clauses.push(literalClause("fullText", "contains", fullText));
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
    if (options.corpora) params.set("corpora", options.corpora);
    if (options.driveId) params.set("driveId", options.driveId);
    let body = await this.#getUnknown("/files", params, "list files");
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
    return parseDriveFile(await this.#getUnknown(
      `/files/${encodeURIComponent(fileId)}`, params, "get file"));
  }

  /** Create one blank native Drive item in an already-authorized parent. */
  async createFile(options: DriveCreateFileOptions): Promise<DriveFile> {
    validateCreationRequestId(options.requestId);
    let params = new URLSearchParams({
      fields: DRIVE_FILE_ITEM_FIELDS, supportsAllDrives: "true",
      ignoreDefaultVisibility: "true",
    });
    let body = {
      name: options.name,
      mimeType: options.mimeType,
      parents: [options.parentId],
      appProperties: { [CREATION_REQUEST_PROPERTY]: options.requestId },
    };
    return parseDriveFile(await this.#requestUnknown("/files", params, "create file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  /** Find the sole file carrying a gatekeeper-generated creation marker. */
  async findFileByCreationRequestId(requestId: string): Promise<DriveFile | undefined> {
    validateCreationRequestId(requestId);
    let params = new URLSearchParams({
      q: `appProperties has { key='${CREATION_REQUEST_PROPERTY}' and value='${requestId}' }`,
      pageSize: "2",
      fields: DRIVE_FILE_FIELDS,
      spaces: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    let found: DriveFile | undefined;
    for (let page = 0; page < MAX_CREATION_MARKER_PAGES; page++) {
      let body = await this.#getUnknown("/files", params, "find created file");
      if (!isRecord(body)) throw new Error("Invalid Google Drive file-list response");
      if (body.files !== undefined) {
        if (!Array.isArray(body.files)) throw new Error("Invalid Google Drive file-list response");
        for (let value of body.files) {
          let file = parseDriveFile(value);
          if (found) {
            throw new Error("Multiple Google Drive files matched one creation request");
          }
          found = file;
        }
      }
      let nextPageToken = optionalString(body.nextPageToken, "nextPageToken");
      if (!nextPageToken) return found;
      params.set("pageToken", nextPageToken);
    }
    throw new Error("Google Drive creation marker lookup exceeded its page limit");
  }

  /** Move one Drive item to trash. */
  async trashFile(fileId: string): Promise<void> {
    let params = new URLSearchParams({ fields: DRIVE_FILE_ITEM_FIELDS, supportsAllDrives: "true" });
    let file = parseDriveFile(await this.#requestUnknown(
      `/files/${encodeURIComponent(fileId)}`, params, "trash file", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      }));
    if (file.trashed !== true) throw new Error("Google Drive did not trash the requested file");
  }

  /** Current metadata for one shared drive. */
  async getDrive(driveId: string): Promise<DriveInfo> {
    let params = new URLSearchParams({ fields: "id,name" });
    return parseDriveInfo(await this.#getUnknown(
      `/drives/${encodeURIComponent(driveId)}`, params, "get shared drive"));
  }

  /** One page of shared drives visible to the connected account. */
  async listDrives(options: DriveListDrivesOptions = {}): Promise<DriveList> {
    let params = new URLSearchParams({
      pageSize: String(options.pageSize ?? 100), fields: "nextPageToken,drives(id,name)",
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (options.nameContains?.trim()) {
      params.set("q", literalClause("name", "contains", options.nameContains.trim()));
    }
    let body = await this.#getUnknown("/drives", params, "list shared drives");
    if (!isRecord(body)) throw new Error("Invalid Google shared-drive list response");
    let drives: DriveInfo[] = [];
    if (body.drives !== undefined) {
      if (!Array.isArray(body.drives)) throw new Error("Invalid Google shared-drive list response");
      drives = body.drives.map(parseDriveInfo);
    }
    let nextPageToken = optionalString(body.nextPageToken, "nextPageToken");
    return { drives, ...(nextPageToken ? { nextPageToken } : {}) };
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
    let response = await fetchWithAuthRetry(DRIVE_BATCH_URL, {
      method: "POST",
      headers: {
        Accept: "multipart/mixed",
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body,
    }, this.getAccessToken, { timeoutMs: DRIVE_API_TIMEOUT_MS });
    if (!response.ok) throw await driveError(response, "check file access");

    let contentType = response.headers.get("Content-Type") ?? "";
    let responseBoundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
    if (!responseBoundary) throw new Error("Invalid Google Drive batch response boundary");
    let text = await readBoundedText(
      response, MAX_BATCH_RESPONSE_BYTES, "Google Drive batch response was too large");
    let responseParts = text.split(`--${responseBoundary}`).filter(part => /HTTP\/1\.[01] \d{3}/.test(part));
    if (responseParts.length !== fileIds.length) {
      throw new Error("Google Drive batch response did not contain one result per file");
    }
    return responseParts.map(part => {
      let status = Number(/HTTP\/1\.[01] (\d{3})/.exec(part)?.[1]);
      if (status >= 200 && status < 300) return true;
      let reason = googleErrorReasonFromText(part.split(/\r?\n\r?\n/).at(-1) ?? "");
      if (status === 403 && reason === API_DISABLED_REASON) {
        throw new DriveApiDisabledError(
          "the Google Drive API is not enabled for this OAuth project");
      }
      if (status === 401 || status === 403 || status === 404) return false;
      throw new Error(`Google Drive batch subrequest failed: ${status}`);
    });
  }

  async #getUnknown(
    path: string, params: URLSearchParams, operation: string,
  ): Promise<unknown> {
    return this.#requestUnknown(path, params, operation);
  }

  async #requestUnknown(
    path: string,
    params: URLSearchParams,
    operation: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    let headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}${path}?${params}`,
      { ...init, headers },
      this.getAccessToken,
      { timeoutMs: DRIVE_API_TIMEOUT_MS },
    );
    if (!response.ok) throw await driveError(response, operation);
    let text = await readBoundedText(
      response, MAX_JSON_RESPONSE_BYTES, "Google Drive response was too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid Google Drive JSON response");
    }
  }
}
