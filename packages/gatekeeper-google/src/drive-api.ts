import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import type { DriveFileInfo, DriveFolderInfo } from "./sheets-types";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

type DriveRestFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  trashed?: boolean;
};

type GoogleErrorResponse = { error?: { message?: string } };

async function responseText(response: Response): Promise<string> {
  let declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google Drive response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
  }
  if (!response.body) return "";
  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      let { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`Google Drive response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let bytes = new Uint8Array(length);
  let offset = 0;
  for (let chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function responseJson<T>(response: Response): Promise<T> {
  let text = await responseText(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(`Google Drive request failed [http=${response.status}]`);
    throw new Error("Google Drive returned an invalid JSON response.");
  }
  if (!response.ok) {
    let message = (body as GoogleErrorResponse)?.error?.message;
    throw new Error(
      `Google Drive request failed [http=${response.status}]${message ? `: ${message}` : ""}`,
    );
  }
  return body as T;
}

function normalizeFile(file: DriveRestFile): DriveFileInfo {
  if (!file.id || !file.name || !file.mimeType) {
    throw new Error("Google Drive returned incomplete file metadata.");
  }
  let parsedSize = file.size === undefined ? undefined : Number(file.size);
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ...(Number.isSafeInteger(parsedSize) && parsedSize! >= 0 ? { size: parsedSize } : {}),
    ...(file.modifiedTime ? { modifiedTime: new Date(file.modifiedTime) } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
  };
}

export class GoogleDriveApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T>(url: URL, init: RequestInit = {}): Promise<T> {
    let response = await fetchWithAuthRetry(
      url.toString(), init, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    return responseJson<T>(response);
  }

  async getFolder(folderId: string): Promise<DriveFolderInfo> {
    let url = new URL(`${DRIVE_API_BASE}/${encodeURIComponent(folderId)}`);
    url.searchParams.set("fields", "id,name,mimeType,webViewLink,trashed");
    url.searchParams.set("supportsAllDrives", "true");
    let folder = await this.#request<DriveRestFile>(url);
    if (folder.trashed || folder.mimeType !== GOOGLE_FOLDER_MIME_TYPE || !folder.id || !folder.name) {
      throw new Error("The connected Google Drive resource is not an active folder.");
    }
    return {
      id: folder.id,
      name: folder.name,
      webViewLink: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folder.id}`,
    };
  }

  async listFiles(folderId: string, limit: number): Promise<DriveFileInfo[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Google Drive list limit must be an integer between 1 and 100.");
    }
    let url = new URL(DRIVE_API_BASE);
    url.searchParams.set("pageSize", String(limit));
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set(
      "fields",
      "files(id,name,mimeType,size,modifiedTime,webViewLink,trashed)",
    );
    let escapedFolderId = folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    url.searchParams.set("q", `'${escapedFolderId}' in parents and trashed = false`);
    let result = await this.#request<{ files?: DriveRestFile[] }>(url);
    return (result.files ?? []).map(normalizeFile);
  }

  async uploadFile(
    folderId: string,
    input: { name: string; mimeType: string; bytes: Uint8Array; convertToGoogleDoc: boolean },
  ): Promise<DriveFileInfo> {
    let boundary = `company_os_${crypto.randomUUID().replaceAll("-", "")}`;
    let metadata = {
      name: input.name,
      parents: [folderId],
      ...(input.convertToGoogleDoc ? { mimeType: GOOGLE_DOC_MIME_TYPE } : {}),
    };
    let prefix =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n--${boundary}\r\n` +
      `Content-Type: ${input.mimeType}\r\n\r\n`;
    let suffix = `\r\n--${boundary}--\r\n`;
    let byteBuffer = input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ) as ArrayBuffer;
    let body = new Blob([prefix, byteBuffer, suffix]);
    let url = new URL(DRIVE_UPLOAD_BASE);
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,webViewLink");
    return normalizeFile(await this.#request<DriveRestFile>(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }));
  }
}
