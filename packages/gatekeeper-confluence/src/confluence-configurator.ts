// The Confluence resource configurator's capability: what the browser frame lists, finds and binds.
//
// One frame chooses among all three resource types (site, space, page or blog post), so it trades
// refs and `resourceUrlFor` writes the URL a ref binds. Every ref is checked against the connection's
// own sites before any request, and a URL is written only for content that is still there and
// current. Nothing here is an agent observation: these reads serve the owner's own picker.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  ConfluenceApi,
  ConfluenceApiError,
  HIERARCHY_SCOPE,
  contentIdFromShortLink,
  escapeCqlString,
  spaceKeyFromWebui,
  type AccessibleResource,
  type ContentResponse,
  type Paged,
  type SearchHit,
  type SpaceResponse,
  type TreeNodeResponse,
  type TreeParent,
} from "./confluence-api";
import type {
  ConfluenceBrowsePage,
  ConfluenceBrowseRequest,
  ConfluenceConfiguratorRpc,
  ConfluenceConfiguratorStatus,
  ConfluenceCrumb,
  ConfluenceNode,
  ConfluenceNodeKind,
} from "./configurator/confluence-configurator-types";

const PAGE_SIZE = 25;
const SEARCH_PAGE_SIZE = 20;
const RECENT_COUNT = 6;
/** How deep `descendants` looks to tell which children have children of their own. */
const DESCENDANTS_LIMIT = 250;
const MAX_QUERY_LENGTH = 200;
const MAX_TEXT_LENGTH = 240;
const ICON_MAX_BYTES = 48 * 1024;
const ICON_CONCURRENCY = 6;
/** The most space avatars one `spaceAvatars` call fetches. */
const AVATAR_BATCH = 100;
const ICON_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** What the configurator needs from the connected account. */
export type ConfiguratorAccount = {
  getSites(): Promise<AccessibleResource[]>;
  /** The scopes the grant holds, or null when the grant predates recording them. */
  getGrantedScopes(): Promise<string[] | null>;
  getToken(): Promise<string>;
  refresh(): Promise<string>;
};

type Ref =
  | { kind: "site"; cloudId: string }
  | { kind: "space" | "blogs"; cloudId: string; key: string }
  | { kind: "page" | "blogpost" | "folder" | "whiteboard" | "database" | "embed"; cloudId: string; id: string };

const TREE_PARENT: Record<string, TreeParent | undefined> = {
  page: "pages", folder: "folders", whiteboard: "whiteboards", database: "databases", embed: "embeds",
};
/** Whether `type` names a kind of tree node, by its own keys only: `constructor` is not one. */
const isTreeKind = (type: string | undefined): type is keyof typeof TREE_PARENT & ConfluenceNodeKind =>
  type !== undefined && Object.hasOwn(TREE_PARENT, type);

const GONE = "What you chose no longer exists, or you can no longer open it. Choose again.";
const UNSELECTABLE: Partial<Record<ConfluenceNodeKind, string>> = {
  blogs: "Choose one post, or the whole space.",
  folder: "A folder can't be connected on its own. Choose a page in it, or the whole space.",
  whiteboard: "Can't be connected yet.",
  database: "Can't be connected yet.",
  embed: "Can't be connected yet.",
};
const PARTIAL_TREE =
  "Folders, whiteboards and databases aren't shown, because this connection can't read Confluence's " +
  "content tree. Reconnect Confluence to see them, or search for a page inside a folder.";

// Control characters and bidirectional formatting, which let a third-party title visually reorder
// or hide the text around it.
const INVISIBLE_CONTROLS = /[\p{Cc}\p{Bidi_Control}]/gu;

/** Third-party text made safe and short enough to display. */
export function displayText(value: string | undefined, max = MAX_TEXT_LENGTH): string {
  return (value ?? "").replace(INVISIBLE_CONTROLS, "").trim().slice(0, max);
}

/** A v1 search title without the highlight markers Confluence wraps matched words in. */
export function searchTitle(raw: string): string {
  return displayText(raw.replaceAll(/@@@(?:end)?hl@@@/g, ""));
}

/** "Oct 12" this year, "Oct 12, 2024" otherwise. */
function shortDate(iso: string | undefined, now = new Date()): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(date.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

const invalid = () => new Error("That can't be opened.");

type LinkTarget = { kind: "site" } | { kind: "space"; key: string } | { kind: "content"; id: string };

/**
 * What a Confluence link names, by the shapes Confluence writes: the site (`/wiki`, `/wiki/home`),
 * a space (`/wiki/spaces/KEY`, its overview, pages or blog list), a page (`/pages/<id>/…`, a short
 * link, `viewpage.action?pageId=`) or a blog post (`/blog/<y>/<m>/<d>/<id>/…`). Any other link is
 * null: one to a folder, a whiteboard or an unknown path must not fall back to its space or site,
 * which would offer far more than the link names.
 */
function linkTarget(url: URL): LinkTarget | null {
  const shortLinkId = contentIdFromShortLink(url.href);
  if (shortLinkId) return { kind: "content", id: shortLinkId };
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.shift() !== "wiki") return null;
  const numeric = (value: string | undefined): value is string => value !== undefined && /^\d{1,20}$/.test(value);
  if (segments.length === 0 || (segments.length === 1 && segments[0] === "home")) return { kind: "site" };
  if (segments.length === 2 && segments[0] === "pages" && segments[1] === "viewpage.action") {
    const id = url.searchParams.get("pageId") ?? undefined;
    return numeric(id) ? { kind: "content", id } : null;
  }
  const [spaces, key, ...rest] = segments;
  if (spaces !== "spaces" || !key) return null;
  if (rest.length === 0 || (rest.length === 1 && ["overview", "pages", "blog"].includes(rest[0]!))) return { kind: "space", key };
  if (rest[0] === "pages" && numeric(rest[1])) return { kind: "content", id: rest[1] };
  if (rest[0] === "blog" && numeric(rest[4])) return { kind: "content", id: rest[4] };
  return null;
}
const expired = () => new Error("That page has expired. Try again.");

/**
 * Where a space's root listing continues: further children of the home page (and whether pages
 * without a parent follow them), or further pages without a parent.
 */
type RootCursor = { home: string; orphans: boolean } | { roots: string | null };

function parseRootCursor(cursor: string): RootCursor | undefined {
  try {
    const parsed = JSON.parse(cursor) as { home?: unknown; orphans?: unknown; roots?: unknown } | null;
    if (typeof parsed?.home === "string") return { home: parsed.home, orphans: parsed.orphans === true };
    if (parsed && (parsed.roots === null || typeof parsed.roots === "string")) return { roots: parsed.roots };
  } catch { /* not a cursor of ours */ }
  return undefined;
}

function parseRef(ref: string): Ref {
  const colon = ref.indexOf(":");
  const kind = colon < 0 ? "" : ref.slice(0, colon);
  const [cloudId, rest, extra] = ref.slice(colon + 1).split("/");
  if (!cloudId || extra !== undefined || !/^[0-9a-f-]{1,64}$/i.test(cloudId)) throw invalid();
  if (kind === "site") {
    if (rest !== undefined) throw invalid();
    return { kind, cloudId };
  }
  if (rest === undefined || rest === "") throw invalid();
  if (kind === "space" || kind === "blogs") {
    if (!/^[^/\s\p{Cc}]{1,255}$/u.test(rest)) throw invalid();
    return { kind, cloudId, key: rest };
  }
  if (kind === "page" || kind === "blogpost" || isTreeKind(kind)) {
    if (!/^\d{1,20}$/.test(rest)) throw invalid();
    return { kind: kind as "page", cloudId, id: rest };
  }
  throw invalid();
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Whether `error` is Confluence answering one of `statuses`. */
const hasStatus = (...statuses: number[]) => (error: unknown) =>
  error instanceof ConfluenceApiError && statuses.includes(error.status);
const isAccessError = hasStatus(400, 401, 403, 404);

/** A catch handler answering `fallback` for an error `expected` names, and rethrowing any other. */
const unless = <T>(expected: (error: unknown) => boolean, fallback: T) => (error: unknown): T => {
  if (expected(error)) return fallback;
  throw error;
};

/** `load`, run once and its answer kept, though a failure is forgotten so the next call asks again. */
const once = <T>(load: () => Promise<T>) => {
  let kept: Promise<T> | undefined;
  return () => kept ??= load().catch(error => {
    kept = undefined;
    throw error;
  });
};

const toBase64 = (data: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** The Confluence configurator frame's capability. */
@validateRpc()
export class ConfluenceConfiguratorUI extends RpcTarget implements ConfluenceConfiguratorRpc {
  readonly #account: ConfiguratorAccount;
  readonly #allSites = once(() => this.#account.getSites());
  readonly #grantedScopes = once(() => this.#account.getGrantedScopes());
  /** Whether Confluence denied the content tree to a grant whose scopes weren't recorded. */
  #treeDenied = false;
  readonly #spaces = new Map<string, Promise<SpaceResponse>>();
  readonly #icons = new Map<string, Promise<string | undefined>>();

  constructor(account: ConfiguratorAccount) {
    super();
    this.#account = account;
  }

  async getStatus(): Promise<ConfluenceConfiguratorStatus> {
    const sites = await this.#allSites();
    if (sites.length === 0) {
      return {
        state: "unavailable",
        message: "This connection can't open any Confluence site. Reconnect Confluence and choose the site to use.",
      };
    }
    return {
      state: "ready",
      sites: sites.map(site => ({ cloudId: site.id, name: displayText(site.name) || hostOf(site), host: hostOf(site), ref: `site:${site.id}` })),
    };
  }

  async loadItems(request: ConfluenceBrowseRequest): Promise<ConfluenceBrowsePage> {
    const { site, parent, query, section, cursor } = request;
    if ([parent, query, section].filter(value => value !== undefined).length !== 1) {
      throw new Error("Ask for one listing at a time.");
    }
    if (cursor !== undefined && cursor.length > 2048) throw new Error("That page has expired. Try again.");
    if (parent !== undefined) return await this.#children(parseRef(parent), cursor);

    const siteRef = site === undefined ? undefined : parseRef(site);
    if (siteRef?.kind !== "site") throw new Error("Choose a site first.");
    const resource = await this.#site(siteRef.cloudId);
    if (query !== undefined) return await this.#search(resource, query, cursor);
    switch (section) {
      case "spaces": return await this.#spacesOf(resource, cursor);
      case "starred": return await this.#starred(resource, cursor);
      case "recent": return await this.#recent(resource);
      default: throw new Error("That can't be opened.");
    }
  }

  async locate(url: string): Promise<ConfluenceNode | null> {
    if (url.length > 2048) return null;
    return await this.#locate(url).catch(unless(isAccessError, null));
  }

  async resourceUrlFor(ref: string): Promise<string> {
    const parsed = parseRef(ref);
    const site = await this.#site(parsed.cloudId);
    const wiki = `${site.url.replace(/\/+$/, "")}/wiki`;
    const api = this.#api(site);
    try {
      switch (parsed.kind) {
        case "site": return wiki;
        case "space": {
          const space = await this.#space(site, parsed.key);
          if (space.status === "archived") throw new Error("That space is archived. Choose another.");
          return `${wiki}/spaces/${encodeURIComponent(space.key)}`;
        }
        case "page":
        case "blogpost": {
          const content = parsed.kind === "page"
            ? await api.getPage(parsed.id, { body: false })
            : await api.getBlogPost(parsed.id, { body: false });
          const key = spaceKeyFromWebui(content._links?.webui);
          if ((content.status ?? "current") !== "current" || !key) throw new Error(GONE);
          // A blog post is bound by the page-shaped URL too: its own `/blog/…` link matches no
          // resource type, and the content gatekeeper reads either kind of ID.
          return `${wiki}/spaces/${encodeURIComponent(key)}/pages/${encodeURIComponent(content.id)}`;
        }
        default: throw new Error(UNSELECTABLE[parsed.kind] ?? "Choose a page, a space, or the whole site.");
      }
    } catch (error) {
      if (isAccessError(error)) throw new Error(GONE, { cause: error });
      throw error;
    }
  }

  async spaceAvatars(refs: string[]): Promise<Record<string, string>> {
    const wanted = [...new Set(refs)].map(ref => {
      const parsed = parseRef(ref);
      if (parsed.kind !== "space") throw invalid();
      return parsed;
    });
    if (wanted.length > AVATAR_BATCH) throw new Error("Ask for fewer avatars at a time.");
    const found = await mapLimit(wanted, ICON_CONCURRENCY, async ref => {
      const site = await this.#site(ref.cloudId);
      const space = await this.#space(site, ref.key).catch(() => undefined);
      return { ref: `space:${ref.cloudId}/${ref.key}`, avatar: space && await this.#avatar(site, space) };
    });
    const avatars: Record<string, string> = {};
    for (const { ref, avatar } of found) if (avatar !== undefined) avatars[ref] = avatar;
    return avatars;
  }

  // -- the connection ---------------------------------------------------------------------------

  async #site(cloudId: string): Promise<AccessibleResource> {
    const site = (await this.#allSites()).find(candidate => candidate.id === cloudId);
    if (!site) throw new Error("That site isn't part of this connection.");
    return site;
  }

  async #hasFullTree(): Promise<boolean> {
    if (this.#treeDenied) return false;
    // A grant from before scopes were recorded is assumed to have it, and found out on first use.
    const scopes = await this.#grantedScopes();
    return scopes === null || scopes.includes(HIERARCHY_SCOPE);
  }

  #api(site: AccessibleResource): ConfluenceApi {
    return new ConfluenceApi({
      cloudId: site.id,
      webBase: `${site.url}/wiki`,
      getToken: () => this.#account.getToken(),
      refresh: () => this.#account.refresh(),
    });
  }

  #space(site: AccessibleResource, key: string): Promise<SpaceResponse> {
    const cacheKey = `${site.id}/${key}`;
    let space = this.#spaces.get(cacheKey);
    if (!space) {
      space = this.#api(site).getSpaceByKey(key);
      this.#spaces.set(cacheKey, space);
      space.catch(() => this.#spaces.delete(cacheKey));
    }
    return space;
  }

  // -- listings ---------------------------------------------------------------------------------

  async #spacesOf(site: AccessibleResource, cursor: string | undefined): Promise<ConfluenceBrowsePage> {
    const page = await this.#api(site).listSpaces({ status: "current", sort: "name", includeIcon: true, cursor, limit: PAGE_SIZE });
    // The spaces are kept so `spaceAvatars` finds their icon links without asking again.
    for (const space of page.results) this.#spaces.set(`${site.id}/${space.key}`, Promise.resolve(space));
    return {
      items: page.results.map(space => spaceNode(site.id, space)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /** A space's icon as a data URL, or undefined (drawn as initials) when it has none or it can't be read. */
  #avatar(site: AccessibleResource, space: SpaceResponse): Promise<string | undefined> {
    const link = space.icon?.apiDownloadLink;
    if (!link) return Promise.resolve(undefined);
    // Keyed by site too: two sites may write the same link for different spaces.
    const cacheKey = `${site.id}${link}`;
    let avatar = this.#icons.get(cacheKey);
    if (!avatar) {
      avatar = this.#api(site).downloadSpaceIcon(link, ICON_MAX_BYTES).then(
        ({ data, mediaType }) => {
          const type = mediaType.split(";")[0].trim().toLowerCase();
          return ICON_TYPES.has(type) && data.length > 0 ? `data:${type};base64,${toBase64(data)}` : undefined;
        },
        () => undefined);
      this.#icons.set(cacheKey, avatar);
    }
    return avatar;
  }

  async #recent(site: AccessibleResource): Promise<ConfluenceBrowsePage> {
    const cql = `id in recentlyViewedContent(${RECENT_COUNT}) AND type in (page, blogpost)`;
    // A site that can't run this search shows the tab empty; any other failure is the picker's to
    // show, with its Try again. Only the most recent are shown, so there is no next page.
    const { items } = await this.#hits(site, cql, { limit: RECENT_COUNT }).catch(unless(hasStatus(400), { items: [] }));
    return { items };
  }

  /** What the user starred in Confluence: spaces, pages and blog posts, as its own Starred page lists them. */
  #starred(site: AccessibleResource, cursor: string | undefined): Promise<ConfluenceBrowsePage> {
    return this.#hits(site, "type in (space, page, blogpost) AND favourite = currentUser()", { cursor, limit: PAGE_SIZE });
  }

  async #children(ref: Ref, cursor: string | undefined): Promise<ConfluenceBrowsePage> {
    const site = await this.#site(ref.cloudId);
    const api = this.#api(site);
    switch (ref.kind) {
      case "site": return await this.#spacesOf(site, cursor);
      case "space": return await this.#spaceRoot(site, ref.key, cursor);
      case "blogs": {
        const space = await this.#space(site, ref.key);
        const page = await api.listBlogPostsInSpace({ spaceId: space.id, sort: "-created-date", cursor, limit: PAGE_SIZE });
        return {
          items: page.results.map(post => contentNode(site.id, post, { subtitle: shortDate(post.createdAt) })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      }
      case "blogpost": return { items: [] };
      default: return await this.#treeChildren(site, TREE_PARENT[ref.kind]!, ref.id, cursor);
    }
  }

  /**
   * A space's top level as Confluence's sidebar shows it: the home page, the blog when the space has
   * posts, then the home page's children (Confluence puts top-level pages under the home page) and,
   * once those are all shown, any page without a parent.
   */
  async #spaceRoot(site: AccessibleResource, key: string, cursor: string | undefined): Promise<ConfluenceBrowsePage> {
    const space = await this.#space(site, key);
    const api = this.#api(site);
    const continueAt = (next: RootCursor) => JSON.stringify(next);
    const orphanRows = (roots: Paged<ContentResponse>) => roots.results
      .filter(page => page.id !== space.homepageId && (page.status ?? "current") === "current")
      .map(page => contentNode(site.id, page, { meta: updated(page), expandable: true }));
    const moreOrphans = async (rootsCursor: string | undefined): Promise<ConfluenceBrowsePage> => {
      const roots = await api.listPagesInSpace({ spaceId: space.id, depth: "root", cursor: rootsCursor, limit: PAGE_SIZE });
      return { items: orphanRows(roots), ...(roots.nextCursor ? { nextCursor: continueAt({ roots: roots.nextCursor }) } : {}) };
    };

    if (cursor !== undefined) {
      const at = parseRootCursor(cursor);
      if (!at) throw expired();
      if ("roots" in at) return await moreOrphans(at.roots ?? undefined);
      if (!space.homepageId) throw expired();
      const home = await this.#treeChildren(site, "pages", space.homepageId, at.home);
      return {
        items: home.items,
        ...(home.nextCursor ? { nextCursor: continueAt({ home: home.nextCursor, orphans: at.orphans }) }
          : at.orphans ? { nextCursor: continueAt({ roots: null }) } : {}),
      };
    }

    const [roots, posts, home] = await Promise.all([
      api.listPagesInSpace({ spaceId: space.id, depth: "root", limit: PAGE_SIZE }),
      api.listBlogPostsInSpace({ spaceId: space.id, limit: 1 }).catch(() => ({ results: [] })),
      // A home page the user can't read hides only its own pages, which are restricted with it.
      space.homepageId
        ? this.#treeChildren(site, "pages", space.homepageId, undefined).catch(unless(isAccessError, undefined))
        : undefined,
    ]);
    // The home page is usually the space's first page, so in the first batch; read it alone if not.
    const homePage = roots.results.find(page => page.id === space.homepageId)
      ?? (space.homepageId ? await api.getPage(space.homepageId, { body: false }).catch(() => undefined) : undefined);
    const orphans = orphanRows(roots);
    const items: ConfluenceNode[] = [];
    if (homePage) {
      items.push({
        ...contentNode(site.id, homePage, { meta: updated(homePage) }),
        kind: "overview",
        subtitle: "Space home",
        // Its children are the rest of this listing.
        expandable: false,
      });
    }
    if (posts.results.length > 0) {
      items.push({
        ref: `blogs:${site.id}/${space.key}`, kind: "blogs", title: "Blog", expandable: true,
        selectable: false, unselectableReason: UNSELECTABLE.blogs,
      });
    }
    items.push(...home?.items ?? []);
    let nextCursor: string | undefined;
    if (home?.nextCursor) {
      // The parentless pages follow the last of the home page's children, so they are read again then.
      nextCursor = continueAt({ home: home.nextCursor, orphans: orphans.length > 0 || roots.nextCursor !== undefined });
    } else {
      items.push(...orphans);
      if (roots.nextCursor) nextCursor = continueAt({ roots: roots.nextCursor });
    }
    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
      ...(home?.notice ? { notice: home.notice } : {}),
    };
  }

  /**
   * A page's or folder's children in sidebar order. With the content-tree scope, every kind of child
   * is listed and one `descendants` read tells which children have children; without it, only pages
   * are, and every page offers to open.
   */
  async #treeChildren(site: AccessibleResource, parent: TreeParent, id: string, cursor: string | undefined): Promise<ConfluenceBrowsePage> {
    const api = this.#api(site);
    if (await this.#hasFullTree()) {
      try {
        const [children, grandchildren] = await Promise.all([
          api.listDirectChildren(parent, id, { cursor, limit: PAGE_SIZE }),
          cursor === undefined
            ? api.listDescendants(parent, id, { depth: 2, limit: DESCENDANTS_LIMIT }).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        // Only a complete answer can say that a child has no children.
        const known = grandchildren && !grandchildren.nextCursor
          ? new Set(grandchildren.results.filter(node => (node.depth ?? 1) > 1).map(node => node.parentId))
          : undefined;
        const current = children.results.filter(node => (node.status ?? "current") === "current");
        const pages = await pageDetails(api, current.filter(node => (node.type ?? "page") === "page").map(node => node.id));
        return {
          items: current.map(node => treeNode(site.id, node, known ? known.has(node.id) : true, pages.get(node.id))),
          ...(children.nextCursor ? { nextCursor: children.nextCursor } : {}),
        };
      } catch (error) {
        // A denial means a missing scope only for a grant whose scopes weren't recorded; with them
        // recorded, it is Confluence's answer.
        if (!hasStatus(401, 403)(error) || await this.#grantedScopes() !== null) throw error;
        this.#treeDenied = true;
      }
    }
    if (parent !== "pages") return { items: [], notice: PARTIAL_TREE };
    const page = await api.listChildPages(id, { cursor, limit: PAGE_SIZE });
    const current = page.results.filter(child => (child.status ?? "current") === "current");
    const pages = await pageDetails(api, current.map(child => child.id));
    return {
      items: current.map(child => treeNode(site.id, { ...child, type: "page" }, true, pages.get(child.id))),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(cursor === undefined ? { notice: PARTIAL_TREE } : {}),
    };
  }

  // -- search and links -------------------------------------------------------------------------

  async #search(site: AccessibleResource, raw: string, cursor: string | undefined): Promise<ConfluenceBrowsePage> {
    const query = raw.trim();
    if (!query) return { items: [] };
    // The frame reads `www.` as a link too, so it is looked up as one. A link has `locate`'s own
    // length limit, since a page URL with a long title and a share origin outgrows a search's.
    const link = /^www\./i.test(query) ? `https://${query}` : query;
    if (/^https?:\/\//i.test(link)) {
      const node = await this.locate(link);
      return node
        ? { items: [node] }
        : { items: [], notice: "This link isn't to a Confluence page, blog post or space this connection can open." };
    }
    if (query.length > MAX_QUERY_LENGTH) throw new Error("That search is too long.");
    if (/[\p{Cc}]/u.test(query)) throw new Error("A search can't contain line breaks or control characters.");
    const cql = `type in (space, page, blogpost) AND siteSearch ~ ${escapeCqlString(query)}`;
    return await this.#hits(site, cql, { cursor, limit: SEARCH_PAGE_SIZE });
  }

  /** One page of a CQL search's results as rows. */
  async #hits(site: AccessibleResource, cql: string, page: { cursor?: string; limit: number }): Promise<ConfluenceBrowsePage> {
    const hits = await this.#api(site).searchWithContext(cql, page);
    return {
      items: hits.results.flatMap(hit => this.#hitNode(site, hit) ?? []),
      ...(hits.nextCursor ? { nextCursor: hits.nextCursor } : {}),
    };
  }

  /** A search result as a row: a space, or a page or blog post with the path to it. */
  #hitNode(site: AccessibleResource, hit: SearchHit): ConfluenceNode | undefined {
    const title = searchTitle(hit.title ?? hit.content?.title ?? "");
    if (hit.entityType === "space") {
      const key = hit.space?.key;
      if (!key) return undefined;
      return {
        ...spaceNode(site.id, { key, name: title, type: hit.space?.type }),
        path: [],
      };
    }
    const content = hit.content;
    if (!content || (content.type !== "page" && content.type !== "blogpost") || (content.status ?? "current") !== "current") {
      return undefined;
    }
    const spaceKey = content.space?.key ?? spaceKeyFromWebui(content._links?.webui);
    if (!spaceKey) return undefined;
    const spaceCrumb: ConfluenceCrumb = {
      ref: `space:${site.id}/${spaceKey}`, kind: spaceKey.startsWith("~") ? "personalSpace" : "space",
      title: displayText(content.space?.name ?? hit.resultGlobalContainer?.title) || spaceKey,
    };
    const homepageId = content.space?._expandable?.homepage?.match(/\/(\d+)$/)?.[1];
    const isHome = content.id === homepageId;
    const path: ConfluenceCrumb[] = content.type === "blogpost"
      ? [spaceCrumb, { ref: `blogs:${site.id}/${spaceKey}`, kind: "blogs", title: "Blog" }]
      : [spaceCrumb, ...(content.ancestors ?? []).filter(ancestor => ancestor.id !== homepageId).map(ancestor => ({
        ref: `${isTreeKind(ancestor.type) ? ancestor.type : "page"}:${site.id}/${ancestor.id}`,
        kind: isTreeKind(ancestor.type) ? ancestor.type : "page",
        title: displayText(ancestor.title) || "Untitled",
      }))];
    return {
      ref: `${content.type}:${site.id}/${content.id}`,
      kind: isHome ? "overview" : content.type,
      title: title || "Untitled",
      ...(shortDate(hit.lastModified) ? { meta: shortDate(hit.lastModified) } : {}),
      // Only child pages are counted, so a page whose only children are folders or whiteboards
      // reads as a leaf here, as Confluence's own search shows it; one with no count may open.
      expandable: content.type === "page" && !isHome && (content.children?.page?.size ?? 1) > 0,
      selectable: true,
      path,
    };
  }

  async #locate(raw: string): Promise<ConfluenceNode | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const site = (await this.#allSites()).find(candidate => hostOf(candidate) === url.hostname);
    if (!site) return null;
    const target = linkTarget(url);
    if (!target) return null;
    if (target.kind === "site") return siteNode(site);
    if (target.kind === "space") {
      const space = await this.#space(site, target.key);
      return space.status === "archived" ? null : { ...spaceNode(site.id, space), path: [] };
    }
    const api = this.#api(site);
    const [content, hit] = await Promise.all([
      api.getContentById(target.id, { body: false }),
      // Search knows the ancestors (folders included) and the space's home page in one read.
      api.searchWithContext(`id = ${target.id}`, { limit: 1 }).then(page => page.results[0], () => undefined),
    ]);
    if ((content.status ?? "current") !== "current") return null;
    const fromSearch = hit ? this.#hitNode(site, hit) : undefined;
    if (fromSearch) return { ...fromSearch, title: displayText(content.title) || "Untitled" };
    const key = spaceKeyFromWebui(content._links?.webui);
    if (!key) return null;
    const space = await this.#space(site, key);
    const isHome = content.id === space.homepageId;
    return {
      ...contentNode(site.id, content, { meta: updated(content), expandable: content.type === "page" && !isHome }),
      ...(isHome ? { kind: "overview" as const } : {}),
      path: [
        { ref: `space:${site.id}/${space.key}`, kind: space.type === "personal" ? "personalSpace" : "space", title: displayText(space.name) || space.key },
        ...(content.type === "blogpost" ? [{ ref: `blogs:${site.id}/${space.key}`, kind: "blogs" as const, title: "Blog" }] : []),
      ],
    };
  }
}

// -- rows ---------------------------------------------------------------------------------------

const hostOf = (site: AccessibleResource) => {
  try {
    return new URL(site.url).hostname;
  } catch {
    return site.url;
  }
};

/** When a page last changed, as its row's meta. */
const updated = (content: ContentResponse) => shortDate(content.version?.createdAt);

function siteNode(site: AccessibleResource): ConfluenceNode {
  return {
    ref: `site:${site.id}`, kind: "site", title: displayText(site.name) || hostOf(site), subtitle: hostOf(site),
    expandable: true, selectable: true, path: [],
  };
}

/** A space's row. Its avatar is not here: the frame asks `spaceAvatars` for those once the rows show. */
function spaceNode(cloudId: string, space: Pick<SpaceResponse, "key" | "name" | "type">): ConfluenceNode {
  const personal = space.type === "personal" || space.key.startsWith("~");
  return {
    ref: `space:${cloudId}/${space.key}`,
    kind: personal ? "personalSpace" : "space",
    title: displayText(space.name) || space.key,
    subtitle: personal ? "Personal space" : space.key,
    expandable: true,
    selectable: true,
  };
}

function contentNode(
  cloudId: string, content: ContentResponse,
  extra: { subtitle?: string; meta?: string; expandable?: boolean },
): ConfluenceNode {
  const blog = content.type === "blogpost";
  return {
    ref: `${blog ? "blogpost" : "page"}:${cloudId}/${content.id}`,
    kind: blog ? "blogpost" : content.subtype === "live" ? "liveDoc" : "page",
    title: displayText(content.title) || "Untitled",
    ...(extra.subtitle ? { subtitle: extra.subtitle } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
    expandable: extra.expandable ?? false,
    selectable: true,
  };
}

/**
 * A row of the content tree. A page's `details`, when they could be read, tell a live doc from a
 * page and when it last changed, which the tree endpoints don't say.
 */
function treeNode(cloudId: string, node: TreeNodeResponse, hasChildren: boolean, details?: ContentResponse): ConfluenceNode {
  const kind: ConfluenceNodeKind = isTreeKind(node.type) ? node.type : "page";
  const reason = UNSELECTABLE[kind];
  const meta = details && updated(details);
  return {
    ref: `${kind}:${cloudId}/${node.id}`,
    kind: kind === "page" && details?.subtype === "live" ? "liveDoc" : kind,
    title: displayText(node.title) || "Untitled",
    ...(meta ? { meta } : {}),
    expandable: hasChildren,
    selectable: reason === undefined,
    ...(reason ? { unselectableReason: reason } : {}),
  };
}

/** Pages by ID, read in one request; empty when they can't be, as they only enrich their rows. */
async function pageDetails(api: ConfluenceApi, ids: string[]): Promise<Map<string, ContentResponse>> {
  if (ids.length === 0) return new Map();
  const pages = await api.listPagesById(ids).catch(() => undefined);
  return new Map(pages?.results.map(page => [page.id, page]) ?? []);
}
