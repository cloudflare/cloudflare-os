/**
 * Google Drive's files as far as reaching native files through a Drive binding needs them: file
 * metadata, the batched scope reads a binding proves its reach with, and capabilities.
 */

import type { ProviderFake } from "./slides-provider";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DOC_MIME = "application/vnd.google-apps.document";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const SLIDES_MIME = "application/vnd.google-apps.presentation";

/** One file or folder. A capability that is a function is read when Drive is asked. */
export type FakeDriveFile = {
  name: string;
  mimeType: string;
  parents: string[];
  trashed?: boolean;
  canEdit?: boolean | (() => boolean);
  canComment?: boolean;
};

/** A request held until the test releases it. */
export type Hold = { reached: Promise<void>; release(): void };

export class DriveFiles implements ProviderFake {
  readonly files: Map<string, FakeDriveFile>;
  /** Every request, as `GET <path>` or `BATCH <ids>`. */
  readonly requests: string[] = [];
  #held?: { reach(): void; released: Promise<void> };

  constructor(files: Record<string, FakeDriveFile>) {
    this.files = new Map(Object.entries(files));
  }

  /** Holds the next batched scope read open until released. */
  holdNextBatch(): Hold {
    let reached = Promise.withResolvers<void>();
    let released = Promise.withResolvers<void>();
    this.#held = { reach: reached.resolve, released: released.promise };
    return { reached: reached.promise, release: released.resolve };
  }

  /** The batched scope reads made, each as the IDs it asked for. */
  batches(): string[][] {
    return this.requests.filter(request => request.startsWith("BATCH "))
      .map(request => request.slice("BATCH ".length).split(","));
  }

  async handle(request: Request): Promise<Response | undefined> {
    let url = new URL(request.url);
    if (url.hostname !== "www.googleapis.com") return undefined;
    if (url.pathname === "/batch/drive/v3") {
      let body = new TextDecoder().decode(await request.arrayBuffer());
      let ids = [...body.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)]
        .map(match => decodeURIComponent(match[1]));
      this.requests.push(`BATCH ${ids.join(",")}`);
      let held = this.#held;
      if (held) {
        this.#held = undefined;
        held.reach();
        await held.released;
      }
      return this.#batch(ids);
    }
    let match = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (!match) return undefined;
    this.requests.push(`GET ${url.pathname}`);
    let fileId = decodeURIComponent(match[1]);
    let file = this.files.get(fileId);
    if (!file) {
      return Response.json({
        error: { code: 404, message: `File not found: ${fileId}.`, errors: [{ reason: "notFound" }] },
      }, { status: 404 });
    }
    return Response.json(this.#json(fileId, file));
  }

  #json(id: string, file: FakeDriveFile) {
    let folder = file.mimeType === FOLDER_MIME;
    let canEdit = typeof file.canEdit === "function" ? file.canEdit() : file.canEdit ?? true;
    return {
      id, name: file.name, mimeType: file.mimeType, modifiedTime: "2026-10-20T09:00:00Z",
      parents: file.parents, trashed: file.trashed ?? false,
      capabilities: {
        canListChildren: folder, canComment: file.canComment ?? !folder, canEdit, canShare: true,
        canAddChildren: folder, canMoveItemWithinDrive: true,
      },
    };
  }

  #batch(ids: string[]): Response {
    let boundary = "drive_files_batch";
    let parts = ids.map((id, index) => {
      let file = this.files.get(id);
      return [
        `--${boundary}`, "Content-Type: application/http", `Content-ID: <response-item-${index}>`,
        "", file ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found", "Content-Type: application/json",
        "", file ? JSON.stringify(this.#json(id, file)) : "{}",
      ].join("\r\n");
    });
    return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
    });
  }
}
