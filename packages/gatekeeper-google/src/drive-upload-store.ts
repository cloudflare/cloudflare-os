import type { DriveFileInfo, DriveUploadStatus } from "./sheets-types";

const MAX_PENDING_UPLOADS = 20;
const MAX_RETAINED_UPLOADS = 100;

type DriveUploadRow = {
  id: number;
  state: DriveUploadStatus["state"];
  name: string;
  mime_type: string;
  convert_to_google_doc: number;
  bytes: ArrayBuffer | null;
  byte_length: number;
  submitted_at: number;
  file_id: string | null;
  file_mime_type: string | null;
  file_size: number | null;
  file_modified_time: string | null;
  file_web_view_link: string | null;
  error: string | null;
};

export type StoredDriveUpload = {
  id: number;
  state: DriveUploadStatus["state"];
  name: string;
  mimeType: string;
  convertToGoogleDoc: boolean;
  bytes?: Uint8Array;
  byteLength: number;
  submittedAt: number;
  file?: DriveFileInfo;
  error?: string;
};

function fromRow(row: DriveUploadRow): StoredDriveUpload {
  let file = row.file_id && row.file_mime_type ? {
    id: row.file_id,
    name: row.name,
    mimeType: row.file_mime_type,
    ...(row.file_size === null ? {} : { size: row.file_size }),
    ...(row.file_modified_time ? { modifiedTime: new Date(row.file_modified_time) } : {}),
    ...(row.file_web_view_link ? { webViewLink: row.file_web_view_link } : {}),
  } satisfies DriveFileInfo : undefined;
  return {
    id: row.id,
    state: row.state,
    name: row.name,
    mimeType: row.mime_type,
    convertToGoogleDoc: row.convert_to_google_doc === 1,
    ...(row.bytes ? { bytes: new Uint8Array(row.bytes) } : {}),
    byteLength: row.byte_length,
    submittedAt: row.submitted_at,
    ...(file ? { file } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Durable, facet-local storage for approval-gated Drive upload bytes and outcomes. */
export class DriveUploadStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS drive_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'completed', 'rejected', 'failed')),
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      convert_to_google_doc INTEGER NOT NULL CHECK (convert_to_google_doc IN (0, 1)),
      bytes BLOB,
      byte_length INTEGER NOT NULL,
      submitted_at INTEGER NOT NULL,
      file_id TEXT,
      file_mime_type TEXT,
      file_size INTEGER,
      file_modified_time TEXT,
      file_web_view_link TEXT,
      error TEXT
    ) STRICT`);
    this.#prune();
  }

  get(id: number): StoredDriveUpload | undefined {
    let row = this.sql.exec<DriveUploadRow>(
      "SELECT * FROM drive_uploads WHERE id = ?", id,
    ).toArray()[0];
    return row && fromRow(row);
  }

  stage(input: {
    name: string;
    mimeType: string;
    convertToGoogleDoc: boolean;
    bytes: Uint8Array;
  }): StoredDriveUpload {
    let { count } = this.sql.exec<{ count: number }>(
      "SELECT count(*) AS count FROM drive_uploads WHERE state IN ('pending', 'applying')",
    ).one();
    if (count >= MAX_PENDING_UPLOADS) {
      throw new Error(
        `${MAX_PENDING_UPLOADS} Drive uploads are already pending. Approve or reject them before ` +
        "staging another upload.",
      );
    }
    let submittedAt = Date.now();
    let bytes = input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ) as ArrayBuffer;
    let { id } = this.sql.exec<{ id: number }>(
      `INSERT INTO drive_uploads (
        state, name, mime_type, convert_to_google_doc, bytes, byte_length, submitted_at
      ) VALUES ('pending', ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.name,
      input.mimeType,
      Number(input.convertToGoogleDoc),
      bytes,
      input.bytes.byteLength,
      submittedAt,
    ).one();
    return this.get(id)!;
  }

  claim(id: number): StoredDriveUpload {
    let upload = this.get(id);
    if (!upload) throw new Error(`Google Drive upload ${id} is unknown.`);
    if (upload.state === "completed") return upload;
    if (upload.state === "rejected") throw new Error(`Google Drive upload ${id} was rejected.`);
    if (upload.state === "applying") {
      throw new Error(
        `Google Drive upload ${id} was interrupted after dispatch and may have completed. ` +
        "Check the folder before staging another upload.",
      );
    }
    if (upload.state === "failed") {
      throw new Error(upload.error ?? `Google Drive upload ${id} failed.`);
    }
    if (!upload.bytes) throw new Error(`Google Drive upload ${id} has no staged file bytes.`);
    this.sql.exec("UPDATE drive_uploads SET state = 'applying' WHERE id = ?", id);
    return { ...upload, state: "applying" };
  }

  complete(id: number, file: DriveFileInfo): void {
    this.sql.exec(
      `UPDATE drive_uploads SET
        state = 'completed', bytes = NULL, file_id = ?, file_mime_type = ?, file_size = ?,
        file_modified_time = ?, file_web_view_link = ?, error = NULL
       WHERE id = ?`,
      file.id,
      file.mimeType,
      file.size ?? null,
      file.modifiedTime?.toISOString() ?? null,
      file.webViewLink ?? null,
      id,
    );
    this.#prune();
  }

  fail(id: number, error: string): void {
    this.sql.exec(
      "UPDATE drive_uploads SET state = 'failed', bytes = NULL, error = ? WHERE id = ?",
      error,
      id,
    );
    this.#prune();
  }

  reject(id: number): void {
    let upload = this.get(id);
    if (!upload || upload.state === "rejected") return;
    if (upload.state !== "pending") {
      throw new Error(`Google Drive upload ${id} is already ${upload.state}.`);
    }
    this.sql.exec(
      "UPDATE drive_uploads SET state = 'rejected', bytes = NULL WHERE id = ?",
      id,
    );
    this.#prune();
  }

  discard(id: number): void {
    this.sql.exec("DELETE FROM drive_uploads WHERE id = ? AND state = 'pending'", id);
  }

  #prune(): void {
    this.sql.exec(`DELETE FROM drive_uploads WHERE id IN (
      SELECT id FROM drive_uploads
      WHERE state NOT IN ('pending', 'applying')
      ORDER BY id DESC LIMIT -1 OFFSET ${MAX_RETAINED_UPLOADS}
    )`);
  }
}
