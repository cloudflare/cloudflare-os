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

/** The tenant a connection is pinned to: its SharePoint name (`contoso` for contoso.sharepoint.com) and its Entra ID. */
export type ConnectedTenant = { name: string; id: string };

/**
 * Passes a Graph answer on only if it may be trusted to be the connected tenant's.
 * @throws UnresolvableUrlError for one that is another organization's.
 */
type Owned = <T>(body: T) => T;

/** A link Graph resolved, to something it doesn't place in the connected tenant. */
export class OtherOrganizationError extends UnresolvableUrlError {
  constructor(hostname: string) {
    super(`That link is to another organization's SharePoint (${hostname}), which this connection can't open.`);
    this.name = "OtherOrganizationError";
  }
}

/** Statuses that mean "not this facet, or not visible": try the next. */
const MISS = [400, 403, 404];

/** A site's or a list's fields with the IDs that name its tenant, which items and list items always carry. */
const OWNED_SITE_SELECT = `${SITE_SELECT},sharepointIds`;
const OWNED_LIST_SELECT = `${LIST_SELECT},sharepointIds`;

/** Where Graph says an object is, as far as it says: its Entra tenant, lower-cased, and its site's host. */
function placeOf(body: unknown): { tenantId?: string; host?: string } {
  const ids = (body as { sharepointIds?: { tenantId?: unknown; siteUrl?: unknown } } | null)?.sharepointIds;
  return {
    ...(typeof ids?.tenantId === "string" ? { tenantId: ids.tenantId.toLowerCase() } : {}),
    ...(typeof ids?.siteUrl === "string" && URL.canParse(ids.siteUrl) ? { host: new URL(ids.siteUrl).hostname } : {}),
  };
}

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
  // The host Graph gives for the item's site, not the link's: a link kept alive from before a move
  // between geographies resolves to where the item is now.
  const siteId = siteIdOf(item.siteHost ?? host, item);
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
async function fromPageItem(api: GraphApi, shareId: string, owned: Owned): Promise<ResolvedUrl | null> {
  const body = await api.request<Record<string, unknown>>("GET", `/shares/${shareId}/listItem`, {
    query: { $select: "id,webUrl,sharepointIds,parentReference" },
    allow: MISS,
  });
  if (body === null) return null;
  owned(body);
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
async function fromSitePath(api: GraphApi, url: URL, owned: Owned): Promise<ResolvedUrl | null> {
  const path = sitePathNamed(url);
  if (path === null) return null;
  const body = await api.request<unknown>("GET", `/sites/${url.hostname}:${path}`, { query: { $select: OWNED_SITE_SELECT }, allow: MISS });
  return body === null ? null : fromSite(parseSite(owned(body)));
}

/**
 * Resolves a URL to the scope it names.
 * @param tenant The connected tenant. What Graph resolves is refused as another organization's
 * when Graph places it in another tenant. Where Graph doesn't say, the tenant's own SharePoint host
 * stands for it. A multi-geo tenant has a host per geography, which no user's token can list, so on
 * any other host Graph must say.
 * @param options.selected Whether the grant reaches only the sites granted to the app. Graph then
 * still answers any site's metadata, so a site is checked by opening its library.
 * @throws UnresolvableUrlError for anything that is not a reachable SharePoint object, its
 * OtherOrganizationError for one Graph resolved outside the connected tenant, and its
 * SiteNotGrantedError for a site the app wasn't granted.
 */
export async function resolveSharePointUrl(api: GraphApi, raw: string, tenant: ConnectedTenant, options: { selected?: boolean } = {}): Promise<ResolvedUrl> {
  const resolved = await resolveUrl(api, raw, tenant);
  if (options.selected && resolved.scope.kind === "site") {
    const drive = await api.request<unknown>("GET", `/sites/${resolved.scope.siteId}/drive`, { query: { $select: "id" }, allow: MISS });
    if (drive === null) throw new SiteNotGrantedError();
  }
  return resolved;
}

/**
 * The URL as SharePoint's, or a refusal that says what is wrong with it. Graph isn't asked, so a
 * caller may pass this refusal on where it must keep Graph's quiet.
 * @throws UnresolvableUrlError for a URL that is not SharePoint's.
 */
export function checkSharePointUrl(raw: string): URL {
  const url = parseSharePointUrl(raw);
  if (url === null) throw new UnresolvableUrlError("That isn't a SharePoint or OneDrive link.");
  return url;
}

async function resolveUrl(api: GraphApi, raw: string, tenant: ConnectedTenant): Promise<ResolvedUrl> {
  const url = checkSharePointUrl(raw);
  // Off the tenant's own host, only Microsoft's word for where an object is makes it this tenant's.
  // That goes for the host Graph resolved the link to as well as the link's: a link may be kept
  // alive as a redirect. And no host excuses an object Microsoft places in another tenant.
  const own = (hostname: string) => parseSharePointHost(hostname)?.tenant === tenant.name;
  const known = own(url.hostname);
  const owned: Owned = body => {
    const { tenantId, host } = placeOf(body);
    const refused = tenantId === undefined ? !(known && (host === undefined || own(host))) : tenantId !== tenant.id.toLowerCase();
    if (refused) throw new OtherOrganizationError(url.hostname);
    return body;
  };
  if (isAllUrl(url)) {
    if (!known) throw new OtherOrganizationError(url.hostname);
    return { scope: { kind: "all" }, name: "SharePoint & OneDrive", webUrl: allUrl(tenant.name) };
  }

  const shareId = shareIdFor(normalizeForShares(url));
  try {
    if (isSiteRootPath(url)) {
      const site = await facet(api, shareId, "site", OWNED_SITE_SELECT, body => parseSite(owned(body)));
      if (site !== null) return fromSite(site);
    }
    if (isSitePagesUrl(url)) {
      const page = await fromPageItem(api, shareId, owned);
      if (page !== null) return page;
    }
    const item = await facet(api, shareId, "driveItem", ITEM_SELECT, body => parseDriveItem(owned(body)));
    if (item !== null) return fromItem(url.hostname, item);
    const list = await facet(api, shareId, "list", OWNED_LIST_SELECT, body => parseList(owned(body)));
    if (list !== null) return await fromList(api, list);
    const site = await fromSitePath(api, url, owned);
    if (site !== null) return site;
  } catch (error) {
    if (error instanceof GraphApiError && MISS.includes(error.status)) throw new UnresolvableUrlError();
    throw error;
  }
  throw new UnresolvableUrlError();
}
