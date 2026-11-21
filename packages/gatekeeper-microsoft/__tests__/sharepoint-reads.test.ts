// The Graph reads: what each asks for, how a collection is walked to its end, and how an agent's
// search words reach Microsoft Search.

import { describe, expect, it } from "vitest";
import { GraphApi, GraphApiError } from "../src/graph-api";
import { grantedSites, listDrives, listLists, searchAll } from "../src/sharepoint-reads";
import { namedSites } from "../src/sharepoint-resolve";
import { normalizeForShares, shareIdFor } from "../src/sharepoint-urls";

const SITE = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,33333333-3333-3333-3333-333333333333";
const GRAPH = "https://graph.microsoft.com/v1.0";

type Sent = { method: string; url: string; body?: Record<string, unknown> };

/** A Graph answering each request with the next scripted body, recording what was asked. */
function harness(replies: unknown[]) {
  const sent: Sent[] = [];
  const api = new GraphApi("token", {
    fetch: async (input, init) => {
      sent.push({ method: init?.method ?? "GET", url: String(input), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return Response.json(replies.shift() ?? {});
    },
  });
  return { api, sent };
}

const drive = (id: string) => ({ id, name: id, webUrl: `https://contoso.sharepoint.com/${id}`, driveType: "documentLibrary" });
const list = (id: string) => ({ id, name: id, displayName: id, webUrl: `https://contoso.sharepoint.com/Lists/${id}`, list: { template: "genericList" } });

/** The KQL a search request carried. */
const queryOf = (request: Sent) => (request.body as { requests: { query: { queryString: string } }[] }).requests[0]!.query.queryString;

describe("search words", () => {
  it("quotes each word and each quoted phrase, so operators and property filters are only words", async () => {
    const { api, sent } = harness([{ value: [] }]);
    await searchAll(api, 'budget  "Q3 plan" path:secret OR (NOT x)', undefined, 0, 25);
    expect(queryOf(sent[0])).toBe('"budget" "Q3 plan" "path:secret" "OR" "(NOT" "x)"');
  });

  it("appends the path filter after the words as one group", async () => {
    const { api, sent } = harness([{ value: [] }]);
    await searchAll(api, 'plan "with "quotes', 'https://contoso.sharepoint.com/sites/Eng/Specs"', 0, 25);
    expect(queryOf(sent[0])).toBe('("plan" "with" "quotes") path:"https://contoso.sharepoint.com/sites/Eng/Specs"');
  });

  it("reads hits as where each item lives, and a further page from moreResultsAvailable", async () => {
    const { api } = harness([{
      value: [{ hitsContainers: [{
        moreResultsAvailable: true,
        hits: [
          { resource: { id: "01A", parentReference: { driveId: "b!one" } } },
          { resource: { id: "01B" } },
          { nothing: true },
        ],
      }] }],
    }]);
    expect(await searchAll(api, "plan", undefined, 25, 25)).toEqual({ hits: [{ driveId: "b!one", itemId: "01A" }], nextFrom: 50 });
    await expect(searchAll(harness(["not an object"]).api, "plan", undefined, 0, 25)).rejects.toThrow(GraphApiError);
  });
});

describe("walking a site's collections", () => {
  it("follows nextLink to the end for libraries and lists", async () => {
    const { api, sent } = harness([
      { value: [drive("d1")], "@odata.nextLink": `${GRAPH}/sites/${SITE}/drives?$skiptoken=2` },
      { value: [drive("d2")] },
    ]);
    expect((await listDrives(api, SITE)).map(found => found.id)).toEqual(["d1", "d2"]);
    expect(sent.map(request => request.url)).toEqual([
      `${GRAPH}/sites/${SITE}/drives?%24select=id%2Cname%2CwebUrl%2CdriveType%2Cdescription%2CsharePointIds%2Cowner%2ClastModifiedDateTime`,
      `${GRAPH}/sites/${SITE}/drives?$skiptoken=2`,
    ]);
    // The pages probe is asked alongside the first page of lists, so it answers second.
    const lists = harness([
      { value: [list("l1")], "@odata.nextLink": `${GRAPH}/sites/${SITE}/lists?$skiptoken=2` },
      { value: [] },
      { value: [list("l2")] },
    ]);
    expect((await listLists(lists.api, SITE)).lists.map(found => found.id)).toEqual(["l1", "l2"]);
  });

  it("refuses a continuation that points away from Graph", async () => {
    const { api } = harness([{ value: [drive("d1")], "@odata.nextLink": "https://evil.example/next" }]);
    await expect(listDrives(api, SITE)).rejects.toThrow(/continuation link to somewhere else/);
  });
});

describe("the sites a Sites.Selected connection can open", () => {
  const WEB = "33333333-3333-3333-3333-333333333333";
  /** Each name's site collection GUID, and back. */
  const names = new Map<string, string>();
  const collection = (name: string) => {
    const guid = `00000000-0000-0000-0000-${[...name].map(char => char.charCodeAt(0).toString(16)).join("").padStart(12, "0").slice(-12)}`;
    names.set(guid, name);
    return guid;
  };
  const site = (name: string, extra: Record<string, unknown> = {}) =>
    ({ id: `contoso.sharepoint.com,${collection(name)},${WEB}`, displayName: name, webUrl: `https://contoso.sharepoint.com/sites/${name}`, ...extra });

  /**
   * A tenant whose search names `named`, a page at a time, and whose libraries answer by site name:
   * 200 for one in `granted`, else what `refusal` says. Records each search's paging and each batch's size.
   */
  function tenant(named: Record<string, unknown>[], granted: string[], options: { refusal?: (name: string) => number; search?: (from: number) => Response | undefined; failBatchWith?: string } = {}) {
    const searches: { from: number; size: number }[] = [];
    const batches: number[] = [];
    const other: string[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    const api = new GraphApi("token", {
      fetch: async (input, init) => {
        const url = String(input).slice(GRAPH.length);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { requests: Record<string, unknown>[] } : undefined;
        if (url === "/search/query") {
          const { from, size } = body!.requests[0] as { from: number; size: number };
          searches.push({ from, size });
          const failed = options.search?.(from);
          if (failed) return failed;
          return Response.json({ value: [{ hitsContainers: [{
            moreResultsAvailable: from + size < named.length, hits: named.slice(from, from + size).map(resource => ({ resource })),
          }] }] });
        }
        if (url === "/$batch") {
          batches.push(body!.requests.length);
          mostInFlight = Math.max(mostInFlight, ++inFlight);
          await new Promise(resolve => setTimeout(resolve, 1));
          inFlight--;
          if (options.failBatchWith !== undefined && body!.requests.some(request => String(request.url).includes(collection(options.failBatchWith!)))) {
            return Response.json({ error: { code: "generalException", message: "down" } }, { status: 500 });
          }
          return Response.json({ responses: body!.requests.map(request => {
            const name = names.get(/^sites\/contoso\.sharepoint\.com,([^,]+),[^,/]+\/drive\?\$select=id$/.exec(String(request.url))?.[1] ?? "");
            if (name === undefined) throw new Error(`unexpected batched request ${String(request.url)}`);
            return { id: request.id, status: granted.includes(name) ? 200 : options.refusal?.(name) ?? 403, body: {} };
          }) });
        }
        other.push(url);
        if (url.startsWith("/sites/root?")) return Response.json(site("Home", { root: {} }));
        return Response.json({ error: { code: "accessDenied", message: "not here" } }, { status: 403 });
      },
    });
    return { api, searches, batches, other, mostInFlight: () => mostInFlight };
  }

  it("asks every site search names for its library, a few batches at a time, and keeps the ones that open, by name", async () => {
    const named = Array.from({ length: 620 }, (_, index) => site(`S${String(index).padStart(3, "0")}`));
    const { api, searches, batches, other, mostInFlight } = tenant(named, ["S611", "S007", "Home"]);
    expect(await grantedSites(api)).toMatchObject({ sites: [{ name: "Home" }, { name: "S007" }, { name: "S611" }], complete: true });
    expect(searches).toEqual([{ from: 0, size: 500 }, { from: 500, size: 500 }]);
    // The home site rides with the first page: 501 sites, then 120.
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(621);
    expect(Math.max(...batches)).toBe(20);
    expect(mostInFlight()).toBe(4);
    // Followed sites are never asked for: Graph refuses them under Sites.Selected.
    expect(other).toEqual([expect.stringMatching(/^\/sites\/root\?/)]);
  });

  it("asks each site once, and never a OneDrive, a system site or a storage container", async () => {
    const named = [
      site("Eng"), site("Eng"), site("Home", { root: {} }),
      site("Mine", { webUrl: "https://contoso-my.sharepoint.com/personal/me", isPersonalSite: true }),
      site("appcatalog"), site("Designer", { webUrl: "https://contoso.sharepoint.com/contentstorage/x" }),
    ];
    const { api, batches } = tenant(named, ["Eng", "Mine", "appcatalog", "Designer"]);
    expect((await grantedSites(api)).sites.map(found => found.name)).toEqual(["Eng"]);
    expect(batches).toEqual([2]);
  });

  it("finds none where none was granted, a site without a library included, and is sure of it", async () => {
    const { api } = tenant([site("A"), site("B")], [], { refusal: name => name === "B" ? 404 : 403 });
    expect(await grantedSites(api)).toEqual({ sites: [], complete: true });
  });

  it("is incomplete when a site's check got no answer, and keeps what did", async () => {
    const { api } = tenant([site("A"), site("B")], ["A"], { refusal: () => 503 });
    expect(await grantedSites(api)).toMatchObject({ sites: [{ name: "A" }], complete: false });
  });

  it("loses only a failed batch's sites, and reads on", async () => {
    const named = Array.from({ length: 520 }, (_, index) => site(`S${String(index).padStart(3, "0")}`));
    const { api, searches } = tenant(named, ["S005", "S030", "S510"], { failBatchWith: "S005" });
    expect(await grantedSites(api)).toMatchObject({ sites: [{ name: "S030" }, { name: "S510" }], complete: false });
    expect(searches).toHaveLength(2);
  });

  it("is incomplete when search fails on Microsoft's side: the home site alone at first, what was found later", async () => {
    const down = () => Response.json({ error: { code: "generalException", message: "down" } }, { status: 500 });
    const first = tenant([], ["Home"], { search: down });
    expect(await grantedSites(first.api)).toMatchObject({ sites: [{ name: "Home" }], complete: false });
    const named = Array.from({ length: 501 }, (_, index) => site(`S${index}`));
    const later = tenant(named, ["S3"], { search: from => from === 0 ? undefined : down() });
    expect(await grantedSites(later.api)).toMatchObject({ sites: [{ name: "S3" }], complete: false });
    // Throttled part-way keeps what was found too; throttled at the start is the caller's to hear.
    const throttled = () => Response.json({ error: { code: "TooManyRequests", message: "slow down" } }, { status: 429, headers: { "retry-after": "600" } });
    const midway = tenant(named, ["S3"], { search: from => from === 0 ? undefined : throttled() });
    expect(await grantedSites(midway.api)).toMatchObject({ sites: [{ name: "S3" }], complete: false });
    await expect(grantedSites(tenant(named, ["S3"], { search: throttled }).api)).rejects.toThrow(/limiting how fast/);
  });

  it("fails when search refuses the request, which is no answer about the sites", async () => {
    const { api } = tenant([], [], { search: () => Response.json({ error: { code: "accessDenied", message: "no" } }, { status: 403 }) });
    await expect(grantedSites(api)).rejects.toThrow(GraphApiError);
  });
});

describe("the sites a deployment names for Sites.Selected", () => {
  const HOST = "https://contoso.sharepoint.com";
  const TENANT = { name: "contoso", id: "11111111-1111-1111-1111-111111111111" };
  const idOf = (n: number) => `contoso.sharepoint.com,00000000-0000-0000-0000-00000000000${n},33333333-3333-3333-3333-333333333333`;
  /** The sites that exist, by link: Eng and Mkt granted to the app, Hr not, and Other in another tenant. */
  const exists: Record<string, { id: string; name: string; library: number; tenantId?: string }> = {
    [`${HOST}/sites/Eng`]: { id: idOf(1), name: "Eng", library: 200 },
    [`${HOST}/sites/Mkt`]: { id: idOf(2), name: "Mkt", library: 200 },
    [`${HOST}/sites/Hr`]: { id: idOf(3), name: "Hr", library: 403 },
    [`${HOST}/sites/Busy`]: { id: idOf(4), name: "Busy", library: 500 },
    [`${HOST}/sites/Other`]: { id: idOf(5), name: "Other", library: 200, tenantId: "22222222-2222-2222-2222-222222222222" },
  };

  function harness() {
    const sent: string[] = [];
    const api = new GraphApi("token", {
      fetch: async input => {
        const url = new URL(String(input));
        const path = decodeURIComponent(url.pathname.slice("/v1.0".length));
        sent.push(path);
        const miss = Response.json({ error: { code: "itemNotFound", message: "not found" } }, { status: 404 });
        const wire = (link: string) => {
          const found = exists[link]!;
          return { id: found.id, displayName: found.name, webUrl: link, sharepointIds: { tenantId: found.tenantId ?? TENANT.id, siteUrl: link } };
        };
        const shared = Object.keys(exists).find(link => path === `/shares/${shareIdFor(normalizeForShares(new URL(link)))}/site`);
        if (shared !== undefined) return Response.json(wire(shared));
        const byId = Object.keys(exists).find(link => path.startsWith(`/sites/${exists[link]!.id}`));
        if (byId === undefined) return miss;
        if (path.endsWith("/drive")) {
          const { library } = exists[byId]!;
          return library === 200 ? Response.json({ id: "b!drive" }) : Response.json({ error: { code: "x", message: "x" } }, { status: library });
        }
        return Response.json(wire(byId));
      },
    });
    return { api, sent };
  }

  it("lists the named links that are granted sites of this tenant, each once, by name", async () => {
    const { api, sent } = harness();
    const links = [`${HOST}/sites/Mkt`, `${HOST}/sites/Eng`, `${HOST}/sites/Hr`, `${HOST}/sites/Gone`, `${HOST}/sites/Other`,
      "https://fabrikam.sharepoint.com/sites/Eng", "not a link", `${HOST}/sites/Eng/`];
    expect(await namedSites(api, links, TENANT)).toMatchObject({ sites: [{ name: "Eng" }, { name: "Mkt" }], complete: true });
    // Nothing is searched for: only the links are asked about.
    expect(sent.some(path => path.includes("search"))).toBe(false);
  });

  it("is incomplete when a link couldn't be checked, and keeps the rest", async () => {
    const { api } = harness();
    expect(await namedSites(api, [`${HOST}/sites/Busy`, `${HOST}/sites/Eng`], TENANT)).toMatchObject({ sites: [{ name: "Eng" }], complete: false });
  });
});
