import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphApiError } from "../src/graph-api";
import type { GraphDrive, GraphDriveItem } from "../src/graph-parse";
import {
  OutsideScopeError, ScopeGuard, decodeItemRef, decodeListRef, decodePageRef, decodeSiteId, encodeItemRef, encodeListRef,
  encodePageRef, requireScope, type ItemRef, type SharePointScope,
} from "../src/sharepoint-scope";

const DRIVE = "b!AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_DRIVE = "b!BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLECTION = "11111111-1111-1111-1111-111111111111";
const OTHER_COLLECTION = "22222222-2222-2222-2222-222222222222";
const WEB = "33333333-3333-3333-3333-333333333333";
const SITE = `contoso.sharepoint.com,${COLLECTION},${WEB}`;
const LIST = "44444444-4444-4444-4444-444444444444";
const PAGE = "55555555-5555-5555-5555-555555555555";

function item(id: string, parentId: string | undefined, fields: Partial<GraphDriveItem> = {}): GraphDriveItem {
  return {
    id, driveId: DRIVE, name: id, webUrl: `https://contoso.sharepoint.com/${id}`, kind: "folder",
    isRoot: parentId === undefined, isPackage: false, siteCollectionId: COLLECTION, webId: WEB,
    ...(parentId ? { parentId } : {}), ...fields,
  };
}

/**
 * A drive shaped like:
 *   root ─┬─ Specs ── Deep ── notes.txt
 *         └─ Private ── secret.txt
 */
function tree(): Map<string, GraphDriveItem> {
  return new Map([
    item("root", undefined),
    item("SPECS", "root"),
    item("DEEP", "SPECS"),
    item("NOTES", "DEEP", { kind: "file" }),
    item("PRIVATE", "root"),
    item("SECRET", "PRIVATE", { kind: "file" }),
  ].map(entry => [entry.id, entry]));
}

function guard(scope: SharePointScope, items = tree(), drives: GraphDrive[] = []) {
  const reads: string[] = [];
  const instance = new ScopeGuard(scope, {
    item: async (ref: ItemRef) => {
      reads.push(ref.itemId);
      const found = items.get(ref.itemId);
      return found && found.driveId === ref.driveId ? found : null;
    },
    drive: async driveId => drives.find(drive => drive.id === driveId) ?? null,
  });
  return { guard: instance, reads };
}

const ref = (itemId: string, driveId = DRIVE): ItemRef => ({ driveId, itemId });
const OUTSIDE = /outside what this SharePoint connection covers, or doesn't exist/;

describe("item references", () => {
  it("round-trips a drive item, and a provisional ID stands alone", () => {
    expect(decodeItemRef(encodeItemRef(ref("01ABCDEF!12")))).toEqual(ref("01ABCDEF!12"));
    expect(encodeItemRef(ref("~3"))).toBe("~3");
    expect(decodeItemRef(" ~3 ")).toEqual({ provisional: "~3" });
  });

  it.each([
    "", "~0", "~01", "~", "01ABC", `${DRIVE}/`, `/01ABC`, `${DRIVE}/01/ABC`, `b!short/01ABC`, `${DRIVE}/01 ABC`,
    `${DRIVE}/..`, `${DRIVE}/root:/Specs`,
  ])("refuses %j with the same outside-scope wording", id => {
    expect(() => decodeItemRef(id)).toThrow(OutsideScopeError);
    expect(() => decodeItemRef(id)).toThrow(OUTSIDE);
  });
});

describe("list, page and site references", () => {
  it("round-trips, canonicalizing case", () => {
    const upper = `Contoso.SharePoint.com,${COLLECTION.toUpperCase()},${WEB}`;
    expect(decodeListRef(`${upper}/${LIST.toUpperCase()}`)).toEqual({ siteId: SITE, listId: LIST });
    expect(decodeListRef(encodeListRef({ siteId: SITE, listId: LIST }))).toEqual({ siteId: SITE, listId: LIST });
    expect(decodePageRef(encodePageRef({ siteId: SITE, pageId: PAGE }))).toEqual({ siteId: SITE, pageId: PAGE });
    expect(decodeSiteId(` ${upper} `)).toBe(SITE);
  });

  it.each([
    LIST, `${SITE}`, `${SITE}/${LIST}/extra`, `${SITE}/not-a-guid`, `contoso.sharepoint.com,${COLLECTION}/${LIST}`,
    `evil/../${LIST}`,
  ])("refuses %j as a list or page", id => {
    expect(() => decodeListRef(id)).toThrow(OutsideScopeError);
    expect(() => decodePageRef(id)).toThrow(OutsideScopeError);
  });

  it("refuses a site ID that isn't Graph's composite", () => {
    expect(() => decodeSiteId("contoso.sharepoint.com:/sites/Eng")).toThrow(OutsideScopeError);
    expect(() => decodeSiteId(`localhost,${COLLECTION},${WEB}`)).toThrow(OutsideScopeError);
  });
});

describe("requireScope", () => {
  it("refuses a scope kind this version doesn't know rather than serving it as everything", () => {
    expect(() => requireScope({ kind: "tenant" } as never)).toThrow(/newer version/);
    expect(() => new ScopeGuard({ kind: "tenant" } as never, { item: async () => null, drive: async () => null })).toThrow(/newer version/);
  });
});

describe("what each scope kind reaches", () => {
  const flags = (scope: SharePointScope) => {
    const { guard: instance } = guard(scope);
    return { files: instance.coversFiles, lists: instance.coversLists, pages: instance.coversPages, sites: instance.coversSites };
  };

  it.each<[SharePointScope, ReturnType<typeof flags>]>([
    [{ kind: "all" }, { files: true, lists: true, pages: true, sites: true }],
    [{ kind: "site", siteId: SITE }, { files: true, lists: true, pages: true, sites: true }],
    [{ kind: "library", siteId: SITE, driveId: DRIVE }, { files: true, lists: false, pages: false, sites: false }],
    [{ kind: "folder", siteId: SITE, driveId: DRIVE, itemId: "SPECS" }, { files: true, lists: false, pages: false, sites: false }],
    [{ kind: "file", siteId: SITE, driveId: DRIVE, itemId: "NOTES" }, { files: true, lists: false, pages: false, sites: false }],
    [{ kind: "list", siteId: SITE, listId: LIST }, { files: false, lists: true, pages: false, sites: false }],
    [{ kind: "page", siteId: SITE, pageId: PAGE }, { files: false, lists: false, pages: true, sites: false }],
  ])("%j", (scope, expected) => {
    expect(flags(scope)).toEqual(expected);
  });

  it("opens the bound folder or the library's root by default, and nothing for wider or narrower scopes", () => {
    expect(guard({ kind: "folder", siteId: SITE, driveId: DRIVE, itemId: "SPECS" }).guard.defaultFolder()).toEqual(ref("SPECS"));
    expect(guard({ kind: "library", siteId: SITE, driveId: DRIVE }).guard.defaultFolder()).toEqual(ref("root"));
    expect(guard({ kind: "all" }).guard.defaultFolder()).toBeNull();
    expect(guard({ kind: "file", siteId: SITE, driveId: DRIVE, itemId: "NOTES" }).guard.defaultFolder()).toBeNull();
  });
});

describe("a folder binding", () => {
  const scope: SharePointScope = { kind: "folder", siteId: SITE, driveId: DRIVE, itemId: "SPECS" };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dates a proof by the remembered proof it rests on, so reuse never renews one and a moved folder is reread within the TTL", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const items = tree();
    const { guard: instance, reads } = guard(scope, items);
    await instance.item(ref("NOTES"));
    vi.advanceTimersByTime(40_000);
    reads.length = 0;
    await instance.item(ref("NOTES"));
    expect(reads).toEqual(["NOTES"]);
    // Deep is moved out of Specs. Thirty seconds later the proof from the first read has lapsed, and the second read didn't renew it.
    items.set("DEEP", item("DEEP", "PRIVATE"));
    vi.advanceTimersByTime(30_000);
    reads.length = 0;
    await expect(instance.item(ref("NOTES"))).rejects.toThrow(OUTSIDE);
    expect(reads).toEqual(["NOTES", "DEEP", "PRIVATE", "root"]);
  });

  it("dates a listed subfolder by its parent's proof", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const items = tree();
    items.set("DEEPER", item("DEEPER", "DEEP"));
    const { guard: instance, reads } = guard(scope, items);
    await instance.item(ref("DEEP"));
    vi.advanceTimersByTime(50_000);
    expect(instance.childOf(items.get("DEEPER")!, ref("DEEP"))).toBe(true);
    vi.advanceTimersByTime(20_000);
    reads.length = 0;
    // Deeper's proof rested on Deep's, which has lapsed: its ancestry is walked again.
    await instance.item(ref("DEEPER"));
    expect(reads).toEqual(["DEEPER", "DEEP"]);
  });

  it("admits the folder and anything beneath it", async () => {
    const { guard: instance } = guard(scope);
    expect((await instance.item(ref("SPECS"))).id).toBe("SPECS");
    expect((await instance.item(ref("NOTES"))).id).toBe("NOTES");
  });

  it("refuses its parent, a sibling folder and what's inside the sibling", async () => {
    const { guard: instance } = guard(scope);
    await expect(instance.item(ref("root"))).rejects.toThrow(OutsideScopeError);
    await expect(instance.item(ref("PRIVATE"))).rejects.toThrow(OutsideScopeError);
    await expect(instance.item(ref("SECRET"))).rejects.toThrow(OutsideScopeError);
  });

  it("refuses another drive before asking Graph anything", async () => {
    const { guard: instance, reads } = guard(scope);
    await expect(instance.item(ref("NOTES", OTHER_DRIVE))).rejects.toThrow(OutsideScopeError);
    expect(reads).toEqual([]);
  });

  it("refuses an item Graph answers for under a different ID or drive", async () => {
    const items = tree();
    items.set("ALIAS", { ...items.get("NOTES")!, id: "NOTES" });
    const { guard: instance } = guard(scope, items);
    await expect(instance.item(ref("ALIAS"))).rejects.toThrow(OutsideScopeError);
  });

  it("remembers proven folders, so a second read stops at the first one", async () => {
    const { guard: instance, reads } = guard(scope);
    await instance.item(ref("NOTES"));
    // The bound folder itself is known by ID and never read.
    expect(reads).toEqual(["NOTES", "DEEP"]);
    reads.length = 0;
    await instance.item(ref("NOTES"));
    expect(reads).toEqual(["NOTES"]);
  });

  it("remembers folders proven outside, so a page of hits from one outside subtree costs its depth once", async () => {
    const items = tree();
    for (let n = 0; n < 5; n++) items.set(`LEAK${n}`, item(`LEAK${n}`, "PRIVATE", { kind: "file" }));
    const { guard: instance, reads } = guard(scope, items);
    expect(await instance.contains(items.get("SECRET")!)).toBe(false);
    expect(reads).toEqual(["PRIVATE", "root"]);
    reads.length = 0;
    for (let n = 0; n < 5; n++) expect(await instance.contains(items.get(`LEAK${n}`)!)).toBe(false);
    expect(reads).toEqual([]);
  });

  it("gives up on an ancestry deeper than any real one", async () => {
    const items = new Map<string, GraphDriveItem>([["root", item("root", undefined)], ["SPECS", item("SPECS", "root")]]);
    // A chain longer than the walk's limit that never reaches the bound folder.
    for (let depth = 0; depth < 100; depth++) items.set(`LOOP${depth}`, item(`LOOP${depth}`, `LOOP${depth + 1}`));
    items.set("LEAF", item("LEAF", "LOOP0", { kind: "file" }));
    const { guard: instance, reads } = guard(scope, items);
    await expect(instance.item(ref("LEAF"))).rejects.toThrow(OutsideScopeError);
    expect(reads.length).toBeLessThanOrEqual(66);
  });

  it("answers a cycle in Graph's parents as outside rather than looping", async () => {
    const items = tree();
    items.set("A", item("A", "B"));
    items.set("B", item("B", "A"));
    const { guard: instance } = guard(scope, items);
    await expect(instance.item(ref("A"))).rejects.toThrow(OutsideScopeError);
  });

  it("treats a malformed ID Graph rejects as missing, but lets other Graph failures through", async () => {
    const rejecting = (status: number) => new ScopeGuard(scope, {
      item: async () => { throw new GraphApiError(status, "nope"); },
      drive: async () => null,
    });
    await expect(rejecting(400).item(ref("X"))).rejects.toThrow(OutsideScopeError);
    await expect(rejecting(503).item(ref("X"))).rejects.toThrow(GraphApiError);
  });

  it("keeps only search hits beneath the folder", async () => {
    const { guard: instance } = guard(scope);
    const items = tree();
    expect(await instance.contains(items.get("NOTES")!)).toBe(true);
    expect(await instance.contains(items.get("SECRET")!)).toBe(false);
    expect(await instance.contains({ ...items.get("NOTES")!, driveId: OTHER_DRIVE })).toBe(false);
  });

  it("admits a listed child of a proven folder without an ancestry walk", () => {
    const { guard: instance, reads } = guard(scope);
    const items = tree();
    expect(instance.childOf(items.get("DEEP")!, ref("SPECS"))).toBe(true);
    expect(instance.childOf(items.get("DEEP")!, ref("PRIVATE"))).toBe(false);
    expect(instance.childOf({ ...items.get("DEEP")!, driveId: OTHER_DRIVE }, ref("SPECS"))).toBe(false);
    expect(reads).toEqual([]);
  });
});

describe("a site binding", () => {
  const scope: SharePointScope = { kind: "site", siteId: SITE };

  it("admits a listed child only when Graph places it in the site", () => {
    const { guard: instance, reads } = guard(scope);
    const items = tree();
    expect(instance.childOf(items.get("DEEP")!, ref("SPECS"))).toBe(true);
    expect(instance.childOf({ ...items.get("DEEP")!, siteCollectionId: OTHER_COLLECTION }, ref("SPECS"))).toBe(false);
    const { siteCollectionId: _, webId: __, ...unplaced } = items.get("DEEP")!;
    expect(instance.childOf(unplaced, ref("SPECS"))).toBe(false);
    expect(reads).toEqual([]);
  });

  it("reaches only its own site, not other sites or subsites", () => {
    const { guard: instance } = guard(scope);
    expect(() => instance.site(SITE)).not.toThrow();
    expect(() => instance.site(`contoso.sharepoint.com,${COLLECTION},${OTHER_COLLECTION}`)).toThrow(OutsideScopeError);
  });

  it("compares the site collection and the web together: a shared web ID isn't the same site", async () => {
    const items = tree();
    items.set("ELSEWHERE", item("ELSEWHERE", "root", { kind: "file", siteCollectionId: OTHER_COLLECTION, webId: WEB }));
    const { guard: instance } = guard(scope, items);
    expect((await instance.item(ref("NOTES"))).id).toBe("NOTES");
    await expect(instance.item(ref("ELSEWHERE"))).rejects.toThrow(OutsideScopeError);
    expect(await instance.contains(items.get("ELSEWHERE")!)).toBe(false);
  });

  it("reaches its own libraries and lists and pages, and no one else's", async () => {
    const own: GraphDrive = { id: DRIVE, name: "Documents", webUrl: "", driveType: "documentLibrary", siteCollectionId: COLLECTION, webId: WEB };
    const foreign: GraphDrive = { ...own, id: OTHER_DRIVE, siteCollectionId: OTHER_COLLECTION };
    const { guard: instance } = guard(scope, tree(), [own, foreign]);
    expect((await instance.drive(DRIVE)).id).toBe(DRIVE);
    await expect(instance.drive(OTHER_DRIVE)).rejects.toThrow(OUTSIDE);
    await expect(instance.drive("b!MISSINGMISSINGMISSINGMISSING")).rejects.toThrow(OutsideScopeError);

    expect(() => instance.list({ siteId: SITE, listId: LIST })).not.toThrow();
    expect(() => instance.list({ siteId: `contoso.sharepoint.com,${OTHER_COLLECTION},${WEB}`, listId: LIST })).toThrow(OUTSIDE);
    expect(() => instance.page({ siteId: SITE, pageId: PAGE })).not.toThrow();
  });
});

describe("narrow bindings", () => {
  it("a library reaches its own drive only", async () => {
    const drive: GraphDrive = { id: DRIVE, name: "Documents", webUrl: "", driveType: "documentLibrary" };
    const { guard: instance } = guard({ kind: "library", siteId: SITE, driveId: DRIVE }, tree(), [drive]);
    expect((await instance.item(ref("SECRET"))).id).toBe("SECRET");
    await expect(instance.drive(OTHER_DRIVE)).rejects.toThrow(OutsideScopeError);
    expect(() => instance.site(SITE)).toThrow(OUTSIDE);
  });

  it("a file reaches only itself, refusing its siblings without asking Graph", async () => {
    const { guard: instance, reads } = guard({ kind: "file", siteId: SITE, driveId: DRIVE, itemId: "NOTES" });
    expect((await instance.item(ref("NOTES"))).id).toBe("NOTES");
    reads.length = 0;
    await expect(instance.item(ref("DEEP"))).rejects.toThrow(OutsideScopeError);
    expect(reads).toEqual([]);
    expect(instance.childOf(tree().get("NOTES")!, ref("DEEP"))).toBe(false);
    await expect(instance.drive(DRIVE)).rejects.toThrow(OutsideScopeError);
  });

  it("a list reaches that list only, and no files", async () => {
    const { guard: instance, reads } = guard({ kind: "list", siteId: SITE, listId: LIST });
    expect(() => instance.list({ siteId: SITE, listId: LIST })).not.toThrow();
    expect(() => instance.list({ siteId: SITE, listId: PAGE })).toThrow(OutsideScopeError);
    expect(() => instance.page({ siteId: SITE, pageId: PAGE })).toThrow(OutsideScopeError);
    await expect(instance.item(ref("NOTES"))).rejects.toThrow(OutsideScopeError);
    expect(reads).toEqual([]);
  });

  it("a page reaches that page only", () => {
    const { guard: instance } = guard({ kind: "page", siteId: SITE, pageId: PAGE });
    expect(() => instance.page({ siteId: SITE, pageId: PAGE })).not.toThrow();
    expect(() => instance.page({ siteId: SITE, pageId: LIST })).toThrow(OUTSIDE);
    expect(() => instance.list({ siteId: SITE, listId: LIST })).toThrow(OutsideScopeError);
  });
});

describe("OutsideScopeError", () => {
  it("says one thing, whatever kind of object was asked for and whether it exists", () => {
    expect(new OutsideScopeError().message).toBe("That is outside what this SharePoint connection covers, or doesn't exist.");
    const { guard: instance } = guard({ kind: "list", siteId: SITE, listId: LIST });
    const refusals = [
      () => instance.site(SITE), () => instance.page({ siteId: SITE, pageId: PAGE }), () => decodeItemRef("nonsense"), () => decodeListRef("nonsense"),
    ].map(refuse => {
      try {
        refuse();
      } catch (error) {
        return (error as Error).message;
      }
      return "no refusal";
    });
    expect(new Set(refusals)).toEqual(new Set([new OutsideScopeError().message]));
  });
});
