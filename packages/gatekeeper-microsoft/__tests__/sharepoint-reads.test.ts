// The Graph reads: what each asks for, how a collection is walked to its end, and how an agent's
// search words reach Microsoft Search.

import { describe, expect, it } from "vitest";
import { GraphApi, GraphApiError } from "../src/graph-api";
import { listDrives, listLists, searchAll } from "../src/sharepoint-reads";

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
