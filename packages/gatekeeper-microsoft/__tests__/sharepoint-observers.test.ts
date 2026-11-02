import { describe, expect, it } from "vitest";
import type { BatchRequest, BatchResponse, GraphApi } from "../src/graph-api";
import { AccessProbeError, decodeUnit, encodeUnit, probeUnits, units, type AccessUnit } from "../src/sharepoint-observers";

const SITE = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";
const DRIVE = "b!abc_DEF-123";
const ITEM = "01ABCDEFGHIJKLMNOPQRSTUVWX";
const LIST = "33333333-3333-3333-3333-333333333333";
const PAGE = "44444444-4444-4444-4444-444444444444";
const file = { driveId: DRIVE, itemId: ITEM };
const list = { siteId: SITE, listId: LIST };
const page = { siteId: SITE, pageId: PAGE };

describe("access units", () => {
  it("round-trips every kind", () => {
    const all: AccessUnit[] = [
      { kind: "site", siteId: SITE },
      { kind: "drive", driveId: DRIVE },
      { kind: "item", ...file },
      { kind: "list", ...list },
      { kind: "listItem", ...list, itemId: "7" },
      { kind: "page", ...page },
      { kind: "content", ...file },
      { kind: "versions", ...file },
      { kind: "fileVersion", ...file, version: "3.1" },
      { kind: "listItemVersion", ...list, itemId: "7", version: "2.0" },
      { kind: "pageVersion", ...page, version: "1.1" },
    ];
    for (const unit of all) expect(decodeUnit(encodeUnit(unit))).toEqual(unit);
  });

  it("refuses what this version can't parse", () => {
    expect(decodeUnit(`fileVersion:${DRIVE}:${ITEM}:latest`)).toBeNull();
    expect(decodeUnit(`pageVersion:${SITE}:${PAGE}`)).toBeNull();
    expect(decodeUnit(`content:${DRIVE}`)).toBeNull();
    expect(decodeUnit(`content:${DRIVE}:a/b`)).toBeNull();
    expect(decodeUnit("someday:x")).toBeNull();
  });

  it("asks for a file's content, not just its details, and pins a draft or an unapproved version", () => {
    expect(units.fileRead(file).map(id => decodeUnit(id)?.kind)).toEqual(["item", "content"]);
    expect(units.fileRead(file, "4.0").map(id => decodeUnit(id)?.kind)).toEqual(["item", "content"]);
    expect(units.fileRead(file, "4.0", 0).map(id => decodeUnit(id)?.kind)).toEqual(["item", "content"]);
    expect(units.fileRead(file, "4.2").map(id => decodeUnit(id))).toContainEqual({ kind: "fileVersion", ...file, version: "4.2" });
    // A major version awaiting approval: a reader without approval rights is shown the last approved one.
    expect(units.fileRead(file, "4.0", 2).map(id => decodeUnit(id))).toContainEqual({ kind: "fileVersion", ...file, version: "4.0" });
    expect(units.versions(file).map(id => decodeUnit(id)?.kind)).toEqual(["item", "versions"]);
  });

  it("pins a page only while it has unpublished changes", () => {
    expect(units.pageRead(page, "published", "2.0").map(id => decodeUnit(id)?.kind)).toEqual(["page"]);
    expect(units.pageRead(page, "draft", "2.1").map(id => decodeUnit(id))).toContainEqual({ kind: "pageVersion", ...page, version: "2.1" });
    expect(units.pageRead(page, "checkout", "2.1")).toHaveLength(2);
    expect(units.pageRead(page, "draft")).toHaveLength(1);
  });

  it("pins a list item that is a draft or awaits approval", () => {
    expect(units.listItemRead(list, "7", "3.0", 0)).toHaveLength(1);
    expect(units.listItemRead(list, "7", "3.0")).toHaveLength(1);
    expect(units.listItemRead(list, "7", "3.1")).toHaveLength(2);
    expect(units.listItemRead(list, "7", "3.0", 2).map(id => decodeUnit(id))).toContainEqual({ kind: "listItemVersion", ...list, itemId: "7", version: "3.0" });
  });
});

/** A Graph that answers each batched probe from `answer`, recording the requests. */
function graph(answer: (request: BatchRequest) => Omit<BatchResponse, "id">): { api: GraphApi; batches: BatchRequest[][] } {
  const batches: BatchRequest[][] = [];
  const api = {
    batch: async (requests: readonly BatchRequest[]) => {
      batches.push([...requests]);
      return new Map(requests.map(request => [request.id, { id: request.id, ...answer(request) }]));
    },
  } as unknown as GraphApi;
  return { api, batches };
}

describe("probeUnits", () => {
  it("counts a file's content as open when Graph redirects to the bytes, without following it", async () => {
    const { api, batches } = graph(request => request.url.endsWith("/content") ? { status: 302, body: null } : { status: 200, body: {} });
    expect(await probeUnits(api, units.fileRead(file))).toEqual([true, true]);
    expect(batches[0].map(request => request.url)).toEqual([
      `drives/${DRIVE}/items/${ITEM}?$select=id`, `drives/${DRIVE}/items/${ITEM}/content`,
    ]);
  });

  it("refuses a file someone can see but not open", async () => {
    const { api } = graph(request => request.url.endsWith("/content") ? { status: 403, body: {} } : { status: 200, body: {} });
    expect(await probeUnits(api, units.fileRead(file))).toEqual([true, false]);
  });

  it("admits a draft only to someone shown that same draft", async () => {
    const shownPublished = graph(() => ({ status: 200, body: { publishingState: { level: "published", versionId: "1.0" }, _UIVersionString: "1.0" } }));
    const draftUnits = [
      encodeUnit({ kind: "pageVersion", ...page, version: "1.1" }),
      encodeUnit({ kind: "fileVersion", ...file, version: "1.1" }),
      encodeUnit({ kind: "listItemVersion", ...list, itemId: "7", version: "1.1" }),
    ];
    expect(await probeUnits(shownPublished.api, draftUnits)).toEqual([false, false, false]);
    const shownDraft = graph(() => ({ status: 200, body: { publishingState: { level: "draft", versionId: "1.1" }, _UIVersionString: "1.1" } }));
    expect(await probeUnits(shownDraft.api, draftUnits)).toEqual([true, true, true]);
  });

  it("denies units it can't parse without asking Graph", async () => {
    const { api, batches } = graph(() => ({ status: 200, body: {} }));
    expect(await probeUnits(api, [units.item(file), "someday:x"])).toEqual([true, false]);
    expect(batches[0]).toHaveLength(1);
  });

  it("treats a redirect for anything but content as a check that couldn't be made", async () => {
    const { api } = graph(() => ({ status: 302, body: null }));
    await expect(probeUnits(api, [units.item(file)])).rejects.toBeInstanceOf(AccessProbeError);
  });

  it("fails closed when Graph can't answer", async () => {
    const { api } = graph(() => ({ status: 429, body: {} }));
    await expect(probeUnits(api, [units.item(file)])).rejects.toBeInstanceOf(AccessProbeError);
  });

  it("probes twenty to a batch", async () => {
    const { api, batches } = graph(() => ({ status: 404, body: {} }));
    const ids = Array.from({ length: 45 }, (_, index) => units.listItem(list, String(index + 1)));
    expect(await probeUnits(api, ids)).toEqual(Array.from({ length: 45 }, () => false));
    expect(batches.map(batch => batch.length)).toEqual([20, 20, 5]);
  });
});
