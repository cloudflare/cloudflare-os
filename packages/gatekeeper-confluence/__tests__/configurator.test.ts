// The configurator's capability against a fake Confluence: what each listing asks Confluence for
// and makes of its answers, how links and resource URLs are resolved, and what is refused.

import { matchesResourceUrlPattern } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibleResource } from "../src/confluence-api";
import { ConfluenceConfiguratorUI, displayText, searchTitle, type ConfiguratorAccount } from "../src/confluence-configurator";
import { PATTERNS } from "./frame-host";

const CLOUD = "5c121664-a643-497d-99b3-25e02a81f02f";
const OTHER = "0d6e5c1a-0000-4000-8000-000000000000";
const SITE: AccessibleResource = { id: CLOUD, name: "Slew", url: "https://slew.atlassian.net", scopes: [] };

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let routes: [RegExp, Handler][];
let requests: { url: URL; init: RequestInit }[];

/** Answers a request whose path (with query) matches `pattern`. Later routes win. */
const route = (pattern: RegExp, handler: Handler | unknown) =>
  routes.unshift([pattern, typeof handler === "function" ? handler as Handler : () => json(handler)]);

beforeEach(() => {
  routes = [];
  requests = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const path = `${url.origin === "https://api.atlassian.com" ? url.pathname.replace(`/ex/confluence/${CLOUD}`, "") : url.href}${url.origin === "https://api.atlassian.com" ? url.search : ""}`;
    const match = routes.find(([pattern]) => pattern.test(path));
    return match ? match[1](url, init) : json({ message: "Not found" }, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());

function ui(account: Partial<ConfiguratorAccount> = {}) {
  return new ConfluenceConfiguratorUI({
    getSites: async () => [SITE],
    getGrantedScopes: async () => ["read:hierarchical-content:confluence"],
    getToken: async () => "token",
    refresh: async () => "token",
    ...account,
  });
}

/** The pattern the Workshop binds a URL under: the first it matches, most specific first. */
const boundPattern = (url: string) => [PATTERNS.page, PATTERNS.space, PATTERNS.site].find(pattern => matchesResourceUrlPattern(pattern, url));

const space = (key: string, extra: Record<string, unknown> = {}) =>
  ({ id: `${key.length}0${key.charCodeAt(0)}`, key, name: `${key} space`, type: "global", status: "current", homepageId: "100", ...extra });
const MFS = space("MFS");
const pageJson = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, status: "current", spaceId: MFS.id, _links: { webui: `/spaces/MFS/pages/${id}/${title}` }, ...extra });
const hit = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  title: content.title, entityType: "content", lastModified: "2026-10-24T10:00:00.000Z",
  content: { status: "current", space: { key: "MFS", name: "My first space", _expandable: { homepage: "/rest/api/content/100" } }, ...content },
  ...extra,
});

describe("getStatus", () => {
  it("lists the connection's sites", async () => {
    expect(await ui().getStatus()).toEqual({
      state: "ready",
      sites: [{ cloudId: CLOUD, name: "Slew", host: "slew.atlassian.net", ref: `site:${CLOUD}` }],
    });
  });

  it("is unavailable when the connection can open no site", async () => {
    expect(await ui({ getSites: async () => [] }).getStatus()).toMatchObject({ state: "unavailable" });
  });

  it("asks the account again after its sites couldn't be read, so Try again recovers", async () => {
    const getSites = vi.fn().mockRejectedValueOnce(new Error("reset")).mockResolvedValue([SITE]);
    const configurator = ui({ getSites });

    await expect(configurator.getStatus()).rejects.toThrow("reset");
    expect(await configurator.getStatus()).toMatchObject({ state: "ready" });
  });
});

describe("loadItems", () => {
  it("asks for exactly one listing", async () => {
    await expect(ui().loadItems({ site: `site:${CLOUD}`, section: "spaces", query: "x" })).rejects.toThrow("one listing");
    await expect(ui().loadItems({})).rejects.toThrow("one listing");
  });

  it("refuses a site or ref outside the connection before asking Confluence anything", async () => {
    await expect(ui().loadItems({ site: `site:${OTHER}`, section: "spaces" })).rejects.toThrow("isn't part of this connection");
    await expect(ui().loadItems({ parent: `space:${OTHER}/MFS` })).rejects.toThrow("isn't part of this connection");
    await expect(ui().loadItems({ parent: `page:${CLOUD}/../1` })).rejects.toThrow("can't be opened");
    expect(requests).toEqual([]);
  });

  it("lists spaces by name, and fetches their icons afterwards from Atlassian's media host only", async () => {
    route(/^\/wiki\/api\/v2\/spaces\?/, {
      results: [
        space("MFS", { icon: { apiDownloadLink: "/wiki/rest/api/icon/mfs" } }),
        space("TH", { icon: { apiDownloadLink: "/rest/api/icon/th" } }),
        space("~712", { type: "personal", name: "P Jones" }),
      ],
      _links: { next: "/wiki/api/v2/spaces?cursor=abc" },
    });
    route(/^\/wiki\/rest\/api\/icon\/mfs/, () => new Response(null, { status: 302, headers: { Location: "https://api.media.atlassian.com/file/1/image?token=t" } }));
    route(/^\/wiki\/rest\/api\/icon\/th/, () => new Response(null, { status: 302, headers: { Location: "https://evil.example/icon.png" } }));
    route(/^https:\/\/api\.media\.atlassian\.com\//, () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }));

    const configurator = ui();
    const page = await configurator.loadItems({ site: `site:${CLOUD}`, section: "spaces" });

    expect(page.nextCursor).toBe("abc");
    expect(page.items.map(item => [item.kind, item.title, item.subtitle])).toEqual([
      ["space", "MFS space", "MFS"],
      ["space", "TH space", "TH"],
      ["personalSpace", "P Jones", "Personal space"],
    ]);
    // The rows come back before any icon is read.
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({ status: "current", sort: "name", "include-icon": "true" });

    const avatars = await configurator.spaceAvatars(page.items.map(item => item.ref));

    expect(avatars).toEqual({ [`space:${CLOUD}/MFS`]: "data:image/png;base64,iVBORw==" });
    // The spaces were kept from the listing, so no space is asked for again.
    expect(requests.filter(request => request.url.pathname.endsWith("/spaces"))).toHaveLength(1);
    // The token goes to Confluence, never to the media host, and nothing is fetched from elsewhere.
    const media = requests.find(request => request.url.hostname === "api.media.atlassian.com")!;
    expect(new Headers(media.init.headers).has("Authorization")).toBe(false);
    expect(requests.some(request => request.url.hostname === "evil.example")).toBe(false);
    // Only spaces have avatars, and only this connection's.
    await expect(configurator.spaceAvatars([`page:${CLOUD}/1`])).rejects.toThrow("can't be opened");
    await expect(configurator.spaceAvatars([`space:${OTHER}/MFS`])).rejects.toThrow("isn't part of this connection");
  });

  it("keeps a space icon per site, so two sites' spaces with one key don't share it", async () => {
    const second: AccessibleResource = { id: OTHER, name: "Other", url: "https://other.atlassian.net", scopes: [] };
    const configurator = ui({ getSites: async () => [SITE, second] });
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.hostname === "api.media.atlassian.com") return new Response(new Uint8Array([137, 80, 78, 71, Number(url.searchParams.get("n"))]), { headers: { "Content-Type": "image/png" } });
      if (url.pathname.endsWith("/spaces")) return json({ results: [space("MFS", { icon: { apiDownloadLink: "/wiki/rest/api/icon/mfs" } })] });
      const n = url.pathname.includes(CLOUD) ? "1" : "2";
      return new Response(null, { status: 302, headers: { Location: `https://api.media.atlassian.com/file/${n}/image?n=${n}` } });
    });
    await configurator.loadItems({ site: `site:${CLOUD}`, section: "spaces" });
    await configurator.loadItems({ site: `site:${OTHER}`, section: "spaces" });
    const avatars = await configurator.spaceAvatars([`space:${CLOUD}/MFS`, `space:${OTHER}/MFS`]);
    expect(avatars[`space:${CLOUD}/MFS`]).not.toBe(avatars[`space:${OTHER}/MFS`]);
  });

  it("lists what the user starred, spaces and pages alike, a page at a time", async () => {
    route(/^\/wiki\/rest\/api\/search\?/, {
      results: [
        hit({ id: "524290", type: "page", title: "Nested Test 2", ancestors: [] }),
        { title: "My first space", entityType: "space", space: { key: "MFS", name: "My first space", type: "global" } },
      ],
      _links: { next: "/rest/api/search?cursor=x" },
      size: 2, start: 0, limit: 2,
    });
    const page = await ui().loadItems({ site: `site:${CLOUD}`, section: "starred" });
    expect(page.items.map(item => [item.kind, item.title])).toEqual([["page", "Nested Test 2"], ["space", "My first space"]]);
    expect(requests[0]!.url.searchParams.get("cql")).toContain("favourite = currentUser()");
    expect(page.nextCursor).toBeDefined();
  });

  it("lists recently viewed pages with where they live and whether they open, nothing on a site that can't, and fails on an outage", async () => {
    route(/^\/wiki\/rest\/api\/search\?/, {
      results: [
        hit({ id: "491521", type: "page", title: "Architecture", children: { page: { size: 2 } }, ancestors: [{ id: "100", type: "page", title: "Home" }, { id: "458753", type: "page", title: "Engineering" }] }),
        hit({ id: "327884", type: "page", title: "Runbook", children: { page: { size: 0 } }, ancestors: [] }),
      ],
    });
    const page = await ui().loadItems({ site: `site:${CLOUD}`, section: "recent" });
    expect(page.items).toEqual([expect.objectContaining({
      ref: `page:${CLOUD}/491521`, kind: "page", title: "Architecture", meta: "Oct 24", expandable: true,
      // The space's home page is the space, so it is not a step of the path.
      path: [
        { ref: `space:${CLOUD}/MFS`, kind: "space", title: "My first space" },
        { ref: `page:${CLOUD}/458753`, kind: "page", title: "Engineering" },
      ],
    }), expect.objectContaining({ title: "Runbook", expandable: false })]);
    expect(requests[0]!.url.searchParams.get("cql")).toContain("recentlyViewedContent");
    expect(requests[0]!.url.searchParams.get("expand")).toContain("content.children.page");

    route(/^\/wiki\/rest\/api\/search\?/, () => json({}, 400));
    expect(await ui().loadItems({ site: `site:${CLOUD}`, section: "recent" })).toEqual({ items: [] });
    route(/^\/wiki\/rest\/api\/search\?/, () => json({}, 500));
    await expect(ui().loadItems({ site: `site:${CLOUD}`, section: "recent" })).rejects.toThrow();
  });

  it("opens a space at its home page, its blog, then the home page's children", async () => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    route(/^\/wiki\/api\/v2\/spaces\/[^/]+\/pages\?/, { results: [pageJson("100", "My first space", { version: { createdAt: "2026-10-20T00:00:00Z" } }), pageJson("200", "Stray")] });
    route(/^\/wiki\/api\/v2\/blogposts\?/, { results: [{ id: "360470", title: "Post" }] });
    route(/^\/wiki\/api\/v2\/pages\/100\/direct-children/, {
      results: [
        { id: "458753", title: "Engineering", type: "page" },
        { id: "600001", title: "Retro", type: "whiteboard" },
        { id: "600003", title: "Archive", type: "folder" },
      ],
    });
    route(/^\/wiki\/api\/v2\/pages\/100\/descendants/, {
      results: [
        { id: "458753", parentId: "100", depth: 1 }, { id: "491521", parentId: "458753", depth: 2 },
        { id: "600001", parentId: "100", depth: 1 }, { id: "600003", parentId: "100", depth: 1 },
      ],
    });

    const page = await ui().loadItems({ parent: `space:${CLOUD}/MFS` });

    expect(page.items.map(item => [item.kind, item.title, item.expandable, item.selectable])).toEqual([
      ["overview", "My first space", false, true],
      ["blogs", "Blog", true, false],
      ["page", "Engineering", true, true],
      ["whiteboard", "Retro", false, false],
      ["folder", "Archive", false, false],
      ["page", "Stray", true, true],
    ]);
    expect(page.items[0]).toMatchObject({ subtitle: "Space home", meta: "Oct 20" });
  });

  it("still lists a space's blog and pages without a parent when its home page can't be read", async () => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    route(/^\/wiki\/api\/v2\/spaces\/[^/]+\/pages\?/, { results: [pageJson("200", "Stray")] });
    route(/^\/wiki\/api\/v2\/pages\/100$/, () => json({}, 403));
    route(/^\/wiki\/api\/v2\/blogposts\?/, { results: [{ id: "360470", title: "Post" }] });
    route(/^\/wiki\/api\/v2\/pages\/100\/(direct-children|descendants)/, () => json({}, 403));

    const page = await ui().loadItems({ parent: `space:${CLOUD}/MFS` });

    expect(page.items.map(item => [item.kind, item.title])).toEqual([["blogs", "Blog"], ["page", "Stray"]]);
  });

  it("heads a space with its home page when the home page isn't among the first pages without a parent", async () => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    route(/^\/wiki\/api\/v2\/spaces\/[^/]+\/pages\?/, { results: [pageJson("200", "Stray")], _links: { next: "/wiki/api/v2/spaces/1/pages?cursor=r2" } });
    route(/^\/wiki\/api\/v2\/pages\/100$/, pageJson("100", "My first space"));
    route(/^\/wiki\/api\/v2\/blogposts\?/, { results: [] });
    route(/^\/wiki\/api\/v2\/pages\/100\/(direct-children|descendants)/, { results: [] });

    const page = await ui().loadItems({ parent: `space:${CLOUD}/MFS` });

    expect(page.items.map(item => [item.kind, item.title])).toEqual([["overview", "My first space"], ["page", "Stray"]]);
  });

  it("pages through the home page's children, then the pages without a parent", async () => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    route(/^\/wiki\/api\/v2\/spaces\/[^/]+\/pages\?/, (url: URL) => url.searchParams.get("cursor") === "r2"
      ? json({ results: [pageJson("201", "Stray too")] })
      : json({ results: [pageJson("100", "My first space"), pageJson("200", "Stray")], _links: { next: "/wiki/api/v2/spaces/1/pages?cursor=r2" } }));
    route(/^\/wiki\/api\/v2\/blogposts\?/, { results: [] });
    route(/^\/wiki\/api\/v2\/pages\/100\/direct-children/, (url: URL) => url.searchParams.get("cursor") === "c2"
      ? json({ results: [{ id: "2", title: "Second", type: "page" }] })
      : json({ results: [{ id: "1", title: "First", type: "page" }], _links: { next: "/wiki/api/v2/pages/100/direct-children?cursor=c2" } }));
    route(/^\/wiki\/api\/v2\/pages\/100\/descendants/, { results: [] });
    const configurator = ui();
    const parent = `space:${CLOUD}/MFS`;

    const first = await configurator.loadItems({ parent });
    const second = await configurator.loadItems({ parent, cursor: first.nextCursor });
    const third = await configurator.loadItems({ parent, cursor: second.nextCursor });
    const fourth = await configurator.loadItems({ parent, cursor: third.nextCursor });

    expect([first, second, third, fourth].map(page => page.items.map(item => item.title))).toEqual([
      ["My first space", "First"], ["Second"], ["Stray"], ["Stray too"],
    ]);
    expect(fourth.nextCursor).toBeUndefined();
    await expect(configurator.loadItems({ parent, cursor: "home:zzz" })).rejects.toThrow("expired");
  });

  it("lists only pages, and says so, when a grant from before scopes were recorded can't read the content tree", async () => {
    route(/^\/wiki\/api\/v2\/pages\/458753\/direct-children/, () => json({}, 401));
    route(/^\/wiki\/api\/v2\/pages\/458753\/children/, { results: [{ id: "491521", title: "Architecture" }] });
    const configurator = ui({ getGrantedScopes: async () => null, refresh: async () => { throw new Error("no"); } });

    const page = await configurator.loadItems({ parent: `page:${CLOUD}/458753` });

    expect(page.items.map(item => item.title)).toEqual(["Architecture"]);
    expect(page.notice).toMatch(/Reconnect Confluence/);
    // Found out once, it isn't asked again.
    requests = [];
    await configurator.loadItems({ parent: `page:${CLOUD}/458753` });
    expect(requests.some(request => request.url.pathname.endsWith("/direct-children"))).toBe(false);
  });

  it("keeps the content tree when Confluence denies one page to a grant that holds the scope", async () => {
    route(/^\/wiki\/api\/v2\/pages\/458753\/direct-children/, () => json({}, 403));
    const configurator = ui();

    await expect(configurator.loadItems({ parent: `page:${CLOUD}/458753` })).rejects.toThrow();
    await expect(configurator.loadItems({ parent: `page:${CLOUD}/458753` })).rejects.toThrow();
    expect(requests.filter(request => request.url.pathname.endsWith("/direct-children"))).toHaveLength(2);
  });

  it("asks the account again after its scopes couldn't be read, so Try again recovers", async () => {
    route(/^\/wiki\/api\/v2\/pages\/458753\/direct-children/, { results: [] });
    const getGrantedScopes = vi.fn().mockRejectedValueOnce(new Error("reset")).mockResolvedValue(["read:hierarchical-content:confluence"]);
    const configurator = ui({ getGrantedScopes });

    await expect(configurator.loadItems({ parent: `page:${CLOUD}/458753` })).rejects.toThrow("reset");
    expect(await configurator.loadItems({ parent: `page:${CLOUD}/458753` })).toEqual({ items: [] });
  });

  it("opens a space whose key is a legacy personal one", async () => {
    const legacy = space("~john.smith", { type: "personal" });
    route(/^\/wiki\/api\/v2\/spaces\?keys=/, { results: [legacy] });
    route(/^\/wiki\/api\/v2\/spaces\/[^/]+\/pages\?/, { results: [] });
    route(/^\/wiki\/api\/v2\/blogposts\?/, { results: [] });
    route(/^\/wiki\/api\/v2\/pages\/100/, { results: [] });

    await ui().loadItems({ parent: `space:${CLOUD}/~john.smith` });

    expect(requests[0]!.url.searchParams.get("keys")).toBe("~john.smith");
    expect(await ui().resourceUrlFor(`space:${CLOUD}/~john.smith`)).toBe("https://slew.atlassian.net/wiki/spaces/~john.smith");
  });

  it("searches spaces, pages and blog posts, without Confluence's highlight markers in their titles", async () => {
    route(/^\/wiki\/rest\/api\/search\?/, {
      results: [
        hit({ id: "524289", type: "page", title: "Storage @@@hl@@@arch@@@endhl@@@itecture", ancestors: [] }),
        hit({ id: "360470", type: "blogpost", title: "Shipping" }),
        { title: "@@@hl@@@Arch@@@endhl@@@ive", entityType: "space", space: { key: "AR", name: "Archive" } },
      ],
      _links: { next: "/next" },
    });

    const page = await ui().loadItems({ site: `site:${CLOUD}`, query: "arch" });

    expect(page.items.map(item => [item.kind, item.title, item.path?.map(crumb => crumb.title)])).toEqual([
      ["page", "Storage architecture", ["My first space"]],
      ["blogpost", "Shipping", ["My first space", "Blog"]],
      ["space", "Archive", []],
    ]);
    expect(page.nextCursor).toBe("20");
    expect(requests[0]!.url.searchParams.get("cql")).toBe('type in (space, page, blogpost) AND siteSearch ~ "arch"');
  });

  it("looks up a pasted link in place of searching for it", async () => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    const page = await ui().loadItems({ site: `site:${CLOUD}`, query: "https://slew.atlassian.net/wiki/spaces/MFS/overview" });
    expect(page.items).toEqual([expect.objectContaining({ ref: `space:${CLOUD}/MFS`, kind: "space" })]);
    // One without its scheme is a link too, as the frame shows it, and one longer than a search may be is still a link.
    const bare = await ui().loadItems({ site: `site:${CLOUD}`, query: "www.slew.atlassian.net/wiki/spaces/MFS" });
    expect(bare.items).toEqual([]);
    expect(requests.some(request => request.url.pathname.endsWith("/search"))).toBe(false);
    const shared = await ui().loadItems({ site: `site:${CLOUD}`, query: `https://slew.atlassian.net/wiki/spaces/MFS/overview?atlOrigin=${"e".repeat(220)}` });
    expect(shared.items).toEqual([expect.objectContaining({ ref: `space:${CLOUD}/MFS` })]);

    const elsewhere = await ui().loadItems({ site: `site:${CLOUD}`, query: "https://other.atlassian.net/wiki/spaces/MFS" });
    expect(elsewhere).toEqual({ items: [], notice: expect.stringContaining("isn't to a Confluence page") });
  });
});

describe("locate", () => {
  beforeEach(() => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    route(/^\/wiki\/api\/v2\/pages\/524289$/, pageJson("524289", "Storage"));
    route(/^\/wiki\/rest\/api\/search\?/, {
      results: [hit({ id: "524289", type: "page", title: "Storage", ancestors: [{ id: "100", type: "page", title: "Home" }, { id: "700", type: "folder", title: "Designs" }] })],
    });
  });

  it("finds a page with its path, folders included, without reading its body", async () => {
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/MFS/pages/524289/Storage")).toMatchObject({
      ref: `page:${CLOUD}/524289`, title: "Storage",
      path: [{ kind: "space", title: "My first space" }, { ref: `folder:${CLOUD}/700`, kind: "folder", title: "Designs" }],
    });
    expect(requests.find(request => request.url.pathname.endsWith("/pages/524289"))!.url.searchParams.has("body-format")).toBe(false);
  });

  it("decodes a short link without asking Confluence what it is", async () => {
    // AQAI is page 524289's tiny ID.
    expect(await ui().locate("https://slew.atlassian.net/wiki/x/AQAI")).toMatchObject({ ref: `page:${CLOUD}/524289` });
  });

  it("finds a blog post through its page-shaped URL", async () => {
    route(/^\/wiki\/api\/v2\/pages\/360470$/, () => json({}, 404));
    route(/^\/wiki\/api\/v2\/blogposts\/360470$/, { id: "360470", title: "Post", status: "current", _links: { webui: "/spaces/MFS/blog/2026/10/26/360470/Post" } });
    route(/^\/wiki\/rest\/api\/search\?/, { results: [] });
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/MFS/pages/360470")).toMatchObject({
      ref: `blogpost:${CLOUD}/360470`, kind: "blogpost", path: [{ kind: "space" }, { kind: "blogs", title: "Blog" }],
    });
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/MFS/blog/2026/10/26/360470/Post")).toMatchObject({ ref: `blogpost:${CLOUD}/360470` });
  });

  it("names only what a link names, never the space or site around it", async () => {
    for (const path of ["/wiki/not-a-resource", "/wiki/spaces", "/wiki/spaces/MFS/whiteboard/123", "/wiki/spaces/MFS/folder/600003", "/wiki/spaces/MFS/pages/edit-v2/524289", "/wiki/pages/viewpage.action?pageId=x"]) {
      expect(await ui().locate(`https://slew.atlassian.net${path}`), path).toBeNull();
    }
    expect(requests).toEqual([]);
    expect(await ui().locate("https://slew.atlassian.net/wiki/home")).toMatchObject({ kind: "site" });
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/MFS/pages")).toMatchObject({ ref: `space:${CLOUD}/MFS` });
    expect(await ui().locate("https://slew.atlassian.net/wiki/pages/viewpage.action?pageId=524289")).toMatchObject({ ref: `page:${CLOUD}/524289` });
  });

  it("finds a site and a space", async () => {
    expect(await ui().locate("https://slew.atlassian.net/wiki")).toMatchObject({ ref: `site:${CLOUD}`, kind: "site" });
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/MFS")).toMatchObject({ ref: `space:${CLOUD}/MFS`, path: [] });
  });

  it("is null for another site, an archived space, something gone, or not a link", async () => {
    expect(await ui().locate("https://other.atlassian.net/wiki/spaces/MFS")).toBeNull();
    expect(await ui().locate("not a url")).toBeNull();
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/GONE")).toBeNull();
    route(/^\/wiki\/api\/v2\/spaces\?keys=OLD/, { results: [space("OLD", { status: "archived" })] });
    expect(await ui().locate("https://slew.atlassian.net/wiki/spaces/OLD")).toBeNull();
  });
});

describe("resourceUrlFor", () => {
  beforeEach(() => {
    route(/^\/wiki\/api\/v2\/spaces\?keys=MFS/, { results: [MFS] });
    route(/^\/wiki\/api\/v2\/pages\/524289$/, pageJson("524289", "Storage"));
    route(/^\/wiki\/api\/v2\/blogposts\/360470$/, { id: "360470", title: "Post", status: "current", _links: { webui: "/spaces/MFS/blog/2026/10/26/360470/Post" } });
  });

  it("writes each kind of choice as the URL its resource type matches", async () => {
    const configurator = ui();
    const site = await configurator.resourceUrlFor(`site:${CLOUD}`);
    const spaceUrl = await configurator.resourceUrlFor(`space:${CLOUD}/MFS`);
    const page = await configurator.resourceUrlFor(`page:${CLOUD}/524289`);
    const blog = await configurator.resourceUrlFor(`blogpost:${CLOUD}/360470`);
    expect([site, spaceUrl, page, blog]).toEqual([
      "https://slew.atlassian.net/wiki",
      "https://slew.atlassian.net/wiki/spaces/MFS",
      "https://slew.atlassian.net/wiki/spaces/MFS/pages/524289",
      "https://slew.atlassian.net/wiki/spaces/MFS/pages/360470",
    ]);
    expect([site, spaceUrl, page, blog].map(boundPattern)).toEqual([PATTERNS.site, PATTERNS.space, PATTERNS.page, PATTERNS.page]);
  });

  it("refuses what can't be bound", async () => {
    await expect(ui().resourceUrlFor(`folder:${CLOUD}/700`)).rejects.toThrow("folder can't be connected");
    await expect(ui().resourceUrlFor(`blogs:${CLOUD}/MFS`)).rejects.toThrow("Choose one post");
    await expect(ui().resourceUrlFor(`site:${OTHER}`)).rejects.toThrow("isn't part of this connection");
    route(/^\/wiki\/api\/v2\/spaces\?keys=OLD/, { results: [space("OLD", { status: "archived" })] });
    await expect(ui().resourceUrlFor(`space:${CLOUD}/OLD`)).rejects.toThrow("archived");
    route(/^\/wiki\/api\/v2\/pages\/1$/, pageJson("1", "Draft", { status: "draft" }));
    await expect(ui().resourceUrlFor(`page:${CLOUD}/1`)).rejects.toThrow("no longer exists");
    await expect(ui().resourceUrlFor(`page:${CLOUD}/2`)).rejects.toThrow("no longer exists");
  });
});

describe("text from Confluence", () => {
  it("drops controls that could reorder what is shown around it", () => {
    expect(displayText("a‮b\u0007c  ")).toBe("abc");
    expect(displayText("x".repeat(500))).toHaveLength(240);
  });

  it("strips highlight markers from a search title", () => {
    expect(searchTitle("@@@hl@@@Arch@@@endhl@@@itecture of @@@hl@@@arch@@@endhl@@@ives")).toBe("Architecture of archives");
    expect(searchTitle("no marks")).toBe("no marks");
  });
});

describe("the RPC surface", () => {
  it("is the five methods the frame calls, with every helper kept off the prototype Cap'n Web exposes", () => {
    expect(Object.getOwnPropertyNames(ConfluenceConfiguratorUI.prototype).filter(name => name !== "constructor").toSorted())
      .toEqual(["getStatus", "loadItems", "locate", "resourceUrlFor", "spaceAvatars"]);
  });
});
