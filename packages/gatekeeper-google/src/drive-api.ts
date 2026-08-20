// Google Drive API client.
//
// Drive is reached from the resource configurator today, and from the Drive session later. Both go
// through here so neither bypasses the 401 refresh and 429 backoff in `fetchWithAuthRetry`.

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

/** The subset of Drive's file resource this gatekeeper asks for. */
export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
};

/** Drive returns only the fields it is asked for, so the mask and `DriveFile` travel together. */
export const DRIVE_FILE_FIELDS =
  "nextPageToken,files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress))";

/**
 * What to match. Every field is optional and they are AND-ed.
 *
 * Callers pass values, never query syntax: `q` is assembled here so nothing user-supplied can
 * introduce a clause of its own.
 */
export type DriveFileQuery = {
  mimeType?: string;
  nameContains?: string;
};

export type DriveListFilesOptions = DriveFileQuery & {
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
};

export type DriveFileList = {
  files: DriveFile[];
  /** Absent on the last page. */
  nextPageToken?: string;
};

/**
 * Drive refused because the Drive API is not enabled on this OAuth project.
 *
 * Distinguished from other 403s because it is the deployment admin's to fix, not the user's, and
 * callers word that differently.
 */
export class DriveApiDisabledError extends Error {}

/**
 * Escapes a value for interpolation into a Drive `q` string literal.
 *
 * Drive literals are single-quoted, and Google documents `\'` and `\\` as the escapes. Without
 * this, a file name containing a quote could close the literal and append clauses of its own —
 * which for a scoped binding means reading outside the scope.
 */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Assembles a Drive `q`. Trashed files are always excluded. */
export function buildDriveQuery({ mimeType, nameContains }: DriveFileQuery): string {
  let clauses = ["trashed = false"];
  if (mimeType) clauses.push(`mimeType = '${escapeDriveQueryLiteral(mimeType)}'`);
  let name = nameContains?.trim();
  if (name) clauses.push(`name contains '${escapeDriveQueryLiteral(name)}'`);
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
      orderBy: options.orderBy ?? "modifiedTime desc",
      // A file on a shared drive is an ordinary result as far as a binding is concerned.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);

    let body = await this.#get<{ files?: DriveFile[]; nextPageToken?: string }>("/files", params);
    return {
      files: body.files ?? [],
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  async #get<T>(path: string, params: URLSearchParams): Promise<T> {
    let response = await fetchWithAuthRetry(
      `${DRIVE_API_BASE}${path}?${params}`,
      { headers: { Accept: "application/json" } },
      this.getAccessToken);

    if (!response.ok) {
      let text = await response.text();
      if (response.status === 403 && text.includes("Google Drive API has not been used")) {
        throw new DriveApiDisabledError(
          "the Google Drive API is not enabled for this OAuth project");
      }
      throw new Error(`Google Drive API request failed: ${response.status} ${text}`);
    }
    return await response.json<T>();
  }
}
