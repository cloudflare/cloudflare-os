// The Graph reads the SharePoint sessions and configurator make, one function per question. Each
// takes a `GraphApi`, asks for exactly the fields its parser keeps, and returns parsed values; none
// decides what is in scope (sharepoint-scope.ts) or what an observer may see (the sessions do).

import { GraphApiError, MAX_BATCH_REQUESTS, isGraphUrl, type GraphApi } from "./graph-api";
import {
  DRIVE_SELECT, ITEM_SELECT, LIST_SELECT, PAGE_SELECT, SITE_SELECT, optRecord, optStr,
  parseColumn, parseDrive, parseDriveItem, parseList, parseListItem, parsePage, parseRange, parseSite,
  parseSitePage, parseVersion, parseWorksheet, record, versionOf,
  type GraphColumn, type GraphDrive, type GraphDriveItem, type GraphList, type GraphListItem, type GraphRange, type GraphSite,
  type GraphSitePage, type GraphVersion, type GraphWorksheet,
} from "./graph-parse";
import type { ItemRef, ListRef, PageRef } from "./sharepoint-scope";

type Page<T> = { items: T[]; nextLink?: string };

/** A `nextLink` Graph returned, checked to still point at Graph before it is followed. */
function next(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  if (!isGraphUrl(link)) throw new GraphApiError(502, "Microsoft Graph returned a continuation link to somewhere else.");
  return link;
}

/** One page of a collection: the first from `path` and `query`, later ones from the opaque token. */
async function page<T>(api: GraphApi, token: string | undefined, path: string, query: Record<string, string | number | undefined>,
                       parse: (row: unknown) => T, what: string, prefer?: string[]): Promise<Page<T>> {
  const body = token === undefined
    ? await api.get<unknown>(path, { query, ...(prefer ? { prefer } : {}) })
    : await api.get<unknown>(next(token)!, prefer ? { prefer } : {});
  const parsed = parsePage(body, parse, what);
  return { items: parsed.items, ...(parsed.nextLink ? { nextLink: next(parsed.nextLink) } : {}) };
}

/** The most rows a whole collection is walked for; a site with more libraries or lists than this is truncated, not looped on. */
const MAX_WALKED = 1000;

/** Every page of a collection, up to `MAX_WALKED` rows. */
async function all<T>(api: GraphApi, path: string, query: Record<string, string | number | undefined>,
                      parse: (row: unknown) => T, what: string): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const found = await page(api, token, path, query, parse, what);
    items.push(...found.items);
    token = found.nextLink;
  } while (token !== undefined && items.length < MAX_WALKED);
  return items;
}

// -- items --------------------------------------------------------------------------------------

/**
 * The user's own roles on an item or a drive's root (`write`, `read`, `owner`), or null when Graph
 * doesn't say. Graph reports them as `shared.effectiveRoles` on whatever is shared, which isn't
 * documented, so a caller may use them only to lower what it allows.
 */
export async function effectiveRoles(api: GraphApi, ref: { driveId: string; itemId?: string }): Promise<string[] | null> {
  const path = ref.itemId === undefined ? `/drives/${ref.driveId}/root` : `/drives/${ref.driveId}/items/${ref.itemId}`;
  const body = await api.find<{ shared?: { effectiveRoles?: unknown } }>(path, { query: { $select: "id,shared" } });
  const roles = body?.shared?.effectiveRoles;
  return Array.isArray(roles) && roles.length > 0 && roles.every(role => typeof role === "string") ? roles : null;
}

/** An item by ID, or null when it does not exist or the user cannot open it. */
export async function getItem(api: GraphApi, ref: ItemRef): Promise<GraphDriveItem | null> {
  const body = await api.find<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}`, { query: { $select: ITEM_SELECT } });
  return body === null ? null : parseDriveItem(body);
}

/**
 * The version of a file the reader is shown, `_UIVersionString` from its list item (`3.0`, or a
 * draft's `3.1`), with its approval state where the library moderates content. Empty where the
 * file has none to report.
 */
export async function fileVersion(api: GraphApi, ref: ItemRef): Promise<{ version?: string; moderation?: number }> {
  const fields = await api.find<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}/listItem/fields`, {
    query: { $select: "_UIVersionString,_ModerationStatus" },
  });
  return versionOf(fields !== null && typeof fields === "object" ? fields as Record<string, unknown> : undefined);
}

/** Graph's sort parameter for each listing order. Folders first is the default for "name". */
const ORDER_BY: Record<string, string> = { name: "name", modified: "lastModifiedDateTime desc", size: "size desc" };

/** One page of a folder's children. */
export function listChildren(api: GraphApi, folder: ItemRef, token: string | undefined, top: number,
                             orderBy: "name" | "modified" | "size" = "name"): Promise<Page<GraphDriveItem>> {
  return page(api, token, `/drives/${folder.driveId}/items/${folder.itemId}/children`,
    { $select: ITEM_SELECT, $top: top, $orderby: ORDER_BY[orderBy] }, parseDriveItem, "folder");
}

/** A drive's root folder. */
export async function getRoot(api: GraphApi, driveId: string): Promise<GraphDriveItem | null> {
  const body = await api.find<unknown>(`/drives/${driveId}/root`, { query: { $select: ITEM_SELECT } });
  return body === null ? null : parseDriveItem(body);
}

/** Many items at once, batched; a missing or forbidden one is null. */
export async function getItems(api: GraphApi, refs: readonly ItemRef[]): Promise<(GraphDriveItem | null)[]> {
  const results: (GraphDriveItem | null)[] = Array.from({ length: refs.length }, () => null);
  for (let start = 0; start < refs.length; start += MAX_BATCH_REQUESTS) {
    const chunk = refs.slice(start, start + MAX_BATCH_REQUESTS);
    const answers = await api.batch(chunk.map((ref, index) => ({
      id: String(start + index), method: "GET" as const, url: `drives/${ref.driveId}/items/${ref.itemId}?$select=${ITEM_SELECT}`,
    })));
    chunk.forEach((_, index) => {
      const answer = answers.get(String(start + index));
      if (answer && answer.status === 200) results[start + index] = parseDriveItem(answer.body);
    });
  }
  return results;
}

/** One page of a drive search. Graph searches names and content within the whole drive. */
export function searchDrive(api: GraphApi, driveId: string, query: string, token: string | undefined, top: number): Promise<Page<GraphDriveItem>> {
  // OData string literal inside a function call: single quotes doubled. Graph rejects `#` and `%`
  // unencoded in the path, so the literal is percent-encoded as a whole.
  const literal = encodeURIComponent(`'${query.replace(/'/g, "''")}'`);
  return page(api, token, `/drives/${driveId}/root/search(q=${literal})`, { $select: ITEM_SELECT, $top: top }, parseDriveItem, "search result");
}

/**
 * An agent's search words as KQL: each word, and each phrase it quoted, as a quoted term. Quoting is
 * what keeps the words words: bare, an operator or a property restriction (`path:`, `author:`)
 * among them would re-associate a filter appended after them or add one of the agent's own.
 */
function searchWords(query: string): string {
  const terms: string[] = [];
  for (const [, phrase, word] of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (phrase ?? word ?? "").replace(/"/g, "").trim();
    if (term !== "") terms.push(`"${term}"`);
  }
  return terms.join(" ");
}

/** A hit from Microsoft Search: just where the item lives. */
export type SearchHit = ItemRef;

/** The resources a Microsoft Search response's one request hit, and whether a later page exists. */
function searchHits(body: unknown): { resources: unknown[]; more: boolean } {
  const value = record(body, "search response").value;
  const containers = optRecord(Array.isArray(value) ? value[0] : undefined)?.hitsContainers;
  const resources: unknown[] = [];
  let more = false;
  for (const container of Array.isArray(containers) ? containers.map(optRecord) : []) {
    if (container?.moreResultsAvailable === true) more = true;
    for (const hit of Array.isArray(container?.hits) ? container.hits : []) resources.push(optRecord(hit)?.resource);
  }
  return { resources, more };
}

/**
 * One page of Microsoft Search across every site the user can open, optionally narrowed by a KQL
 * `path:` filter. The hits are only hints: the caller re-reads each and re-checks its scope.
 * @returns The hits, and the offset of the next page, if any.
 */
export async function searchAll(api: GraphApi, query: string, pathFilter: string | undefined, from: number, size: number):
    Promise<{ hits: SearchHit[]; nextFrom?: number }> {
  const words = searchWords(query);
  return await searchDriveItems(api, pathFilter ? `(${words}) path:"${pathFilter.replace(/"/g, "")}"` : words, from, size);
}

/**
 * One page of what other people's OneDrives hold that the user can open: what they have shared
 * with the user, as OneDrive's "Shared with you" lists it, newest first, or matching `query`. Graph's
 * own `sharedWithMe` is deprecated, so this is Microsoft Search, which lags a new share by minutes.
 * Files shared from a site rather than a OneDrive aren't included.
 * @param oneDrives Where the tenant's OneDrives live, e.g. `https://contoso-my.sharepoint.com/personal/`.
 * @param mine The user's own OneDrive under it, if they have one.
 */
export async function searchSharedWithMe(api: GraphApi, oneDrives: string, mine: string | undefined, query: string | undefined,
                                         from: number, size: number): Promise<{ hits: SearchHit[]; nextFrom?: number }> {
  const places = `path:"${oneDrives.replace(/"/g, "")}"${mine ? ` -path:"${mine.replace(/"/g, "")}"` : ""}`;
  const words = query === undefined ? "" : searchWords(query);
  return await searchDriveItems(api, words ? `(${words}) ${places}` : places, from, size,
    words ? undefined : [{ name: "LastModifiedTime", isDescending: true }]);
}

async function searchDriveItems(api: GraphApi, queryString: string, from: number, size: number,
                                sortProperties?: { name: string; isDescending: boolean }[]): Promise<{ hits: SearchHit[]; nextFrom?: number }> {
  const body = await api.request<unknown>("POST", "/search/query", {
    body: { requests: [{ entityTypes: ["driveItem"], query: { queryString }, from, size, fields: ["id", "parentReference"],
      ...(sortProperties ? { sortProperties } : {}) }] },
  });
  const { resources, more } = searchHits(body);
  const hits: SearchHit[] = [];
  for (const resource of resources.map(optRecord)) {
    const itemId = optStr(resource, "id");
    const driveId = optStr(optRecord(resource?.parentReference), "driveId");
    if (itemId !== undefined && driveId !== undefined) hits.push({ driveId, itemId });
  }
  return { hits, ...(more ? { nextFrom: from + size } : {}) };
}

/** A file's saved versions, newest first. */
export async function listVersions(api: GraphApi, ref: ItemRef): Promise<GraphVersion[]> {
  const body = await api.get<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}/versions`, { query: { $top: 50 } });
  return parsePage(body, parseVersion, "version").items;
}

// -- drives and sites ---------------------------------------------------------------------------

/** A drive by ID, or null. */
export async function getDrive(api: GraphApi, driveId: string): Promise<GraphDrive | null> {
  const body = await api.find<unknown>(`/drives/${driveId}`, { query: { $select: DRIVE_SELECT } });
  return body === null ? null : parseDrive(body);
}

/** A site by its composite ID, or null. */
export async function getSite(api: GraphApi, siteId: string): Promise<GraphSite | null> {
  const body = await api.find<unknown>(`/sites/${siteId}`, { query: { $select: SITE_SELECT } });
  return body === null ? null : parseSite(body);
}

/**
 * The user's own OneDrive, as the personal site it lives in, or null without one: no OneDrive, or
 * a grant without `Files.*`. Graph's site search and followed sites leave personal sites out, so a
 * listing that should offer the OneDrive adds it. Nothing it needs is worth failing a listing for.
 */
export async function myOneDriveSite(api: GraphApi): Promise<GraphSite | null> {
  const drive = await api.find<unknown>("/me/drive", { query: { $select: DRIVE_SELECT } })
    .then(body => body === null ? null : parseDrive(body), () => null);
  if (drive === null) return null;
  const url = new URL(drive.webUrl);
  // The library sits in the personal site: `/personal/<user>/Documents`.
  const path = /^\/personal\/[^/]+/.exec(url.pathname)?.[0];
  if (path === undefined) return null;
  return await api.find<unknown>(`/sites/${url.hostname}:${path}`, { query: { $select: SITE_SELECT } })
    .then(body => body === null ? null : parseSite(body), () => null);
}

/** A site's document libraries. */
export function listDrives(api: GraphApi, siteId: string): Promise<GraphDrive[]> {
  return all(api, `/sites/${siteId}/drives`, { $select: DRIVE_SELECT }, parseDrive, "library");
}

/** List templates that are libraries or system lists rather than lists an agent works with. */
const NON_LIST_TEMPLATES = new Set(["documentLibrary", "webPageLibrary", "pictureLibrary", "mySiteDocumentLibrary"]);

/** A site's lists, leaving out libraries (read as drives), page libraries, and hidden system lists. */
export async function listLists(api: GraphApi, siteId: string): Promise<{ lists: GraphList[]; hasPages: boolean }> {
  const [lists, pages] = await Promise.all([
    all(api, `/sites/${siteId}/lists`, { $select: LIST_SELECT, $top: 200 }, parseList, "list"),
    // Graph leaves the Site Pages library out of `/lists`, so whether a site has pages is asked of
    // the pages endpoint itself.
    api.find<{ value?: unknown[] }>(`/sites/${siteId}/pages/microsoft.graph.sitePage`, { query: { $select: "id", $top: 1 } }),
  ]);
  return {
    lists: lists.filter(list => !list.hidden && !NON_LIST_TEMPLATES.has(list.template ?? "") && !/\/_catalogs\//.test(list.webUrl)),
    hasPages: Array.isArray(pages?.value) && pages.value.length > 0,
  };
}

/** A site's subsites. */
export function listSubsites(api: GraphApi, siteId: string): Promise<GraphSite[]> {
  return all(api, `/sites/${siteId}/sites`, { $select: SITE_SELECT }, parseSite, "site");
}

/** One page of the sites the user follows. */
function listFollowedSites(api: GraphApi, token: string | undefined): Promise<Page<GraphSite>> {
  return page(api, token, "/me/followedSites", { $select: SITE_SELECT }, parseSite, "site");
}

/**
 * One page of Microsoft Search's sites matching `query`, or every site. `/sites?search=` reads an
 * older index that a new tenant leaves empty for days; Microsoft Search answers from the start.
 */
async function searchSites(api: GraphApi, query: string | undefined, from: number, size: number):
    Promise<{ sites: GraphSite[]; nextFrom?: number }> {
  const queryString = (query === undefined ? "" : searchWords(query)) || "*";
  const body = await api.request<unknown>("POST", "/search/query", {
    body: { requests: [{ entityTypes: ["site"], query: { queryString }, from, size }] },
  });
  const { resources, more } = searchHits(body);
  const sites: GraphSite[] = [];
  for (const resource of resources) {
    try {
      sites.push(parseSite(resource));
    } catch {
      // A hit that isn't a readable site is skipped; the rest of the page stands.
    }
  }
  return { sites, ...(more ? { nextFrom: from + size } : {}) };
}

/**
 * The tenant's admin, search and app catalog sites, which nobody means to bind, and SharePoint
 * Embedded containers (`/contentstorage/`, e.g. Microsoft Designer's), which search lists as sites
 * but the sites API refuses (verified live).
 */
function isSystemSite(site: GraphSite): boolean {
  return /\/sites\/(appcatalog|search|contentTypeHub)\/?$/i.test(site.webUrl) || /-admin\.sharepoint\.com/i.test(site.webUrl)
    || /^https:\/\/[^/]+\/contentstorage\//i.test(site.webUrl);
}

/**
 * One page of the sites a user can open, for browsing: on the first page, the home site and the
 * sites they follow (what they most likely mean), then everything Microsoft Search finds; OneDrives
 * and system sites left out, each site once. With a query, every source is narrowed to it.
 * @param selected Whether the grant reaches only the sites granted to the app (`Sites.Selected`).
 * Search names every site the user can open, so only those whose library opens are kept.
 * @returns The sites, the next page's offset, and the search failure when only the first two
 * sources answered.
 */
export async function browseSites(api: GraphApi, query: string | undefined, from: number, size: number, selected = false):
    Promise<{ sites: GraphSite[]; nextFrom?: number; searchError?: unknown }> {
  const needle = query?.toLowerCase();
  const matches = (site: GraphSite) => needle === undefined || site.name.toLowerCase().includes(needle)
    || (site.description ?? "").toLowerCase().includes(needle);
  const [pinned, search] = await Promise.all([
    from > 0 ? Promise.resolve([]) : Promise.all([
      getSite(api, "root").catch(() => null),
      listFollowedSites(api, undefined).then(followed => followed.items.toSorted((a, b) => a.name.localeCompare(b.name))).catch(() => []),
    ]).then(([root, followed]) => [root, ...followed]),
    searchSites(api, query, from, size).then(result => ({ result }), (searchError: unknown) => ({ searchError })),
  ]);
  const seen = new Set<string>();
  const keep = (site: GraphSite | null): site is GraphSite => {
    if (site === null || site.personal || isSystemSite(site) || seen.has(site.id)) return false;
    seen.add(site.id);
    return true;
  };
  const first = pinned.filter((site): site is GraphSite => site !== null && matches(site)).filter(keep);
  const open = (sites: GraphSite[]) => selected ? reachableSites(api, sites) : Promise.resolve(sites);
  if ("searchError" in search) return { sites: await open(first), searchError: search.searchError };
  return {
    sites: await open([...first, ...search.result.sites.filter(keep)]),
    ...(search.result.nextFrom !== undefined ? { nextFrom: search.result.nextFrom } : {}),
  };
}

/**
 * The sites among `sites` this connection can open, asked together. Under `Sites.Selected`, Graph
 * answers any site's own metadata but refuses its library unless the site was granted to the app,
 * so the library is what's asked for. A site without one isn't offered.
 */
export async function reachableSites(api: GraphApi, sites: readonly GraphSite[]): Promise<GraphSite[]> {
  const open = new Set<string>();
  for (let start = 0; start < sites.length; start += MAX_BATCH_REQUESTS) {
    const answers = await api.batch(sites.slice(start, start + MAX_BATCH_REQUESTS)
      .map((site, index) => ({ id: String(start + index), method: "GET" as const, url: `sites/${site.id}/drive?$select=id` })));
    for (const [id, answer] of answers) if (answer.status === 200) open.add(id);
  }
  return sites.filter((_, index) => open.has(String(index)));
}

// -- lists --------------------------------------------------------------------------------------

/** A list by ID, or null. */
export async function getList(api: GraphApi, ref: ListRef): Promise<GraphList | null> {
  const body = await api.find<unknown>(`/sites/${ref.siteId}/lists/${ref.listId}`, { query: { $select: LIST_SELECT } });
  return body === null ? null : parseList(body);
}

/** A list's columns. */
export async function listColumns(api: GraphApi, ref: ListRef): Promise<GraphColumn[]> {
  const body = await api.get<unknown>(`/sites/${ref.siteId}/lists/${ref.listId}/columns`);
  return parsePage(body, parseColumn, "column").items;
}

/**
 * The header that lets Graph filter or sort on a column SharePoint has not indexed. It works on any
 * list under the 5,000-item view threshold; above it SharePoint refuses, and the caller explains.
 */
const UNINDEXED_QUERIES = "HonorNonIndexedQueriesWarningMayFailRandomly";

/** One page of list items for a compiled query. */
export function listItems(api: GraphApi, ref: ListRef, query: Record<string, string>, token: string | undefined, top: number,
                          unindexed: boolean): Promise<Page<GraphListItem>> {
  return page(api, token, `/sites/${ref.siteId}/lists/${ref.listId}/items`, { ...query, $top: top }, parseListItem, "list item",
    unindexed ? [UNINDEXED_QUERIES] : undefined);
}

/** A list item, or null. */
export async function getListItem(api: GraphApi, ref: ListRef, itemId: string): Promise<GraphListItem | null> {
  if (!/^[0-9]{1,10}$/.test(itemId)) return null;
  const body = await api.find<unknown>(`/sites/${ref.siteId}/lists/${ref.listId}/items/${itemId}`, { query: { $expand: "fields" } });
  return body === null ? null : parseListItem(body);
}

// -- pages --------------------------------------------------------------------------------------

/** One page of a site's modern pages. */
export function listPages(api: GraphApi, siteId: string, token: string | undefined, top: number): Promise<Page<GraphSitePage>> {
  return page(api, token, `/sites/${siteId}/pages/microsoft.graph.sitePage`, { $select: PAGE_SELECT, $top: top }, parseSitePage, "page");
}

/** A page with its canvas, or null. */
export async function getPage(api: GraphApi, ref: PageRef): Promise<{ page: GraphSitePage; body: unknown } | null> {
  const body = await api.find<unknown>(`/sites/${ref.siteId}/pages/${ref.pageId}/microsoft.graph.sitePage`, {
    query: { $select: PAGE_SELECT, $expand: "canvasLayout" },
  });
  return body === null ? null : { page: parseSitePage(body), body };
}

// -- workbooks ----------------------------------------------------------------------------------

/** A workbook's worksheets. Reads need no workbook session (verified against SharePoint Online). */
export async function listWorksheets(api: GraphApi, ref: ItemRef): Promise<GraphWorksheet[]> {
  const body = await api.get<unknown>(`/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets`, {
    query: { $select: "id,name,visibility" },
  });
  return parsePage(body, parseWorksheet, "worksheet").items;
}

/** A worksheet's used range's address and size, without its cells. */
export async function usedRangeShape(api: GraphApi, ref: ItemRef, sheetId: string):
    Promise<{ address: string; rowCount: number; columnCount: number }> {
  const body = await api.get<Record<string, unknown>>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(sheetId)}/usedRange(valuesOnly=true)`,
    { query: { $select: "address,rowCount,columnCount" } });
  return {
    address: typeof body.address === "string" ? body.address : "",
    rowCount: typeof body.rowCount === "number" ? body.rowCount : 0,
    columnCount: typeof body.columnCount === "number" ? body.columnCount : 0,
  };
}

/** A worksheet range's values and formulas. */
export async function readRange(api: GraphApi, ref: ItemRef, sheetId: string, address: string): Promise<GraphRange> {
  const body = await api.get<unknown>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(sheetId)}/range(address='${encodeURIComponent(address.replace(/'/g, "''"))}')`,
    { query: { $select: "address,values,formulas" } });
  return parseRange(body);
}
