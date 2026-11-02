// The capability the SharePoint configurator frame holds: it browses what the connected user can
// open, as the picker's rows, and turns a choice into the resource URL the binding is minted from.
// Nothing here grants anything. It reads as the user, and the binding re-resolves the URL itself
// (`getGatekeeperClassFor`), so a forged ref can at most bind something the user could open anyway.
//
// A row's `value` is a ref naming the object by ID (see `SharePointConfiguratorValues`), so opening
// a place costs one listing, not a URL resolution.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  SharePointBrowserCrumb, SharePointBrowserIcon, SharePointBrowserItem, SharePointBrowserPage, SharePointBrowserRequest,
  SharePointConfiguratorRpc, SharePointConfiguratorStatus, SharePointLocated,
} from "./configurator/sharepoint-configurator-types";
import { GraphApi, GraphApiError, MAX_BATCH_REQUESTS, isGraphUrl } from "./graph-api";
import {
  DRIVE_SELECT, GUID, SITE_SELECT, parseDrive, parseSite, type GraphDrive, type GraphDriveItem, type GraphList,
  type GraphSite, type GraphSitePage,
} from "./graph-parse";
import { accountSource, type StoredIdentity } from "./microsoft-credentials";
import { SHAREPOINT_RESOURCE, grantedResourcePatterns, grantedSharePoint, type SharePointAccess, type SharePointGrant } from "./microsoft-env";
import { extensionOf } from "./sharepoint-content";
import { itemSiteId, pageWebUrl } from "./sharepoint-overlay";
import * as reads from "./sharepoint-reads";
import { SiteNotGrantedError, UnresolvableUrlError, resolveSharePointUrl } from "./sharepoint-resolve";
import { allUrl, parseSharePointUrl } from "./sharepoint-urls";

/** Rows per page: what the picker shows before "Show more". */
const PAGE_SIZE = 50;
/** Search results per page; each costs a breadcrumb lookup. */
const SEARCH_PAGE_SIZE = 25;
/** How long the identity and grant are reused while the frame is open. */
const STATUS_TTL_MS = 60 * 1000;

const TABS = { sites: "sites", onedrive: "onedrive" } as const;
/** What the frame calls everything; the frame's own copy must match. */
const ALL_TITLE = "All of SharePoint & OneDrive";

/**
 * A ref, parsed. The grammar is `SharePointConfiguratorValues.ref`'s, plus `pages:` for a site's
 * pages and `shared` for what others have shared with the user, neither of which can be chosen.
 */
type Ref =
  | { kind: "all" }
  | { kind: "shared" }
  | { kind: "site"; siteId: string }
  | { kind: "drive"; driveId: string }
  | { kind: "folder" | "file"; driveId: string; itemId: string }
  | { kind: "list"; siteId: string; listId: string }
  | { kind: "pages"; siteId: string }
  | { kind: "page"; siteId: string; pageId: string };

const SITE_ID = /^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$/i;
const DRIVE_ID = /^b![A-Za-z0-9_-]{1,200}$/;
const ITEM_ID = /^[A-Za-z0-9!_-]{1,200}$/;

/**
 * A page token the frame hands back: a search offset, or Graph's continuation link into a drive or
 * site. The link is fetched as the user, so nothing else is accepted.
 */
function pageTokenOf(token: string): string {
  if (/^from:\d{1,6}$/.test(token)) return token;
  if (isGraphUrl(token) && /^\/v1\.0\/(drives|sites)\//.test(new URL(token).pathname)) return token;
  throw new Error("That page is no longer available. Open the folder again.");
}

/** Parses a ref, refusing anything that would put more than an ID into a Graph path. */
export function parseRef(ref: string): Ref {
  if (ref === "all") return { kind: "all" };
  if (ref === "shared") return { kind: "shared" };
  const colon = ref.indexOf(":");
  const kind = ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  const [a, b, extra] = rest.split("/");
  const ok = (test: boolean) => {
    if (!test || extra !== undefined) throw new Error("That choice isn't valid. Choose again.");
  };
  switch (kind) {
    case "site": ok(SITE_ID.test(rest)); return { kind, siteId: rest };
    case "pages": ok(SITE_ID.test(rest)); return { kind, siteId: rest };
    case "drive": ok(DRIVE_ID.test(rest)); return { kind, driveId: rest };
    case "folder":
    case "file": ok(DRIVE_ID.test(a) && b !== undefined && ITEM_ID.test(b)); return { kind, driveId: a, itemId: b! };
    case "list": ok(SITE_ID.test(a) && b !== undefined && GUID.test(b)); return { kind, siteId: a, listId: b! };
    case "page": ok(SITE_ID.test(a) && b !== undefined && GUID.test(b)); return { kind, siteId: a, pageId: b! };
    default: throw new Error("That choice isn't valid. Choose again.");
  }
}

// -- rows ---------------------------------------------------------------------------------------

/** The icon for a file, from its extension (Graph's media types are often generic). */
export function fileIcon(name: string): SharePointBrowserIcon {
  const extension = extensionOf(name);
  if (/^(docx?|docm|dotx|odt|rtf|pages)$/.test(extension)) return "document";
  if (/^(xlsx?|xlsm|xlsb|ods|numbers|csv|tsv)$/.test(extension)) return "spreadsheet";
  if (/^(pptx?|pptm|odp|key)$/.test(extension)) return "presentation";
  if (extension === "pdf") return "pdf";
  if (/^(png|jpe?g|gif|bmp|webp|heic|svg|tiff?)$/.test(extension)) return "image";
  if (/^(mp4|mov|avi|mkv|webm|wmv)$/.test(extension)) return "video";
  if (/^(mp3|wav|m4a|aac|flac|ogg|wma)$/.test(extension)) return "audio";
  if (/^(zip|7z|rar|tar|gz|tgz)$/.test(extension)) return "archive";
  if (/^(txt|md|log|rtf)$/.test(extension)) return "text";
  if (/^(json|xml|ya?ml|js|ts|py|cs|java|sql|html?|css|sh|ps1)$/.test(extension)) return "code";
  return "file";
}

/** "1.2 MB" — binary units, as SharePoint itself shows sizes. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

/** "Mar 4" this year, "Mar 4, 2024" otherwise; in UTC, the only zone the server knows. */
export function formatDate(iso: string | undefined, now = new Date()): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** SharePoint's own accounts, which modify things on nobody's behalf worth naming. */
const SYSTEM_ACCOUNTS = new Set(["System Account", "SharePoint App", "SharePoint Online Web Client Extensibility"]);

/**
 * "Modified Mar 4 by Sarah Chen", "… by you" for the viewer's own change, or as much of it as is
 * known; SharePoint's system accounts go unnamed.
 */
function modified(at: string | undefined, by: string | undefined, viewer: string | undefined): string | undefined {
  const who = by === undefined || SYSTEM_ACCOUNTS.has(by) ? undefined : by === viewer ? "you" : by;
  const date = formatDate(at);
  if (date === undefined) return who ? `Modified by ${who}` : undefined;
  return who ? `Modified ${date} by ${who}` : `Modified ${date}`;
}

/** The site's path, e.g. "/sites/engineering", or "Home site" for the tenant's root. */
function sitePath(site: GraphSite): string {
  try {
    const path = decodeURIComponent(new URL(site.webUrl).pathname).replace(/\/$/, "");
    return path === "" ? "Home site" : path;
  } catch {
    return site.webUrl;
  }
}

function siteRow(site: GraphSite, subsite = false): SharePointBrowserItem {
  return {
    value: `site:${site.id}`, title: site.name, icon: "site", navigable: true,
    subtitle: site.description?.trim() || (subsite ? `Subsite · ${sitePath(site)}` : sitePath(site)),
  };
}

function isOneDrive(drive: Pick<GraphDrive, "driveType">): boolean {
  return drive.driveType === "business" || drive.driveType === "personal";
}

/** Whose OneDrive a drive is, from the viewer's side: theirs, or someone else's. */
function oneDriveOwner(drive: GraphDrive, viewer: string | undefined): string | undefined {
  return drive.ownerName !== undefined && drive.ownerName !== viewer ? drive.ownerName : undefined;
}

/** A library, or a OneDrive: the viewer's own is "My files", as OneDrive itself calls it. */
function driveRow(drive: GraphDrive, viewer?: string): SharePointBrowserItem {
  if (isOneDrive(drive)) {
    const owner = oneDriveOwner(drive, viewer);
    return {
      value: `drive:${drive.id}`, title: owner ? `${owner}'s OneDrive` : "My files", icon: "onedrive", navigable: true,
      subtitle: owner ? "Shared with you" : "Your OneDrive",
    };
  }
  return {
    value: `drive:${drive.id}`, title: drive.name, icon: "library", navigable: true,
    subtitle: drive.description?.trim() || "Document library",
  };
}

/**
 * OneDrive's "Shared with you", beside "My files". It's a place to open, not to choose: what it
 * holds changes with every share, and a binding covers one thing.
 */
const SHARED_ROW: SharePointBrowserItem = {
  value: "shared", title: "Shared with you", icon: "shared-folder", navigable: true,
  subtitle: "What others have shared from their OneDrive", selectable: false,
  unselectableReason: "Open it to choose one of the things shared with you.",
};

/** A drive as a breadcrumb outside the OneDrive tab, where "My files" alone would not say whose. */
function driveCrumb(drive: GraphDrive, viewer: string | undefined): SharePointBrowserCrumb {
  const crumb = crumbOf(driveRow(drive, viewer));
  return isOneDrive(drive) && oneDriveOwner(drive, viewer) === undefined ? { ...crumb, title: "OneDrive" } : crumb;
}

function listRow(list: GraphList, siteId: string): SharePointBrowserItem {
  const date = formatDate(list.modifiedAt);
  return {
    value: `list:${siteId}/${list.id}`, title: list.name, icon: "list",
    subtitle: list.description?.trim() || (date ? `List · Modified ${date}` : "List"),
  };
}

function pagesRow(siteId: string): SharePointBrowserItem {
  return {
    value: `pages:${siteId}`, title: "Site Pages", icon: "pages", navigable: true,
    subtitle: "Open to choose a page", selectable: false,
    unselectableReason: "Choose one page. To include every page, choose the whole site instead.",
  };
}

function pageRow(page: GraphSitePage, siteId: string, viewer?: string): SharePointBrowserItem {
  const state = page.state === "published" ? undefined : page.state === "checkout" ? "Checked out" : "Draft";
  const subtitle = modified(page.modifiedAt, page.modifiedBy, viewer);
  return {
    value: `page:${siteId}/${page.id}`, title: page.title, icon: "page",
    ...(subtitle ? { subtitle } : {}),
    ...(state ? { badge: state } : {}),
  };
}

function itemRow(item: GraphDriveItem, viewer?: string): SharePointBrowserItem {
  const folder = item.kind === "folder" && !item.isPackage;
  const subtitle = modified(item.modifiedAt, item.modifiedBy, viewer);
  const meta = folder
    ? item.childCount === undefined ? undefined : item.childCount === 1 ? "1 item" : `${item.childCount.toLocaleString("en-US")} items`
    : item.size === undefined ? undefined : formatSize(item.size);
  return {
    value: `${folder ? "folder" : "file"}:${item.driveId}/${item.id}`,
    title: item.name,
    icon: folder ? (item.remote ? "shared-folder" : "folder") : item.isPackage ? "document" : fileIcon(item.name),
    ...(folder ? { navigable: true } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(meta ? { meta } : {}),
    ...(item.sensitivityLabel ? { badge: item.sensitivityLabel } : {}),
  };
}

function crumbOf(row: SharePointBrowserItem): SharePointBrowserCrumb {
  return { value: row.value, title: row.title, ...(row.icon ? { icon: row.icon } : {}),
    ...(row.selectable === false ? { selectable: false, ...(row.unselectableReason ? { unselectableReason: row.unselectableReason } : {}) } : {}) };
}

/** What the Sites tab says when, under `Sites.Selected`, none of the sites the user can find was granted to the app. */
const NOT_ADDED_YET = "Your organization hasn't added any sites you can open to this app yet. Ask your SharePoint admin " +
  "to add the site you want, then paste its link here.";

/** What a link refused under `Sites.Selected` may mean, beyond the user not being able to open it. */
const MAYBE_NOT_ADDED = " If it's in SharePoint, your organization may not have added its site to this app yet: ask your SharePoint admin.";

/** The picker's message when SharePoint search fails on its side, as it can for a day on a new tenant. */
function searchUnavailable(error: unknown): string | undefined {
  if (error instanceof GraphApiError && error.status >= 500) {
    return "SharePoint search isn't available right now. On a new Microsoft 365 organization it can take a day " +
      "to start working. Browse to what you want instead, or paste its link.";
  }
  return undefined;
}

/** Runs GETs in batches, keyed by request ID; an answer that is not a parseable 200 is left out. */
async function batched<T>(api: GraphApi, requests: { id: string; url: string }[], parse: (body: unknown) => T): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  for (let start = 0; start < requests.length; start += MAX_BATCH_REQUESTS) {
    const answers = await api.batch(requests.slice(start, start + MAX_BATCH_REQUESTS).map(request => ({ ...request, method: "GET" as const })));
    for (const [id, answer] of answers) {
      if (answer.status !== 200) continue;
      try {
        results.set(id, parse(answer.body));
      } catch {
        // A crumb that can't be read is left out of the path.
      }
    }
  }
  return results;
}

/** A path within a drive as a `root:/…:` address segment. */
function rootPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Whether an item is in a OneDrive other than the user's own, so reached through a share. */
function inOthersOneDrive(item: GraphDriveItem, myDriveId: string | undefined): boolean {
  return item.siteHost?.includes("-my.") === true && item.driveId !== myDriveId;
}

/**
 * Breadcrumbs for items found outside a listing (search results, pasted links): their site, their
 * library, and every folder between, looked up together. What's in someone else's OneDrive sits
 * under "Shared with you", since the user can't open that OneDrive itself, only what was shared.
 */
async function crumbsFor(api: GraphApi, items: readonly GraphDriveItem[], viewer: string | undefined,
                         myDriveId: string | undefined): Promise<Map<GraphDriveItem, SharePointBrowserCrumb[]>> {
  const requests = new Map<string, string>();
  const want = (id: string, url: string) => requests.set(id, url);
  for (const item of items) {
    const siteId = itemSiteId(item);
    if (siteId && !item.siteHost?.includes("-my.")) want(`s|${siteId}`, `sites/${siteId}?$select=${SITE_SELECT}`);
    if (!inOthersOneDrive(item, myDriveId)) want(`d|${item.driveId}`, `drives/${item.driveId}?$select=${DRIVE_SELECT}`);
    const segments = (item.parentPath ?? "").split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) {
      const prefix = segments.slice(0, depth).join("/");
      want(`f|${item.driveId}|${prefix}`, `drives/${item.driveId}/root:/${rootPath(prefix)}?$select=id,name`);
    }
  }
  const answers = await batched(api, [...requests].map(([id, url]) => ({ id, url })), body => body);
  const crumbs = new Map<GraphDriveItem, SharePointBrowserCrumb[]>();
  for (const item of items) {
    const path: SharePointBrowserCrumb[] = [];
    const siteId = itemSiteId(item);
    const siteBody = siteId ? answers.get(`s|${siteId}`) : undefined;
    if (siteBody !== undefined) path.push(crumbOf(siteRow(parseSite(siteBody))));
    const driveBody = answers.get(`d|${item.driveId}`);
    if (inOthersOneDrive(item, myDriveId)) path.push(crumbOf(SHARED_ROW));
    else if (driveBody !== undefined) path.push(driveCrumb(parseDrive(driveBody), viewer));
    const segments = (item.parentPath ?? "").split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) {
      const folder = answers.get(`f|${item.driveId}|${segments.slice(0, depth).join("/")}`) as { id?: unknown; name?: unknown } | undefined;
      if (typeof folder?.id !== "string") break;
      path.push({ value: `folder:${item.driveId}/${folder.id}`, title: typeof folder.name === "string" ? folder.name : segments[depth - 1], icon: "folder" });
    }
    crumbs.set(item, path);
  }
  return crumbs;
}

/** The SharePoint configurator frame's capability. */
@validateRpc()
export class SharePointConfiguratorUI extends RpcTarget implements SharePointConfiguratorRpc {
  readonly #exports: Cloudflare.Exports;
  readonly #userObjectId: string;
  readonly #access: SharePointAccess;
  readonly #creds;
  #status?: { at: number; value: Promise<{ identity: StoredIdentity; granted: boolean; grant: SharePointGrant | null }> };
  #oneDrive?: Promise<GraphDrive | null>;

  constructor(exports: Cloudflare.Exports, userObjectId: string, access: SharePointAccess) {
    super();
    this.#exports = exports;
    this.#userObjectId = userObjectId;
    this.#access = access;
    this.#creds = accountSource(exports, userObjectId);
  }

  async getStatus(): Promise<SharePointConfiguratorStatus> {
    // Asked again after a consent pop-up, so never answered from the cache.
    this.#status = undefined;
    const { identity, granted } = await this.#state();
    if (!granted) return { state: "needsAccess" };
    if (identity.sharePointTenant === undefined) {
      return { state: "unavailable", message: "This Microsoft 365 account has no SharePoint, so there's nothing to choose from. " +
        "Ask your Microsoft 365 administrator for a SharePoint license." };
    }
    return { state: "ready", access: this.#access, tenant: identity.sharePointTenant };
  }

  async loadItems(request: SharePointBrowserRequest): Promise<SharePointBrowserPage> {
    const query = request.query?.trim() || undefined;
    if (query !== undefined && query.length > 2048) throw new Error("That search is too long.");
    if (query !== undefined && /^https?:\/\//i.test(query)) return await this.#lookUp(query);
    const container = request.container === undefined ? undefined : parseRef(request.container);
    const token = request.pageToken === undefined ? undefined : pageTokenOf(request.pageToken);
    return await this.#read(async api => {
      if (container === undefined) {
        return request.tab === TABS.onedrive ? await this.#oneDriveRoot(api, query, token) : await this.#sitesRoot(api, query, token);
      }
      switch (container.kind) {
        case "site": return await this.#siteContents(api, container.siteId, query, token);
        case "drive": return await this.#folder(api, container.driveId, "root", query, token);
        case "folder": return await this.#folder(api, container.driveId, container.itemId, query, token);
        case "pages": return await this.#pages(api, container.siteId, query, token);
        case "shared": return await this.#shared(api, query, token);
        default: throw new Error("That can't be opened.");
      }
    });
  }

  async resourceUrlFor(ref: string): Promise<string> {
    const parsed = parseRef(ref);
    const gone = "What you chose no longer exists, or you can no longer open it. Choose again.";
    return await this.#read(async api => {
      switch (parsed.kind) {
        case "all": {
          const { identity, granted } = await this.#state();
          if (!granted) throw new Error("This Microsoft 365 connection hasn't been allowed to open SharePoint.");
          if (identity.sharePointTenant === undefined) throw new Error("This Microsoft 365 account has no SharePoint.");
          return allUrl(identity.sharePointTenant);
        }
        case "site": return (await reads.getSite(api, parsed.siteId))?.webUrl ?? Promise.reject(new Error(gone));
        case "drive": return (await reads.getDrive(api, parsed.driveId))?.webUrl ?? Promise.reject(new Error(gone));
        case "folder":
        case "file": return (await reads.getItem(api, parsed))?.webUrl ?? Promise.reject(new Error(gone));
        case "list": return (await reads.getList(api, parsed))?.webUrl ?? Promise.reject(new Error(gone));
        case "page": {
          const [page, site] = await Promise.all([reads.getPage(api, parsed), reads.getSite(api, parsed.siteId)]);
          if (page === null || site === null) throw new Error(gone);
          return pageWebUrl(page.page, site.webUrl);
        }
        case "pages": throw new Error("Choose one page, or the whole site.");
        case "shared": throw new Error("Choose one of the things shared with you.");
      }
    });
  }

  async locate(resourceUrl: string): Promise<SharePointLocated | null> {
    try {
      const found = await this.#locate(resourceUrl);
      if (found === null) return { ref: "all", title: ALL_TITLE, tab: TABS.sites, path: [] };
      return { ref: found.row.value, title: found.row.title, tab: found.tab, path: found.path };
    } catch (error) {
      if (error instanceof UnresolvableUrlError) return null;
      throw error;
    }
  }

  // -- places ---------------------------------------------------------------------------------

  /** The Sites tab: the home site and followed sites first, then every site Microsoft Search finds. */
  async #sitesRoot(api: GraphApi, query: string | undefined, token: string | undefined): Promise<SharePointBrowserPage> {
    const from = token === undefined ? 0 : Number(token.replace(/^from:/, ""));
    if (!Number.isInteger(from) || from < 0) throw new Error("That page of sites has expired. Search again.");
    const selected = await this.#selected();
    const page = await reads.browseSites(api, query, from, PAGE_SIZE, selected);
    if (page.searchError !== undefined && searchUnavailable(page.searchError) === undefined) throw page.searchError;
    const items = page.sites.map(site => siteRow(site));
    const notice = selected && items.length === 0 && from === 0 ? (query === undefined ? NOT_ADDED_YET : undefined)
      : page.searchError !== undefined
      ? "Showing your home site and the sites you follow, because SharePoint search isn't available right now. Paste a link to choose any other site."
      : items.length === 0 && from === 0 ? (query === undefined ? "You can't open any SharePoint sites yet." : undefined) : undefined;
    return { items, ...(page.nextFrom !== undefined ? { nextPageToken: `from:${page.nextFrom}` } : {}), ...(notice ? { notice } : {}) };
  }

  /** The OneDrive tab: the user's own OneDrive, to open or choose, and what others have shared; searched, the OneDrive's matches. */
  async #oneDriveRoot(api: GraphApi, query: string | undefined, token: string | undefined): Promise<SharePointBrowserPage> {
    // Under Sites.Selected nobody else's OneDrive is granted, so nothing shared from one can be opened.
    const { grant } = await this.#state();
    if (grant?.sites === "selected" && !grant.oneDrive) {
      return { items: [], notice: "Your organization hasn't included OneDrive in this app, so choose from Sites instead." };
    }
    const shared = grant?.sites === "selected" ? [] : [SHARED_ROW];
    const drive = await this.#myOneDrive(api);
    if (drive === null) return { items: shared, notice: "You don't have a OneDrive of your own." };
    if (query === undefined) return { items: [driveRow(drive, await this.#viewer()), ...shared] };
    return await this.#folder(api, drive.id, "root", query, token);
  }

  /**
   * What others have shared with the user from their OneDrives, newest first; searched, the matches.
   * Unsearched, a shared folder's contents are left to opening it, as OneDrive shows them, though
   * only within a page: Search can put a folder and what's in it on different pages.
   */
  async #shared(api: GraphApi, query: string | undefined, token: string | undefined): Promise<SharePointBrowserPage> {
    const from = token === undefined ? 0 : Number(token.replace(/^from:/, ""));
    if (!Number.isInteger(from) || from < 0) throw new Error("That page has expired. Open Shared with you again.");
    if (await this.#selected()) return { items: [], notice: "Files shared from other people's OneDrives can't be opened through this app." };
    const [mine, viewer, { identity }] = await Promise.all([this.#myOneDrive(api), this.#viewer(), this.#state()]);
    // Every OneDrive lives beside the user's own; without one, where the tenant's usually do.
    const oneDrives = mine === null ? undefined : /^(https:\/\/[^/]+\/personal\/)[^/]+/.exec(mine.webUrl);
    const base = oneDrives?.[1] ?? (identity.sharePointTenant ? `https://${identity.sharePointTenant}-my.sharepoint.com/personal/` : undefined);
    if (base === undefined) return { items: [], notice: "This Microsoft 365 account has no SharePoint." };
    let page;
    try {
      page = await reads.searchSharedWithMe(api, base, oneDrives?.[0], query, from, SEARCH_PAGE_SIZE);
    } catch (error) {
      const unavailable = searchUnavailable(error);
      if (unavailable === undefined) throw error;
      return { items: [], notice: unavailable };
    }
    const found = (await reads.getItems(api, page.hits)).filter((item): item is GraphDriveItem => item !== null);
    const folders = new Set(found.filter(item => item.kind === "folder" && !item.isPackage)
      .map(item => `${item.driveId}|${[item.parentPath, item.name].filter(Boolean).join("/")}`));
    const shown = query !== undefined ? found : found.filter(item => {
      const segments = (item.parentPath ?? "").split("/").filter(Boolean);
      return !segments.some((_, depth) => folders.has(`${item.driveId}|${segments.slice(0, depth + 1).join("/")}`));
    });
    const crumbs = await crumbsFor(api, shown, viewer, mine?.id);
    const notice = shown.length === 0 && from === 0 && query === undefined
      ? "Nothing has been shared with you from anyone's OneDrive yet. Something shared in the last few minutes can take a while to appear here: paste its link to choose it now."
      : undefined;
    return {
      items: shown.map(item => ({ ...itemRow(item, viewer), path: crumbs.get(item) ?? [] })),
      ...(page.nextFrom !== undefined ? { nextPageToken: `from:${page.nextFrom}` } : {}),
      ...(notice ? { notice } : {}),
    };
  }

  /** A site's libraries, lists, pages and subsites; or, searched, the ones named so and its files. */
  async #siteContents(api: GraphApi, siteId: string, query: string | undefined, token: string | undefined): Promise<SharePointBrowserPage> {
    if (query !== undefined && token !== undefined) return await this.#searchSite(api, siteId, query, token, []);
    const site = await reads.getSite(api, siteId);
    if (site === null) throw new Error("That site no longer exists, or you can no longer open it.");
    const [drives, lists, subsites] = await Promise.all([
      reads.listDrives(api, siteId), reads.listLists(api, siteId), reads.listSubsites(api, siteId).catch(() => []),
    ]);
    const rows = [
      ...drives.map(drive => driveRow(drive)),
      ...lists.lists.map(list => listRow(list, siteId)),
      ...(lists.hasPages ? [pagesRow(siteId)] : []),
      ...subsites.map(sub => siteRow(sub, true)),
    ];
    if (query === undefined) return { items: rows };
    const needle = query.toLowerCase();
    const named = rows.filter(row => row.title.toLowerCase().includes(needle)).map(row => ({ ...row, path: [crumbOf(siteRow(site))] }));
    return await this.#searchSite(api, siteId, query, undefined, named, site);
  }

  /** Files in a site matching a search, after whatever of the site's own contents matched by name. */
  async #searchSite(api: GraphApi, siteId: string, query: string, token: string | undefined,
                    named: SharePointBrowserItem[], known?: GraphSite): Promise<SharePointBrowserPage> {
    const site = known ?? await reads.getSite(api, siteId);
    if (site === null) throw new Error("That site no longer exists, or you can no longer open it.");
    const from = token === undefined ? 0 : Number(token.replace(/^from:/, ""));
    if (!Number.isInteger(from) || from < 0) throw new Error("That page of results has expired. Search again.");
    try {
      const hits = await reads.searchAll(api, query, site.webUrl, from, SEARCH_PAGE_SIZE);
      const found = (await reads.getItems(api, hits.hits)).filter((item): item is GraphDriveItem => item !== null);
      const viewer = await this.#viewer();
      const crumbs = await crumbsFor(api, found, viewer, (await this.#myOneDrive(api))?.id);
      return {
        items: [...named, ...found.map(item => ({ ...itemRow(item, viewer), path: crumbs.get(item) ?? [] }))],
        ...(hits.nextFrom !== undefined ? { nextPageToken: `from:${hits.nextFrom}` } : {}),
      };
    } catch (error) {
      const unavailable = searchUnavailable(error);
      if (unavailable === undefined) throw error;
      return { items: named, notice: unavailable };
    }
  }

  /** A folder's contents; or, searched, the matches anywhere inside it. */
  async #folder(api: GraphApi, driveId: string, itemId: string, query: string | undefined, token: string | undefined): Promise<SharePointBrowserPage> {
    const viewer = await this.#viewer();
    if (query === undefined) {
      const page = await reads.listChildren(api, { driveId, itemId }, token, PAGE_SIZE);
      // Folders first, as SharePoint lists them, within each page Graph returns in name order.
      const rows = [...page.items.filter(item => item.kind === "folder" && !item.isPackage),
        ...page.items.filter(item => item.kind !== "folder" || item.isPackage)].map(item => itemRow(item, viewer));
      return { items: rows, ...(page.nextLink ? { nextPageToken: page.nextLink } : {}) };
    }
    // Graph searches a whole drive; a folder's search keeps the hits inside it.
    const within = itemId === "root" ? undefined : await reads.getItem(api, { driveId, itemId });
    const prefix = within ? [within.parentPath, within.name].filter(Boolean).join("/") : undefined;
    let page;
    try {
      page = await reads.searchDrive(api, driveId, query, token, SEARCH_PAGE_SIZE);
    } catch (error) {
      const unavailable = searchUnavailable(error);
      if (unavailable === undefined) throw error;
      return { items: [], notice: unavailable };
    }
    const found = page.items.filter(item => !item.isRoot && (prefix === undefined
      || item.parentPath === prefix || (item.parentPath ?? "").startsWith(`${prefix}/`)));
    const crumbs = await crumbsFor(api, found, viewer, (await this.#myOneDrive(api))?.id);
    return {
      items: found.map(item => ({ ...itemRow(item, viewer), path: crumbs.get(item) ?? [] })),
      ...(page.nextLink ? { nextPageToken: page.nextLink } : {}),
    };
  }

  /** A site's pages; searched, those whose title matches. */
  async #pages(api: GraphApi, siteId: string, query: string | undefined, token: string | undefined): Promise<SharePointBrowserPage> {
    const [page, viewer] = await Promise.all([reads.listPages(api, siteId, token, PAGE_SIZE), this.#viewer()]);
    const needle = query?.toLowerCase();
    const shown = page.items.filter(item => needle === undefined || item.title.toLowerCase().includes(needle));
    // SharePoint makes pages that share a title (a site's `Home.aspx` and its `TopicHome.aspx`), so
    // those are told apart by file name.
    const titles = new Map<string, number>();
    for (const item of shown) titles.set(item.title, (titles.get(item.title) ?? 0) + 1);
    const rows = shown.map(item => {
      const row = pageRow(item, siteId, viewer);
      return (titles.get(item.title) ?? 0) > 1 ? { ...row, subtitle: [item.name, row.subtitle].filter(Boolean).join(" · ") } : row;
    });
    return { items: rows, ...(page.nextLink ? { nextPageToken: page.nextLink } : {}) };
  }

  // -- links ----------------------------------------------------------------------------------

  /** A pasted link, as the one row it names. */
  async #lookUp(url: string): Promise<SharePointBrowserPage> {
    if (parseSharePointUrl(url) === null) {
      return { items: [], notice: "That isn't a SharePoint or OneDrive link. Paste a link from your browser's address bar, or a sharing link." };
    }
    let found;
    try {
      found = await this.#locate(url);
    } catch (error) {
      if (error instanceof SiteNotGrantedError) return { items: [], notice: error.message };
      if (error instanceof UnresolvableUrlError) return { items: [], notice: error.message + (await this.#selected() ? MAYBE_NOT_ADDED : "") };
      throw error;
    }
    if (found === null) {
      return { items: [], notice: `That link is to all of SharePoint. Choose “${ALL_TITLE}” above.` };
    }
    return { items: [{ ...found.row, path: found.path }] };
  }

  /** Where a URL sits in the picker: its row, its tab, and the places above it. Null for "all". */
  async #locate(url: string): Promise<{ row: SharePointBrowserItem; tab: string; path: SharePointBrowserCrumb[] } | null> {
    const { identity, grant } = await this.#state();
    const tenant = identity.sharePointTenant;
    if (tenant === undefined) throw new UnresolvableUrlError("This Microsoft 365 account has no SharePoint.");
    return await this.#read(async api => {
      const resolved = await resolveSharePointUrl(api, url, tenant, { selected: grant?.sites === "selected" });
      const scope = resolved.scope;
      const siteCrumb = async (siteId: string) => {
        const site = await reads.getSite(api, siteId);
        return site && !site.personal ? [crumbOf(siteRow(site))] : [];
      };
      switch (scope.kind) {
        case "all": return null;
        case "site": {
          const site = await reads.getSite(api, scope.siteId);
          if (site === null) throw new UnresolvableUrlError();
          return { row: siteRow(site), tab: TABS.sites, path: [] };
        }
        case "library": {
          const drive = await reads.getDrive(api, scope.driveId);
          if (drive === null) throw new UnresolvableUrlError();
          const oneDrive = isOneDrive(drive);
          return { row: driveRow(drive, identity.name), tab: oneDrive ? TABS.onedrive : TABS.sites, path: oneDrive ? [] : await siteCrumb(scope.siteId) };
        }
        case "folder":
        case "file": {
          const item = await reads.getItem(api, scope);
          if (item === null) throw new UnresolvableUrlError();
          const path = (await crumbsFor(api, [item], identity.name, (await this.#myOneDrive(api))?.id)).get(item) ?? [];
          const oneDrive = item.siteHost?.includes("-my.") === true;
          return { row: itemRow(item, identity.name), tab: oneDrive ? TABS.onedrive : TABS.sites, path };
        }
        case "list": {
          const list = await reads.getList(api, scope);
          if (list === null) throw new UnresolvableUrlError();
          return { row: listRow(list, scope.siteId), tab: TABS.sites, path: await siteCrumb(scope.siteId) };
        }
        case "page": {
          const page = await reads.getPage(api, scope);
          if (page === null) throw new UnresolvableUrlError();
          return { row: pageRow(page.page, scope.siteId, identity.name), tab: TABS.sites, path: [...await siteCrumb(scope.siteId), crumbOf(pagesRow(scope.siteId))] };
        }
      }
    });
  }

  // -- the connection -------------------------------------------------------------------------

  #account() {
    return this.#exports.UserAccount.get(this.#exports.UserAccount.idFromString(this.#userObjectId));
  }

  /** The connected identity, whether the grant covers SharePoint, and what of it, reused briefly. */
  #state(): Promise<{ identity: StoredIdentity; granted: boolean; grant: SharePointGrant | null }> {
    const now = Date.now();
    if (this.#status === undefined || now - this.#status.at >= STATUS_TTL_MS) {
      const account = this.#account();
      const value = Promise.all([account.getIdentity(), account.getGrantedScopes()])
        .then(([identity, scopes]) => ({
          identity, granted: grantedResourcePatterns(scopes).includes(SHAREPOINT_RESOURCE.urlPattern), grant: grantedSharePoint(scopes),
        }));
      const entry = { at: now, value };
      // A failure isn't kept, so the next request asks again.
      value.catch(() => {
        if (this.#status === entry) this.#status = undefined;
      });
      this.#status = entry;
    }
    return this.#status.value;
  }

  /** The user's own OneDrive, or null if they have none, read once while the frame is open. */
  #myOneDrive(api: GraphApi): Promise<GraphDrive | null> {
    if (this.#oneDrive === undefined) {
      const drive = api.find<unknown>("/me/drive", { query: { $select: DRIVE_SELECT } }).then(body => body === null ? null : parseDrive(body));
      // A failure isn't kept, so the next request asks again.
      drive.catch(() => {
        if (this.#oneDrive === drive) this.#oneDrive = undefined;
      });
      this.#oneDrive = drive;
    }
    return this.#oneDrive;
  }

  /** Whether the grant reaches only the sites a SharePoint admin granted the app. */
  async #selected(): Promise<boolean> {
    return (await this.#state()).grant?.sites === "selected";
  }

  /** The connected user's display name, for "Modified by you". */
  async #viewer(): Promise<string> {
    return (await this.#state()).identity.name;
  }

  async #read<T>(op: (api: GraphApi) => Promise<T>): Promise<T> {
    return await this.#creds.run(creds => op(new GraphApi(creds.accessToken)), { replayable: true });
  }
}
