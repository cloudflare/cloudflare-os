// Turns a SharePoint or OneDrive URL into the scope it names, asking Graph as the connected user.
// Graph's `/shares/{u!…}` endpoint resolves almost every URL the browser shows (not only sharing
// links) without redeeming anything, provided it is asked for the right facet: `/site`, `/list`,
// `/driveItem`, or `/listItem`. The facets are tried in an order verified against a live tenant to
// resolve each kind of URL unambiguously. A link the user cannot open fails like one that does not
// exist.

import { GraphApiError, type GraphApi } from "./graph-api";
import {
  ITEM_SELECT, LIST_SELECT, SITE_SELECT, canonicalSiteId, parseDriveItem, parseList, parseSite,
  type GraphDriveItem, type GraphList, type GraphSite,
} from "./graph-parse";
import type { SharePointScope } from "./sharepoint-scope";
import {
  allUrl, isAllUrl, isSitePagesUrl, isSiteRootPath, normalizeForShares, parseSharePointHost, parseSharePointUrl,
  shareIdFor, sitePathNamed,
} from "./sharepoint-urls";

/** A resolved URL: the scope it names and what to call it. */
export type ResolvedUrl = {
  scope: SharePointScope;
  /** The object's own name: the site, library, folder, file, list, or page title. */
  name: string;
  webUrl: string;
};

/** The refusal for a URL Graph could not resolve, whatever the reason. */
export class UnresolvableUrlError extends Error {
  constructor(message = "That link doesn't lead to anything in SharePoint or OneDrive you can open.") {
    super(message);
    this.name = "UnresolvableUrlError";
  }
}

/** A link to a site the user can open, but that hasn't been granted to the app under `Sites.Selected`. */
export class SiteNotGrantedError extends UnresolvableUrlError {
  constructor() {
    super("Your organization hasn't added that site to this app yet. Ask your SharePoint admin to add it.");
    this.name = "SiteNotGrantedError";
  }
}

/** Statuses that mean "not this facet, or not visible": try the next. */
const MISS = [400, 403, 404];

/** Asks Graph for one facet of a URL, or null when that facet does not apply. */
async function facet<T>(api: GraphApi, shareId: string, path: string, select: string, parse: (body: unknown) => T): Promise<T | null> {
  const body = await api.request<unknown>("GET", `/shares/${shareId}/${path}`, { query: { $select: select }, allow: MISS });
  return body === null ? null : parse(body);
}

/** The composite site ID of the web an item or list lives in, or null when Graph omitted it. */
function siteIdOf(host: string, ids: { siteCollectionId?: string; webId?: string }): string | null {
  if (ids.siteCollectionId === undefined || ids.webId === undefined) return null;
  return canonicalSiteId(`${host},${ids.siteCollectionId},${ids.webId}`);
}

function fromSite(site: GraphSite): ResolvedUrl {
  return { scope: { kind: "site", siteId: site.id }, name: site.name, webUrl: site.webUrl };
}

function fromItem(host: string, item: GraphDriveItem): ResolvedUrl {
  const siteId = siteIdOf(host, item);
  if (siteId === null) throw new UnresolvableUrlError();
  if (item.isRoot) {
    return { scope: { kind: "library", siteId, driveId: item.driveId }, name: item.name, webUrl: item.webUrl };
  }
  return {
    scope: { kind: item.kind === "folder" ? "folder" : "file", siteId, driveId: item.driveId, itemId: item.id },
    name: item.name,
    webUrl: item.webUrl,
  };
}

async function fromList(api: GraphApi, list: GraphList): Promise<ResolvedUrl> {
  if (list.siteId === undefined) throw new UnresolvableUrlError();
  if (list.template === "documentLibrary") {
    // A library's list URL means the library, which files are read through as a drive.
    const drive = await api.find<{ id?: unknown }>(`/sites/${list.siteId}/lists/${list.id}/drive`, { query: { $select: "id" } });
    if (typeof drive?.id !== "string") throw new UnresolvableUrlError();
    return { scope: { kind: "library", siteId: list.siteId, driveId: drive.id }, name: list.name, webUrl: list.webUrl };
  }
  return { scope: { kind: "list", siteId: list.siteId, listId: list.id }, name: list.name, webUrl: list.webUrl };
}

/** A page's list item, as `/shares/…/listItem` returns it. */
async function fromPageItem(api: GraphApi, shareId: string): Promise<ResolvedUrl | null> {
  const body = await api.request<Record<string, unknown>>("GET", `/shares/${shareId}/listItem`, {
    query: { $select: "id,webUrl,sharepointIds,parentReference" },
    allow: MISS,
  });
  if (body === null) return null;
  const ids = body.sharepointIds as Record<string, unknown> | undefined;
  const parent = body.parentReference as Record<string, unknown> | undefined;
  const siteId = typeof parent?.siteId === "string" ? canonicalSiteId(parent.siteId) : null;
  const pageId = typeof ids?.listItemUniqueId === "string" ? ids.listItemUniqueId.toLowerCase() : null;
  if (siteId === null || pageId === null) return null;
  // The page's own title, which the list item does not carry.
  const page = await api.find<{ title?: unknown; name?: unknown; webUrl?: unknown }>(
    `/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage`, { query: { $select: "title,name,webUrl" } });
  if (page === null) return null;
  const name = typeof page.title === "string" && page.title !== "" ? page.title
    : typeof page.name === "string" ? page.name.replace(/\.aspx$/i, "") : "Page";
  return {
    scope: { kind: "page", siteId, pageId },
    name,
    webUrl: typeof body.webUrl === "string" ? body.webUrl : "",
  };
}

/**
 * The web a URL names, when it names nothing inside one. A link to a file, folder, list or page
 * the facets couldn't resolve (removed, renamed, or never visible) is refused rather than widened
 * to its web: this also runs when a configurator's selection is bound, and a binding only narrows.
 */
async function fromSitePath(api: GraphApi, url: URL): Promise<ResolvedUrl | null> {
  const path = sitePathNamed(url);
  if (path === null) return null;
  const body = await api.request<unknown>("GET", `/sites/${url.hostname}:${path}`, { query: { $select: SITE_SELECT }, allow: MISS });
  return body === null ? null : fromSite(parseSite(body));
}

/**
 * Resolves a URL to the scope it names.
 * @param tenant The connected tenant's SharePoint name (`contoso` for contoso.sharepoint.com); a
 * URL on any other tenant's host is refused before Graph is asked.
 * @param options.selected Whether the grant reaches only the sites granted to the app. Graph then
 * still answers any site's metadata, so a site is checked by opening its library.
 * @throws UnresolvableUrlError for anything that is not a reachable SharePoint object, and its
 * SiteNotGrantedError for a site the app wasn't granted.
 */
export async function resolveSharePointUrl(api: GraphApi, raw: string, tenant: string, options: { selected?: boolean } = {}): Promise<ResolvedUrl> {
  const resolved = await resolveUrl(api, raw, tenant);
  if (options.selected && resolved.scope.kind === "site") {
    const drive = await api.request<unknown>("GET", `/sites/${resolved.scope.siteId}/drive`, { query: { $select: "id" }, allow: MISS });
    if (drive === null) throw new SiteNotGrantedError();
  }
  return resolved;
}

/**
 * The URL as this tenant's SharePoint, or a refusal that says what is wrong with it. Nothing past
 * this step asks Graph, so a caller may pass these refusals on where it must keep Graph's quiet.
 * @throws UnresolvableUrlError for a URL that is not SharePoint's, or is another tenant's.
 */
export function checkSharePointUrl(raw: string, tenant: string): URL {
  const url = parseSharePointUrl(raw);
  if (url === null) throw new UnresolvableUrlError("That isn't a SharePoint or OneDrive link.");
  if (parseSharePointHost(url.hostname)!.tenant !== tenant) {
    throw new UnresolvableUrlError(`That link is to another organization's SharePoint (${url.hostname}), ` +
      "which this connection can't open.");
  }
  return url;
}

async function resolveUrl(api: GraphApi, raw: string, tenant: string): Promise<ResolvedUrl> {
  const url = checkSharePointUrl(raw, tenant);
  if (isAllUrl(url)) {
    return { scope: { kind: "all" }, name: "SharePoint & OneDrive", webUrl: allUrl(tenant) };
  }

  const shareId = shareIdFor(normalizeForShares(url));
  try {
    if (isSiteRootPath(url)) {
      const site = await facet(api, shareId, "site", SITE_SELECT, parseSite);
      if (site !== null) return fromSite(site);
    }
    if (isSitePagesUrl(url)) {
      const page = await fromPageItem(api, shareId);
      if (page !== null) return page;
    }
    const item = await facet(api, shareId, "driveItem", ITEM_SELECT, parseDriveItem);
    if (item !== null) return fromItem(url.hostname, item);
    const list = await facet(api, shareId, "list", LIST_SELECT, parseList);
    if (list !== null) return await fromList(api, list);
    const site = await fromSitePath(api, url);
    if (site !== null) return site;
  } catch (error) {
    if (error instanceof GraphApiError && MISS.includes(error.status)) throw new UnresolvableUrlError();
    throw error;
  }
  throw new UnresolvableUrlError();
}
