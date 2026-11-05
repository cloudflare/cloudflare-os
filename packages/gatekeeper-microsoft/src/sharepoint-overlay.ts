// How Graph's objects look to the agent, and how pending changes reshape them. The entry builders
// turn parsed Graph values into the agent-facing types, with paths shown only relative to the top
// of what the binding covers. The overlay applies the actions awaiting approval on top, so reads
// show a proposed change straight away: a pending rename shows the new name, a pending upload
// appears in its folder with a temporary ID, and a pending delete drops out of listings.

import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { canonicalSiteId, type GraphDrive, type GraphDriveItem, type GraphList, type GraphListItem, type GraphSite, type GraphSitePage } from "./graph-parse";
import type { FolderTarget, SharePointAction } from "./sharepoint-actions";
import { readFieldValue } from "./sharepoint-lists";
import { encodeItemRef, encodeListRef, encodePageRef, type ItemRef, type ListRef } from "./sharepoint-scope";
import type {
  CellValue, DriveEntry, FieldValue, LibraryInfo, ListInfo, ListItem, PageInfo, PendingChange, SiteInfo,
} from "./types";

/** Where paths are measured from: the binding's top folder, as a drive-relative path. */
export type PathBase = {
  driveId: string;
  /** The top folder's drive-relative path: "" for a drive's root. */
  path: string;
  /** The top folder's ID, which has no parent within the binding. */
  itemId?: string;
};

/** The item's own drive-relative path. */
export function drivePath(item: Pick<GraphDriveItem, "isRoot" | "parentPath" | "name">): string | undefined {
  if (item.isRoot) return "";
  if (item.parentPath === undefined) return undefined;
  return item.parentPath === "" ? item.name : `${item.parentPath}/${item.name}`;
}

/** `full` relative to `base`, or undefined when it is not beneath it. */
function relativeTo(full: string | undefined, base: string): string | undefined {
  if (full === undefined) return undefined;
  if (base === "") return full;
  if (full === base) return "";
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : undefined;
}

/** The composite site ID of the site that holds an item, when Graph said enough to build it. */
export function itemSiteId(item: Pick<GraphDriveItem, "siteHost" | "siteCollectionId" | "webId">): string | undefined {
  if (!item.siteHost || !item.siteCollectionId || !item.webId) return undefined;
  return canonicalSiteId(`${item.siteHost},${item.siteCollectionId},${item.webId}`) ?? undefined;
}

/** A file or folder as the agent sees it. */
export function toEntry(item: GraphDriveItem, base: PathBase): DriveEntry {
  const isTop = item.isRoot || item.id === base.itemId;
  const path = item.driveId === base.driveId ? relativeTo(drivePath(item), base.path) : undefined;
  const siteId = itemSiteId(item);
  // A file's version is its content tag: a rename does not change it, so a pending rename and a
  // fenced replace can both apply. Graph accepts it in `If-Match` wherever it accepts the eTag.
  const eTag = item.kind === "file" ? item.cTag ?? item.eTag : item.eTag;
  return {
    id: encodeItemRef({ driveId: item.driveId, itemId: item.id }),
    name: item.name,
    kind: item.kind,
    webUrl: item.webUrl,
    // Paths are measured from the binding's top folder, which is therefore "", but a binding to one
    // file still calls the file by its name.
    path: isTop ? (item.kind === "file" && !item.isRoot ? item.name : "") : path ?? item.name,
    ...(!isTop && item.parentId ? { parentId: encodeItemRef({ driveId: item.driveId, itemId: item.parentId }) } : {}),
    libraryId: item.driveId,
    ...(siteId ? { siteId } : {}),
    ...(item.size !== undefined && item.kind === "file" ? { size: item.size } : {}),
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    ...(item.childCount !== undefined ? { childCount: item.childCount } : {}),
    ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    ...(item.modifiedAt ? { modifiedAt: item.modifiedAt } : {}),
    ...(item.createdBy ? { createdBy: item.createdBy } : {}),
    ...(item.modifiedBy ? { modifiedBy: item.modifiedBy } : {}),
    ...(eTag ? { eTag } : {}),
  };
}

/** A site as the agent sees it. */
export function toSiteInfo(site: GraphSite): SiteInfo {
  return {
    id: site.id,
    name: site.name,
    webUrl: site.webUrl,
    ...(site.description ? { description: site.description } : {}),
    personal: site.personal,
    ...(site.modifiedAt ? { modifiedAt: site.modifiedAt } : {}),
  };
}

/** A library as the agent sees it. */
export function toLibraryInfo(drive: GraphDrive, siteId: string): LibraryInfo {
  return {
    id: drive.id,
    name: drive.name,
    webUrl: drive.webUrl,
    siteId,
    ...(drive.description ? { description: drive.description } : {}),
    rootFolderId: encodeItemRef({ driveId: drive.id, itemId: "root" }),
    ...(drive.modifiedAt ? { modifiedAt: drive.modifiedAt } : {}),
  };
}

/** A list as the agent sees it. */
export function toListInfo(list: GraphList, siteId: string): ListInfo {
  return {
    id: encodeListRef({ siteId, listId: list.id }),
    name: list.name,
    webUrl: list.webUrl,
    siteId,
    ...(list.description ? { description: list.description } : {}),
    ...(list.template ? { template: list.template } : {}),
    ...(list.modifiedAt ? { modifiedAt: list.modifiedAt } : {}),
  };
}

/**
 * A page's absolute URL. Graph gives some pages' `webUrl` relative to the site ("SitePages/Home.aspx"),
 * which `siteUrl` completes; a site URL has no trailing slash, so the join is spelled out rather
 * than left to `new URL`, which would drop the site's last path segment.
 */
export function pageWebUrl(page: Pick<GraphSitePage, "webUrl">, siteUrl: string | undefined): string {
  return /^https:/i.test(page.webUrl) || siteUrl === undefined ? page.webUrl : `${siteUrl.replace(/\/$/, "")}/${page.webUrl}`;
}

/** A page as the agent sees it. `siteUrl` completes a site-relative `webUrl`. */
export function toPageInfo(page: GraphSitePage, siteId: string, siteUrl?: string): PageInfo {
  return {
    id: encodePageRef({ siteId, pageId: page.id }),
    title: page.title,
    name: page.name,
    webUrl: pageWebUrl(page, siteUrl),
    siteId,
    ...(page.description ? { description: page.description } : {}),
    ...(page.modifiedAt ? { modifiedAt: page.modifiedAt } : {}),
    ...(page.modifiedBy ? { modifiedBy: page.modifiedBy } : {}),
    published: page.state === undefined || page.state === "published",
  };
}

/** A list item as the agent sees it, its field values as `FieldValue`s. */
export function toListItem(item: GraphListItem): ListItem {
  const fields: Record<string, FieldValue> = {};
  for (const [name, value] of Object.entries(item.fields)) fields[name] = readFieldValue(value);
  return {
    id: item.id,
    fields,
    ...(item.webUrl ? { webUrl: item.webUrl } : {}),
    ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    ...(item.modifiedAt ? { modifiedAt: item.modifiedAt } : {}),
    ...(item.createdBy ? { createdBy: item.createdBy } : {}),
    ...(item.modifiedBy ? { modifiedBy: item.modifiedBy } : {}),
    ...(item.eTag ? { eTag: item.eTag } : {}),
  };
}

// -- the overlay --------------------------------------------------------------------------------

/** What pending actions do to one existing file or folder. */
type ItemChange = {
  name?: string;
  /** The folder it is moving into, and that folder's path. */
  movedTo?: FolderTarget;
  replaced?: { size: number; mimeType: string };
  deleted?: boolean;
  pending: PendingChange;
};

/** Pending changes, read once per operation from the journal. */
export class Overlay {
  readonly #pending: JournalEntry<SharePointAction>[];
  readonly #resolve: (id: string) => string;
  readonly #changes = new Map<string, ItemChange>();

  /**
   * @param resolve Resolves a temporary ID to the real one once its action applied, else returns it.
   */
  constructor(pending: JournalEntry<SharePointAction>[], resolve: (id: string) => string) {
    this.#pending = pending;
    this.#resolve = resolve;
    for (const { action } of pending) {
      const change = (id: string, update: Partial<ItemChange> & { pending: PendingChange }) =>
        this.#changes.set(id, { ...this.#changes.get(id), ...update });
      switch (action.kind) {
        case "rename": change(encodeItemRef(action.payload.target.ref), { name: action.payload.name, pending: "rename" }); break;
        case "move": change(encodeItemRef(action.payload.target.ref), { movedTo: action.payload.to, pending: "move" }); break;
        case "replaceFile":
          change(encodeItemRef(action.payload.target.ref), {
            replaced: { size: action.payload.file.size, mimeType: action.payload.mimeType }, pending: "replace",
          });
          break;
        case "deleteItem": change(encodeItemRef(action.payload.target.ref), { deleted: true, pending: "delete" }); break;
        case "updateCells": change(encodeItemRef(action.payload.target.ref), { pending: "update" }); break;
      }
    }
  }

  /** Whether nothing is pending, so reads can skip the overlay. */
  get empty(): boolean {
    return this.#pending.length === 0;
  }

  /** The folder a target names, with any temporary ID resolved. */
  #folderId(target: FolderTarget): string {
    return this.#resolve(target.id);
  }

  /**
   * An entry with its pending changes applied. Returns null when a pending change takes it out of
   * `listedIn` (a delete, or a move elsewhere); a direct read passes no folder and keeps it.
   */
  apply(entry: DriveEntry, listedIn?: string): DriveEntry | null {
    const change = this.#changes.get(entry.id);
    if (change === undefined) return entry;
    if (listedIn !== undefined && (change.deleted || (change.movedTo && this.#folderId(change.movedTo) !== listedIn))) return null;
    const name = change.name ?? entry.name;
    const path = change.movedTo
      ? join(change.movedTo.path, name)
      : change.name ? join(parentPath(entry.path), name) : entry.path;
    return {
      ...entry,
      name,
      path,
      ...(change.movedTo ? { parentId: this.#folderId(change.movedTo) } : {}),
      ...(change.replaced ? { size: change.replaced.size, mimeType: change.replaced.mimeType } : {}),
      pending: change.deleted ? "delete" : change.pending,
    };
  }

  /** Entries pending actions add to a folder: creations in it, and moves into it. */
  addedTo(folderId: string, folderPath: string, libraryId: string, siteId: string | undefined): DriveEntry[] {
    const added: DriveEntry[] = [];
    for (const { action } of this.#pending) {
      if ((action.kind === "createFolder" || action.kind === "uploadFile" || action.kind === "copyFile") && this.#folderId(action.payload.parent) === folderId) {
        // Once applied, the real item is listed by Graph and this stand-in is gone with the action.
        added.push(this.#created(action, folderPath, libraryId, siteId));
      }
    }
    for (const [id, change] of this.#changes) {
      if (change.movedTo && this.#folderId(change.movedTo) === folderId && !change.deleted) {
        const target = this.#moveTarget(id);
        if (target) added.push(target);
      }
    }
    return added;
  }

  /** A pending creation by its temporary ID, as an entry. */
  created(id: string): DriveEntry | undefined {
    for (const { action } of this.#pending) {
      if ((action.kind === "createFolder" || action.kind === "uploadFile" || action.kind === "copyFile") && action.payload.ref === id) {
        return this.#created(action, action.payload.parent.path, action.payload.parent.driveId, undefined);
      }
    }
    return undefined;
  }

  /** The pending upload or replacement of a file, for reading its content before approval. */
  pendingContent(id: string): { file: ActionFileReference; mimeType: string; name: string } | undefined {
    let found: { file: ActionFileReference; mimeType: string; name: string } | undefined;
    for (const { action } of this.#pending) {
      if (action.kind === "uploadFile" && this.#resolve(action.payload.ref) === id) {
        found = { file: action.payload.file, mimeType: action.payload.mimeType, name: action.payload.name };
      } else if (action.kind === "replaceFile" && encodeItemRef(action.payload.target.ref) === id) {
        found = { file: action.payload.file, mimeType: action.payload.mimeType, name: action.payload.target.name };
      }
    }
    return found;
  }

  /** The file a pending copy copies, by the copy's temporary ID: what reading the copy reads. */
  copySource(id: string): ItemRef | undefined {
    for (const { action } of this.#pending) {
      if (action.kind === "copyFile" && action.payload.ref === id) return action.payload.source.ref;
    }
    return undefined;
  }

  /** Pending cell changes to a workbook, oldest first, which reads of it show as made. */
  pendingCells(id: string): { worksheet: string; address: string; values: CellValue[][] }[] {
    const cells: { worksheet: string; address: string; values: CellValue[][] }[] = [];
    for (const { action } of this.#pending) {
      if (action.kind === "updateCells" && encodeItemRef(action.payload.target.ref) === id) {
        cells.push({ worksheet: action.payload.worksheet, address: action.payload.address, values: action.payload.values });
      }
    }
    return cells;
  }

  /** Whether an existing item is pending deletion. */
  isDeleted(id: string): boolean {
    return this.#changes.get(id)?.deleted === true;
  }

  #created(action: Extract<SharePointAction, { kind: "createFolder" | "uploadFile" | "copyFile" }>, folderPath: string, libraryId: string,
           siteId: string | undefined): DriveEntry {
    const { payload } = action;
    const resolvedId = this.#resolve(payload.ref);
    return {
      id: resolvedId,
      name: payload.name,
      kind: action.kind === "createFolder" ? "folder" : "file",
      webUrl: "",
      path: join(folderPath, payload.name),
      parentId: this.#folderId(payload.parent),
      libraryId,
      ...(siteId ? { siteId } : {}),
      ...(action.kind === "uploadFile" ? { size: action.payload.file.size, mimeType: action.payload.mimeType }
        : action.kind === "copyFile" ? { ...(action.payload.size !== undefined ? { size: action.payload.size } : {}), ...(action.payload.mimeType ? { mimeType: action.payload.mimeType } : {}) }
        : { childCount: 0 }),
      createdAt: new Date(payload.submittedAt).toISOString(),
      modifiedAt: new Date(payload.submittedAt).toISOString(),
      pending: "create",
    };
  }

  #moveTarget(id: string): DriveEntry | undefined {
    for (const { action } of this.#pending) {
      if (action.kind === "move" && encodeItemRef(action.payload.target.ref) === id) {
        const { target, to } = action.payload;
        const name = this.#changes.get(id)?.name ?? target.name;
        return {
          id,
          name,
          kind: target.kind,
          webUrl: target.webUrl ?? "",
          path: join(to.path, name),
          parentId: this.#folderId(to),
          libraryId: target.ref.driveId,
          pending: "move",
        };
      }
    }
    return undefined;
  }

  // -- list items -------------------------------------------------------------------------------

  /**
   * Pending creations in a list, as items with temporary IDs, with the changes pending on them
   * applied as {@link applyItem} applies them: `listing` leaves out one pending deletion.
   */
  createdItems(list: ListRef, listing: boolean): ListItem[] {
    const items: ListItem[] = [];
    for (const { action } of this.#pending) {
      if (action.kind === "createListItem" && sameList(action.payload.list, list)) {
        const created = this.applyItem(list, {
          id: this.#resolve(action.payload.ref),
          fields: { ...action.payload.fields },
          createdAt: new Date(action.payload.submittedAt).toISOString(),
          modifiedAt: new Date(action.payload.submittedAt).toISOString(),
          pending: "create",
        }, listing);
        if (created !== null) items.push(created);
      }
    }
    return items;
  }

  /**
   * An item with its pending updates merged, or null when it is pending deletion and `listing` is
   * set: listings leave it out, a direct read shows it marked. An item still awaiting creation
   * stays marked as such through its updates.
   */
  applyItem(list: ListRef, item: ListItem, listing: boolean): ListItem | null {
    let result = item;
    for (const { action } of this.#pending) {
      if (action.kind === "updateListItem" && sameList(action.payload.list, list) && this.#resolve(action.payload.itemId) === item.id) {
        result = { ...result, fields: { ...result.fields, ...action.payload.fields }, pending: result.pending === "create" ? "create" : "update" };
      }
      if (action.kind === "deleteListItem" && sameList(action.payload.list, list) && this.#resolve(action.payload.itemId) === item.id) {
        if (listing) return null;
        result = { ...result, pending: "delete" };
      }
    }
    return result;
  }

  /** Whether an action already pending targets the same item, so its version tag will be stale. */
  hasPendingChange(id: string): boolean {
    return this.#changes.has(id);
  }

  /** Whether an action already pending changes the same list item. */
  hasPendingItemChange(list: ListRef, itemId: string): boolean {
    return this.#pending.some(({ action }) => (action.kind === "updateListItem" || action.kind === "deleteListItem")
      && sameList(action.payload.list, list) && this.#resolve(action.payload.itemId) === itemId);
  }
}

function sameList(a: ListRef, b: ListRef): boolean {
  return a.siteId === b.siteId && a.listId === b.listId;
}

/** Joins path segments, skipping an empty base. */
export function join(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}

/** The parent of a path: "" at the top. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
