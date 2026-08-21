import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CursorPager, type Pager } from "./cursor";
import type { DriveApi, DriveFile, DriveListFilesOptions } from "./drive-api";
import type { ObserverCheck } from "./observers";
import type {
  DriveEntry, DriveListOptions, DriveOrder, DriveScope, DriveSearchQuery,
} from "./drive-types";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

/** Immutable authority carried by one Drive gatekeeper binding. */
export type DriveBindingScope =
  | { kind: "account" }
  | { kind: "sharedDrive"; driveId: string }
  | { kind: "file"; fileId: string };

type DriveSessionApi = Pick<DriveApi, "listFiles" | "getFile" | "getDrive">;

type DriveSessionCoreOptions = {
  api: DriveSessionApi;
  scope: DriveBindingScope;
  prepareObservation?: (fileIds: string[]) => Promise<ObserverCheck<string>>;
  authorize(description: ObservationDescription): Promise<void>;
};

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Google Drive omitted required file ${field}`);
  return value;
}

/** Maps one validated provider file to the permanent agent-facing declaration. */
export function driveFileToEntry(file: DriveFile): DriveEntry {
  let mimeType = requiredString(file.mimeType, "mimeType");
  let isFolder = mimeType === FOLDER_MIME_TYPE;
  let isShortcut = mimeType === SHORTCUT_MIME_TYPE;
  let modifiedTime = new Date(requiredString(file.modifiedTime, "modifiedTime"));
  if (Number.isNaN(modifiedTime.valueOf())) throw new Error("Google Drive returned an invalid modifiedTime");

  let size: number | undefined;
  if (file.size !== undefined && !isFolder && !isShortcut) {
    size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Google Drive returned an invalid file size");
    }
  }
  let owner = file.driveId ? undefined : file.owners?.[0];
  let shortcut: DriveEntry["shortcut"];
  if (isShortcut && file.shortcutDetails) {
    shortcut = {
      targetId: requiredString(file.shortcutDetails.targetId, "shortcut targetId"),
      ...(file.shortcutDetails.targetMimeType ?
        { targetMimeType: file.shortcutDetails.targetMimeType } : {}),
    };
  }
  return {
    id: file.id,
    name: file.name,
    mimeType,
    isFolder,
    modifiedTime,
    ...(size === undefined ? {} : { size }),
    ...(owner ? {
      owner: {
        ...(owner.displayName ? { displayName: owner.displayName } : {}),
        ...(owner.emailAddress ? { emailAddress: owner.emailAddress } : {}),
      },
    } : {}),
    ...(file.parents?.[0] ? { parentId: file.parents[0] } : {}),
    ...(file.driveId ? { driveId: file.driveId } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
    ...(shortcut ? { shortcut } : {}),
  };
}

const ORDER_BY: Record<DriveOrder, string> = {
  modifiedTimeDesc: "modifiedTime desc",
  modifiedTimeAsc: "modifiedTime",
  nameAsc: "name",
  nameDesc: "name desc",
};

function orderBy(order: DriveOrder | undefined): string {
  if (order === undefined) return ORDER_BY.modifiedTimeDesc;
  let result = ORDER_BY[order];
  if (!result) throw new Error(`Unsupported Drive order: ${order}`);
  return result;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function timestamp(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an RFC 3339 timestamp`);
  }
  return value;
}

function normalizeSearch(query: DriveSearchQuery): DriveSearchQuery {
  let mimeTypes = query.mimeTypes?.map(value => value.trim()).filter(Boolean);
  let normalized: DriveSearchQuery = {
    ...(query.nameContains?.trim() ? { nameContains: query.nameContains.trim() } : {}),
    ...(query.fullTextContains?.trim() ? { fullTextContains: query.fullTextContains.trim() } : {}),
    ...(mimeTypes?.length ? { mimeTypes } : {}),
    ...(query.modifiedAfter ? { modifiedAfter: timestamp(query.modifiedAfter, "modifiedAfter") } : {}),
    ...(query.modifiedBefore ? { modifiedBefore: timestamp(query.modifiedBefore, "modifiedBefore") } : {}),
    ...(query.directParentId?.trim() ? { directParentId: query.directParentId.trim() } : {}),
    ...(query.order ? { order: query.order } : {}),
  };
  if (Object.keys(normalized).every(key => key === "order")) {
    throw new Error("Drive search requires at least one filter");
  }
  if (normalized.fullTextContains && normalized.order) {
    throw new Error("Drive full-text search cannot specify an order");
  }
  if (normalized.modifiedAfter && normalized.modifiedBefore &&
      Date.parse(normalized.modifiedAfter) >= Date.parse(normalized.modifiedBefore)) {
    throw new Error("modifiedAfter must be earlier than modifiedBefore");
  }
  return normalized;
}

/** Scope enforcement, pagination, mapping, and observation authorization for Drive sessions. */
export class DriveSessionCore {
  #api: DriveSessionApi;
  #scope: DriveBindingScope;
  #prepareObservation: (fileIds: string[]) => Promise<ObserverCheck<string>>;
  #authorize: (description: ObservationDescription) => Promise<void>;

  constructor(options: DriveSessionCoreOptions) {
    this.#api = options.api;
    this.#scope = options.scope;
    this.#prepareObservation = options.prepareObservation ?? (async () => ({
      pendingSets: [], commit() {},
    }));
    this.#authorize = options.authorize;
  }

  async getScope(): Promise<DriveScope> {
    switch (this.#scope.kind) {
      case "account": return { kind: "account" };
      case "sharedDrive": {
        let drive = await this.#api.getDrive(this.#scope.driveId);
        await this.#authorizeIds([drive.id], "Read Google Drive scope",
          "Read the current name of the connected shared drive.");
        return { kind: "sharedDrive", driveId: drive.id, name: drive.name };
      }
      case "file": {
        let file = await this.#api.getFile(this.#scope.fileId);
        await this.#authorizeIds([file.id], "Read Google Drive scope",
          "Read the current name of the connected Drive file.");
        return { kind: "file", fileId: file.id, name: file.name };
      }
    }
  }

  async list(options: DriveListOptions = {}): Promise<Pager<DriveEntry>> {
    if (options.directParentId) await this.#assertParent(options.directParentId);
    if (this.#scope.kind === "file") return this.#exactFileCursor();
    return this.#cursor({
      ...(options.directParentId ? { directParentId: options.directParentId } : {}),
      orderBy: orderBy(options.order),
    });
  }

  async search(query: DriveSearchQuery): Promise<Pager<DriveEntry>> {
    let normalized = normalizeSearch(query);
    if (normalized.directParentId) await this.#assertParent(normalized.directParentId);
    return this.#cursor({
      ...normalized,
      orderBy: normalized.fullTextContains ? null : orderBy(normalized.order),
    });
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) this.#outsideScope();
    let file = await this.#api.getFile(fileId);
    if (!this.#inScope(file)) this.#outsideScope();
    let entry = driveFileToEntry(file);
    await this.#authorizeIds([file.id], "Read Google Drive metadata",
      `Read metadata for Drive file ${file.id}.`);
    return entry;
  }

  #cursor(query: DriveListFilesOptions): Pager<DriveEntry> {
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        let page = await this.#api.listFiles({ ...query, ...this.#corpus(), pageToken });
        return { items: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
      },
      buildEntries: async files => files.filter(file => this.#inScope(file)).map(driveFileToEntry),
      authorize: async entries => {
        await this.#authorizeIds(entries.map(entry => entry.id), "Read Google Drive metadata",
          `Read metadata for ${entries.length} Drive ${entries.length === 1 ? "entry" : "entries"}.`);
      },
    });
  }

  #exactFileCursor(): Pager<DriveEntry> {
    let fileId = this.#scope.kind === "file" ? this.#scope.fileId : this.#outsideScope();
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async () => ({ items: [await this.#api.getFile(fileId)] }),
      buildEntries: async files => {
        if (files.length !== 1 || files[0].id !== fileId) this.#outsideScope();
        return [driveFileToEntry(files[0])];
      },
      authorize: async entries => {
        await this.#authorizeIds(entries.map(entry => entry.id), "Read Google Drive metadata",
          `Read metadata for Drive file ${fileId}.`);
      },
    });
  }

  #corpus(): Pick<DriveListFilesOptions, "corpora" | "driveId"> {
    return this.#scope.kind === "sharedDrive"
      ? { corpora: "drive", driveId: this.#scope.driveId }
      : { corpora: "user" };
  }

  #inScope(file: DriveFile): boolean {
    switch (this.#scope.kind) {
      case "account": return true;
      case "sharedDrive":
        return file.driveId === this.#scope.driveId || file.id === this.#scope.driveId;
      case "file": return file.id === this.#scope.fileId;
    }
  }

  async #assertParent(parentId: string): Promise<void> {
    if (this.#scope.kind === "file") this.#outsideScope();
    let parent = await this.#api.getFile(parentId);
    if (!this.#inScope(parent)) this.#outsideScope();
    if (parent.mimeType !== FOLDER_MIME_TYPE) throw new Error("directParentId must identify a folder");
    await this.#authorizeIds([parent.id], "Check Google Drive folder",
      "Check that the requested parent folder belongs to this Drive binding.");
  }

  async #authorizeIds(fileIds: string[], title: string, description: string): Promise<void> {
    let check = await this.#prepareObservation(fileIds);
    await this.#authorize({ title, description, excludeObservers: check.excludeObservers });
    check.commit();
  }

  #outsideScope(): never {
    throw new Error("The requested file is outside this Drive binding.");
  }
}
