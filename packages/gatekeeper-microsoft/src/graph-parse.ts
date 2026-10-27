// Validates what Graph returns and keeps only the fields this gatekeeper uses. Nothing here passes
// a Graph object through: each parser builds a new value from an allowlist, so pre-authenticated
// download URLs (`@microsoft.graph.downloadUrl`, `…downloadUrlNoAuth`) and a parent's name and path,
// which Graph shows even to someone who can open only the child, never travel further.

import { GraphApiError } from "./graph-api";

/** Refuses a Graph response that isn't the shape asked for: Graph changed shape, or a proxy answered. */
export function malformed(what: string): never {
  throw new GraphApiError(502, `Microsoft Graph sent a malformed ${what}.`);
}

type Json = Record<string, unknown>;

/** `value` as a JSON object, or a malformed-response error naming `what`. */
export function record(value: unknown, what: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformed(what);
  return value as Json;
}

/** `value` as a JSON object, or undefined for anything else. */
export function optRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

/** A required, non-empty string field. */
export function str(json: Json, key: string, what: string): string {
  const value = json[key];
  if (typeof value !== "string" || value === "") malformed(what);
  return value;
}

/** A string field, when present and non-empty. */
export function optStr(json: Json | undefined, key: string): string | undefined {
  const value = json?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optNum(json: Json | undefined, key: string): number | undefined {
  const value = json?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optBool(json: Json | undefined, key: string): boolean | undefined {
  const value = json?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Who an `identitySet` names (a user, else an application): display name only, never an email. */
function personOf(identitySet: unknown): string | undefined {
  const set = optRecord(identitySet);
  return optStr(optRecord(set?.user), "displayName") ?? optStr(optRecord(set?.application), "displayName");
}

/** A page of a Graph collection: its rows, and the opaque link to the next page. */
export type GraphPage<T> = { items: T[]; nextLink?: string };

/** Parses a collection page with `parse` applied to each row. */
export function parsePage<T>(body: unknown, parse: (row: unknown) => T, what: string): GraphPage<T> {
  const json = record(body, `${what} list`);
  const value = json.value;
  if (!Array.isArray(value)) malformed(`${what} list`);
  const nextLink = optStr(json, "@odata.nextLink");
  return { items: value.map(parse), ...(nextLink ? { nextLink } : {}) };
}

// -- sites ------------------------------------------------------------------------------------

/** A SharePoint site. `id` is Graph's composite `host,siteCollectionId,webId`. */
export type GraphSite = {
  id: string;
  name: string;
  webUrl: string;
  description?: string;
  /** A OneDrive for Business personal site, on the `-my` host. */
  personal: boolean;
  /** The site collection's root web, as opposed to a subsite. */
  isRoot: boolean;
  createdAt?: string;
  modifiedAt?: string;
};

/** The `$select` for a site. */
export const SITE_SELECT = "id,name,displayName,webUrl,description,isPersonalSite,root,siteCollection,createdDateTime,lastModifiedDateTime";

/** The three parts of a composite site ID, or null for anything else. */
export function splitSiteId(siteId: string): { host: string; siteCollectionId: string; webId: string } | null {
  const parts = siteId.split(",");
  if (parts.length !== 3) return null;
  const [host, siteCollectionId, webId] = parts;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) || !GUID.test(siteCollectionId) || !GUID.test(webId)) return null;
  return { host: host.toLowerCase(), siteCollectionId: siteCollectionId.toLowerCase(), webId: webId.toLowerCase() };
}

/** A GUID, as SharePoint spells them in IDs. */
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical (lower-case) composite site ID, or null when `siteId` is not one. */
export function canonicalSiteId(siteId: string): string | null {
  const parts = splitSiteId(siteId);
  return parts && `${parts.host},${parts.siteCollectionId},${parts.webId}`;
}

/** Parses a site. */
export function parseSite(body: unknown): GraphSite {
  const json = record(body, "site");
  const id = canonicalSiteId(str(json, "id", "site"));
  if (id === null) malformed("site");
  const webUrl = str(json, "webUrl", "site");
  return {
    id,
    // `displayName` is what SharePoint shows; `name` is the URL segment, and the root site has none.
    name: optStr(json, "displayName") ?? optStr(json, "name") ?? new URL(webUrl).hostname,
    webUrl,
    ...(optStr(json, "description") ? { description: optStr(json, "description") } : {}),
    personal: optBool(json, "isPersonalSite") === true || /-my\.sharepoint\.com$/i.test(new URL(webUrl).hostname),
    isRoot: optRecord(json.root) !== undefined,
    ...(optStr(json, "createdDateTime") ? { createdAt: optStr(json, "createdDateTime") } : {}),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
  };
}

// -- drives (document libraries and OneDrives) --------------------------------------------------

/** A document library or a OneDrive. */
export type GraphDrive = {
  id: string;
  name: string;
  webUrl: string;
  /** `documentLibrary` in a site, `business` for a OneDrive for Business. */
  driveType: string;
  description?: string;
  /** The site collection and web the library lives in, from `sharePointIds`. */
  siteCollectionId?: string;
  webId?: string;
  siteUrl?: string;
  /** The library's underlying list. */
  listId?: string;
  ownerName?: string;
  modifiedAt?: string;
};

/** The `$select` for a drive. */
export const DRIVE_SELECT = "id,name,webUrl,driveType,description,sharePointIds,owner,lastModifiedDateTime";

/** Parses a document library or OneDrive. */
export function parseDrive(body: unknown): GraphDrive {
  const json = record(body, "library");
  const ids = optRecord(json.sharePointIds);
  return {
    id: str(json, "id", "library"),
    name: optStr(json, "name") ?? "Documents",
    webUrl: str(json, "webUrl", "library"),
    driveType: optStr(json, "driveType") ?? "documentLibrary",
    ...(optStr(json, "description") ? { description: optStr(json, "description") } : {}),
    ...(optStr(ids, "siteId") ? { siteCollectionId: optStr(ids, "siteId")!.toLowerCase() } : {}),
    ...(optStr(ids, "webId") ? { webId: optStr(ids, "webId")!.toLowerCase() } : {}),
    ...(optStr(ids, "siteUrl") ? { siteUrl: optStr(ids, "siteUrl") } : {}),
    ...(optStr(ids, "listId") ? { listId: optStr(ids, "listId")!.toLowerCase() } : {}),
    ...(personOf(json.owner) ? { ownerName: personOf(json.owner) } : {}),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
  };
}

// -- drive items (files and folders) ----------------------------------------------------------

/** A file or folder in a library or OneDrive. */
export type GraphDriveItem = {
  id: string;
  driveId: string;
  name: string;
  webUrl: string;
  kind: "folder" | "file";
  /** The containing folder, absent for a drive's root. */
  parentId?: string;
  /**
   * The containing folder's path within the drive, decoded, without a leading slash: "" for the
   * root, "Specs/Deep" deeper down. Graph shows it even above what the reader can open, so it is
   * only ever shown relative to the binding's own top folder.
   */
  parentPath?: string;
  /** Whether this is the drive's root folder. */
  isRoot: boolean;
  eTag?: string;
  /** Changes only when the content changes, unlike `eTag`. */
  cTag?: string;
  size?: number;
  mimeType?: string;
  childCount?: number;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  modifiedBy?: string;
  /** The site collection and web that hold the item, and its list item, from `sharepointIds`. */
  siteCollectionId?: string;
  webId?: string;
  /** The host of the site that holds the item: `contoso.sharepoint.com`, or the `-my` host for a OneDrive. */
  siteHost?: string;
  listId?: string;
  listItemId?: string;
  /** A sensitivity label's display name, when the file carries one Graph reports. */
  sensitivityLabel?: string;
  /** For a shared-with-me shortcut: where the item actually lives. */
  remote?: { driveId: string; id: string };
  /** The item is a OneNote notebook or similar package, which reads as a folder but is not one. */
  isPackage: boolean;
};

/** The `$select` for a drive item. */
export const ITEM_SELECT = "id,name,webUrl,eTag,cTag,size,file,folder,package,root,parentReference,createdDateTime," +
  "lastModifiedDateTime,createdBy,lastModifiedBy,sharepointIds,remoteItem,deleted";

/** The lower-case host of a URL, or undefined. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The drive-relative folder path in a `parentReference.path` like `/drives/b!x/root:/Specs/Deep`. */
function parentPathOf(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const marker = path.indexOf("root:");
  if (marker === -1) return undefined;
  const rest = path.slice(marker + "root:".length).replace(/^\/+/, "");
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** Parses a file or folder, including a shared-with-me shortcut (`remoteItem`). */
export function parseDriveItem(body: unknown): GraphDriveItem {
  const json = record(body, "file");
  const parent = optRecord(json.parentReference);
  const remote = optRecord(json.remoteItem);
  const remoteParent = optRecord(remote?.parentReference);
  const driveId = optStr(parent, "driveId") ?? optStr(remoteParent, "driveId");
  if (driveId === undefined) malformed("file");
  const folder = optRecord(json.folder) ?? optRecord(remote?.folder);
  const pkg = optRecord(json.package);
  const file = optRecord(json.file) ?? optRecord(remote?.file);
  const ids = optRecord(json.sharepointIds);
  const isRoot = optRecord(json.root) !== undefined;
  const remoteId = optStr(remote, "id");
  const remoteDrive = optStr(remoteParent, "driveId");
  return {
    id: str(json, "id", "file"),
    driveId,
    name: optStr(json, "name") ?? (isRoot ? "Documents" : malformed("file")),
    // A OneDrive shortcut comes without one, on itself and on its remoteItem.
    webUrl: optStr(json, "webUrl") ?? optStr(remote, "webUrl") ?? "",
    kind: folder !== undefined || pkg !== undefined || isRoot ? "folder" : "file",
    ...(!isRoot && optStr(parent, "id") ? { parentId: optStr(parent, "id") } : {}),
    ...(!isRoot && parentPathOf(optStr(parent, "path")) !== undefined ? { parentPath: parentPathOf(optStr(parent, "path")) } : {}),
    isRoot,
    ...(optStr(json, "eTag") ? { eTag: optStr(json, "eTag") } : {}),
    ...(optStr(json, "cTag") ? { cTag: optStr(json, "cTag") } : {}),
    ...(optNum(json, "size") !== undefined ? { size: optNum(json, "size") } : {}),
    ...(optStr(file, "mimeType") ? { mimeType: optStr(file, "mimeType") } : {}),
    ...(optNum(folder, "childCount") !== undefined ? { childCount: optNum(folder, "childCount") } : {}),
    ...(optStr(json, "createdDateTime") ? { createdAt: optStr(json, "createdDateTime") } : {}),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
    ...(personOf(json.createdBy) ? { createdBy: personOf(json.createdBy) } : {}),
    ...(personOf(json.lastModifiedBy) ? { modifiedBy: personOf(json.lastModifiedBy) } : {}),
    ...(optStr(ids, "siteId") ? { siteCollectionId: optStr(ids, "siteId")!.toLowerCase() } : {}),
    ...(optStr(ids, "webId") ? { webId: optStr(ids, "webId")!.toLowerCase() } : {}),
    ...(hostOf(optStr(ids, "siteUrl")) ? { siteHost: hostOf(optStr(ids, "siteUrl")) } : {}),
    ...(optStr(ids, "listId") ? { listId: optStr(ids, "listId")!.toLowerCase() } : {}),
    ...(optStr(ids, "listItemId") ? { listItemId: optStr(ids, "listItemId") } : {}),
    ...(optStr(optRecord(json.sensitivityLabel), "displayName")
      ? { sensitivityLabel: optStr(optRecord(json.sensitivityLabel), "displayName") } : {}),
    ...(remoteId && remoteDrive ? { remote: { driveId: remoteDrive, id: remoteId } } : {}),
    isPackage: pkg !== undefined,
  };
}

/** Whether an item is in the recycle bin or gone, as a delta or a stale read reports it. */
export function isDeletedItem(body: unknown): boolean {
  return optRecord(optRecord(body)?.deleted) !== undefined;
}

// -- lists and list items ---------------------------------------------------------------------

/** A SharePoint list (not a document library, which is a drive). */
export type GraphList = {
  id: string;
  name: string;
  webUrl: string;
  description?: string;
  /** SharePoint's list template, e.g. `genericList`, `documentLibrary`, `events`. */
  template?: string;
  hidden: boolean;
  /** The composite ID of the site it belongs to, when Graph said. */
  siteId?: string;
  createdAt?: string;
  modifiedAt?: string;
};

/** The `$select` for a list. */
export const LIST_SELECT = "id,displayName,name,webUrl,description,list,parentReference,createdDateTime,lastModifiedDateTime";

/** Parses a list. */
export function parseList(body: unknown): GraphList {
  const json = record(body, "list");
  const info = optRecord(json.list);
  const siteId = optStr(optRecord(json.parentReference), "siteId");
  return {
    id: str(json, "id", "list").toLowerCase(),
    name: optStr(json, "displayName") ?? optStr(json, "name") ?? malformed("list"),
    webUrl: str(json, "webUrl", "list"),
    ...(optStr(json, "description") ? { description: optStr(json, "description") } : {}),
    ...(optStr(info, "template") ? { template: optStr(info, "template") } : {}),
    hidden: optBool(info, "hidden") === true,
    ...(siteId && canonicalSiteId(siteId) ? { siteId: canonicalSiteId(siteId)! } : {}),
    ...(optStr(json, "createdDateTime") ? { createdAt: optStr(json, "createdDateTime") } : {}),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
  };
}

/** The kinds of column this gatekeeper reads and writes. Anything else is `other`, read-only. */
export type ColumnType =
  | "text" | "note" | "number" | "currency" | "boolean" | "dateTime" | "choice" | "multiChoice"
  | "person" | "lookup" | "hyperlink" | "calculated" | "other";

/** One column of a list. */
export type GraphColumn = {
  /** The internal name: what `fields` are keyed by, and what filters name. */
  name: string;
  displayName: string;
  type: ColumnType;
  description?: string;
  required: boolean;
  readOnly: boolean;
  hidden: boolean;
  indexed: boolean;
  choices?: string[];
  /** Whether a person or lookup column holds several values. */
  multiple?: boolean;
};

/** Which of Graph's per-type facets names a column's type. */
function columnTypeOf(json: Json): Pick<GraphColumn, "type" | "choices" | "multiple"> {
  if (optRecord(json.text)) {
    return { type: optBool(optRecord(json.text), "allowMultipleLines") ? "note" : "text" };
  }
  if (optRecord(json.number)) return { type: "number" };
  if (optRecord(json.currency)) return { type: "currency" };
  if (optRecord(json.boolean)) return { type: "boolean" };
  if (optRecord(json.dateTime)) return { type: "dateTime" };
  const choice = optRecord(json.choice);
  if (choice) {
    const choices = Array.isArray(choice.choices) ? choice.choices.filter((c): c is string => typeof c === "string") : [];
    // Graph has no separate multi-choice facet; `displayAs: "checkBoxes"` is how SharePoint marks one.
    return { type: optStr(choice, "displayAs") === "checkBoxes" ? "multiChoice" : "choice", choices };
  }
  const person = optRecord(json.personOrGroup);
  if (person) return { type: "person", multiple: optBool(person, "allowMultipleSelection") === true };
  const lookup = optRecord(json.lookup);
  if (lookup) return { type: "lookup", multiple: optBool(lookup, "allowMultipleValues") === true };
  if (optRecord(json.hyperlinkOrPicture)) return { type: "hyperlink" };
  if (optRecord(json.calculated)) return { type: "calculated" };
  return { type: "other" };
}

/** Parses a list column. Calculated and lookup columns are read-only. */
export function parseColumn(body: unknown): GraphColumn {
  const json = record(body, "column");
  const type = columnTypeOf(json);
  return {
    name: str(json, "name", "column"),
    displayName: optStr(json, "displayName") ?? str(json, "name", "column"),
    ...type,
    ...(optStr(json, "description") ? { description: optStr(json, "description") } : {}),
    required: optBool(json, "required") === true,
    // Calculated and lookup values are computed by SharePoint, never written.
    readOnly: optBool(json, "readOnly") === true || type.type === "calculated" || type.type === "lookup",
    hidden: optBool(json, "hidden") === true,
    indexed: optBool(json, "indexed") === true,
  };
}

/** A list item: its own metadata, and its column values keyed by internal name. */
export type GraphListItem = {
  id: string;
  eTag?: string;
  webUrl?: string;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  modifiedBy?: string;
  fields: Record<string, unknown>;
  /** The version this reader sees, from `_UIVersionString`: `2.0`, or a draft's `2.1`. */
  version?: string;
  /** `_ModerationStatus` on a list that requires approval: 0 approved, 1 rejected, 2 pending, 3 draft. */
  moderation?: number;
};

/** Column values SharePoint adds to every item that say nothing an agent needs, or duplicate metadata. */
const NOISE_FIELDS = new Set([
  "@odata.etag", "ContentType", "Edit", "LinkTitleNoMenu", "LinkTitle", "ItemChildCount", "FolderChildCount",
  "_UIVersionString", "_ModerationStatus", "_ComplianceFlags", "_ComplianceTag", "_ComplianceTagWrittenTime", "_ComplianceTagUserId",
  "AppAuthorLookupId", "AppEditorLookupId", "AuthorLookupId", "EditorLookupId", "id", "Attachments", "_ColorTag", "ComplianceAssetId", "_IsRecord",
]);

/** An item's column values, minus SharePoint's bookkeeping columns and OData annotations. */
function fieldsOf(value: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(optRecord(value) ?? {})) {
    if (NOISE_FIELDS.has(key) || key.startsWith("@odata.") || key.startsWith("odata.")) continue;
    fields[key] = field;
  }
  return fields;
}

/** Parses a list item, dropping SharePoint's bookkeeping columns. */
export function parseListItem(body: unknown): GraphListItem {
  const json = record(body, "list item");
  return {
    id: str(json, "id", "list item"),
    ...(optStr(json, "eTag") ? { eTag: optStr(json, "eTag") } : {}),
    ...(optStr(json, "webUrl") ? { webUrl: optStr(json, "webUrl") } : {}),
    ...(optStr(json, "createdDateTime") ? { createdAt: optStr(json, "createdDateTime") } : {}),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
    ...(personOf(json.createdBy) ? { createdBy: personOf(json.createdBy) } : {}),
    ...(personOf(json.lastModifiedBy) ? { modifiedBy: personOf(json.lastModifiedBy) } : {}),
    fields: fieldsOf(json.fields),
    ...versionOf(optRecord(json.fields)),
  };
}

/** The version and approval state an item's own columns report, for version-pinned access checks. */
export function versionOf(fields: Record<string, unknown> | undefined): { version?: string; moderation?: number } {
  const version = optStr(fields ?? {}, "_UIVersionString");
  const moderation = fields?._ModerationStatus;
  return {
    ...(version ? { version } : {}),
    ...(typeof moderation === "number" && Number.isInteger(moderation) ? { moderation } : {}),
  };
}

// -- pages ------------------------------------------------------------------------------------

/** A modern site page. */
export type GraphSitePage = {
  id: string;
  name: string;
  title: string;
  webUrl: string;
  description?: string;
  modifiedAt?: string;
  modifiedBy?: string;
  /** `published`, `checkout`, or `draft`. */
  state?: string;
  /** The version this reader sees, `1.0` or a draft's `1.1`. */
  version?: string;
};

/** The `$select` for a page. */
export const PAGE_SELECT = "id,name,title,webUrl,description,lastModifiedDateTime,lastModifiedBy,publishingState";

/** Parses a site page. */
export function parseSitePage(body: unknown): GraphSitePage {
  const json = record(body, "page");
  const name = str(json, "name", "page");
  const webUrl = str(json, "webUrl", "page");
  return {
    id: str(json, "id", "page").toLowerCase(),
    name,
    title: optStr(json, "title") ?? name.replace(/\.aspx$/i, ""),
    // Graph returns a page's `webUrl` relative to its site ("SitePages/Home.aspx"); callers resolve it.
    webUrl,
    ...(optStr(json, "description") ? { description: optStr(json, "description") } : {}),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
    ...(personOf(json.lastModifiedBy) ? { modifiedBy: personOf(json.lastModifiedBy) } : {}),
    ...(optStr(optRecord(json.publishingState), "level") ? { state: optStr(optRecord(json.publishingState), "level") } : {}),
    ...(optStr(optRecord(json.publishingState), "versionId") ? { version: optStr(optRecord(json.publishingState), "versionId") } : {}),
  };
}

/** The web parts of a page's canvas, in reading order, as the HTML or data each holds. */
export type PageWebPart =
  | { kind: "text"; html: string }
  | { kind: "other"; title?: string; description?: string };

/**
 * A page's canvas, flattened to reading order: horizontal sections top to bottom, columns left to
 * right, web parts top to bottom, then the vertical section. Only text web parts carry content Graph
 * exposes; the rest (images, lists, news) are named so the reader knows something is there.
 */
export function parseCanvas(body: unknown): PageWebPart[] {
  const canvas = optRecord(optRecord(body)?.canvasLayout);
  if (canvas === undefined) return [];
  const parts: PageWebPart[] = [];
  const takeWebParts = (column: Json | undefined) => {
    const webparts = column?.webparts;
    if (!Array.isArray(webparts)) return;
    for (const raw of webparts) {
      const part = optRecord(raw);
      if (part === undefined) continue;
      const html = optStr(part, "innerHtml");
      if (html !== undefined) {
        parts.push({ kind: "text", html });
        continue;
      }
      const data = optRecord(part.data);
      const title = optStr(data, "title");
      const description = optStr(data, "description");
      parts.push({ kind: "other", ...(title ? { title } : {}), ...(description ? { description } : {}) });
    }
  };
  const sections = canvas.horizontalSections;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      const columns = optRecord(section)?.columns;
      if (Array.isArray(columns)) for (const column of columns) takeWebParts(optRecord(column));
    }
  }
  takeWebParts(optRecord(canvas.verticalSection));
  return parts;
}

// -- the signed-in user -----------------------------------------------------------------------

/** The signed-in user, as `/me` describes them. */
export type GraphMe = { id: string; displayName: string; userPrincipalName?: string; mail?: string };

/** Parses `/me`. */
export function parseMe(body: unknown): GraphMe {
  const json = record(body, "user");
  return {
    id: str(json, "id", "user").toLowerCase(),
    displayName: optStr(json, "displayName") ?? optStr(json, "userPrincipalName") ?? "Microsoft 365 user",
    ...(optStr(json, "userPrincipalName") ? { userPrincipalName: optStr(json, "userPrincipalName") } : {}),
    ...(optStr(json, "mail") ? { mail: optStr(json, "mail") } : {}),
  };
}

// -- workbooks --------------------------------------------------------------------------------

/** A worksheet's used range: computed values and, where a cell has one, its formula. */
export type GraphRange = { address: string; values: unknown[][]; formulas?: unknown[][] };

/** Parses a worksheet range. */
export function parseRange(body: unknown): GraphRange {
  const json = record(body, "worksheet range");
  const values = json.values;
  if (!Array.isArray(values) || !values.every(Array.isArray)) malformed("worksheet range");
  const formulas = Array.isArray(json.formulas) && json.formulas.every(Array.isArray) ? json.formulas as unknown[][] : undefined;
  return { address: optStr(json, "address") ?? "", values: values as unknown[][], ...(formulas ? { formulas } : {}) };
}

/** A worksheet's name and visibility. */
export type GraphWorksheet = { id: string; name: string; visible: boolean };

/** Parses a worksheet. */
export function parseWorksheet(body: unknown): GraphWorksheet {
  const json = record(body, "worksheet");
  return {
    id: str(json, "id", "worksheet"),
    name: str(json, "name", "worksheet"),
    visible: optStr(json, "visibility") === undefined || optStr(json, "visibility") === "Visible",
  };
}

/** A file version. */
export type GraphVersion = { id: string; modifiedAt?: string; modifiedBy?: string; size?: number };

/** Parses a file version. */
export function parseVersion(body: unknown): GraphVersion {
  const json = record(body, "version");
  return {
    id: str(json, "id", "version"),
    ...(optStr(json, "lastModifiedDateTime") ? { modifiedAt: optStr(json, "lastModifiedDateTime") } : {}),
    ...(personOf(json.lastModifiedBy) ? { modifiedBy: personOf(json.lastModifiedBy) } : {}),
    ...(optNum(json, "size") !== undefined ? { size: optNum(json, "size") } : {}),
  };
}
