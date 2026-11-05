// The per-binding gatekeeper against a fake Graph, reached through TestHooks facets as the overseer
// reaches it: the binding pinned to its Entra user, its description and type at each access level,
// the folder boundary, the access units each read names for observers, and rejections that strand
// a temporary ID.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharePointBrowserPage } from "../../src/configurator/sharepoint-configurator-types";
import type { DriveEntry, ResolvedLink, SharePointScopeInfo } from "../../src/types";
import {
  BRIEF, DEEP, DRIVE, EMPTY, FakeGraph, GRAPH, NOTES, OTHER, OTHER_FILE, PHILLIP, READ_SCOPES, ROOT, SARAH, SITE_ID, SPECS,
  accountStub, facet, failure, folderProps, hooks, identityOf, json, props, ref, seedAccount, unwrap,
} from "./fake-graph";
import type { GatekeeperProps, Outcome, Step } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OUTSIDE = /is outside what this SharePoint connection covers, or doesn.t exist\./;

type Submitted = { actionId: number; description: { title: string } };

async function walk<T>(name: string, binding: GatekeeperProps, steps: Step[]): Promise<T[]> {
  return unwrap<T[][]>(await hooks().run(name, binding, steps, { pages: 10 })).flat();
}

describe("the binding", () => {
  it("pins the Entra user it was first used as, and refuses once the connection names another", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("pin");
    unwrap(await hooks().run(name, binding, [["getScope"]]));

    await runInDurableObject(accountStub(id), async (_instance, state) => {
      state.storage.kv.put("identity", identityOf(SARAH));
    });
    hooks().restart(name);
    expect(failure(await hooks().run(name, binding, [["getScope"]])))
      .toMatch(/made for a different Microsoft 365 account than its connection now uses/);
    expect(failure(await hooks().applyAction(name, binding, 1))).toMatch(/different Microsoft 365 account/);
  });

  it("describes a folder binding by its place in the site", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().describe(facet("describe"), folderProps(id)))).toEqual({
      url: "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Specs",
      title: "Specs",
      snippet: "Engineering › Documents › Specs",
      suggestedBindingName: "SHAREPOINT_FOLDER",
      tsType: "SharePointFolderSession",
    });
  });

  it("describes everything by the account it reads as", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().describe(facet("describe-all"), props(id, { kind: "all" })))).toMatchObject({
      title: "SharePoint & OneDrive", snippet: PHILLIP.upn, suggestedBindingName: "SHAREPOINT",
    });
  });

  it("still describes a binding whose folder is gone, so it can be removed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(unwrap(await hooks().describe(facet("gone"), folderProps(id, "01GONE00000000000000000000000000")))).toEqual({
      url: "",
      title: "Unavailable SharePoint item",
      snippet: "The folder this connection is for no longer exists, or you can no longer open it.",
      suggestedBindingName: "SHAREPOINT_FOLDER",
      tsType: "SharePointFolderSession",
    });
  });

  it("keeps the last description it read when the folder later goes", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const name = facet("gone-later");
    unwrap(await hooks().describe(name, folderProps(id)));
    graph.items.delete(SPECS);
    hooks().restart(name);
    expect(unwrap(await hooks().describe(name, folderProps(id)))).toMatchObject({ title: "Specs" });
  });
});

describe("read-only access", () => {
  it("follows a grant without write permissions: a reader, with nothing to approve", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { scopes: READ_SCOPES });
    const binding = folderProps(id);
    const name = facet("read-only");
    expect(unwrap(await hooks().describe(name, binding))).toMatchObject({ tsType: "SharePointFolderReader" });
    expect(unwrap<SharePointScopeInfo>(await hooks().run(name, binding, [["getScope"]])))
      .toMatchObject({ kind: "folder", can: { files: true, write: false } });
    // The session simply has no write methods.
    expect(failure(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Drafts"]]))).toBeTruthy();
    expect((await hooks().queueLog(name)).submitted).toEqual([]);
    expect(unwrap(await hooks().autoApprovable(name, binding))).toEqual([]);
  });

  it("binds what's shared with the user to view read-only, though the grant could write", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    graph.items.get(SPECS)!.shared = { effectiveRoles: ["read"], scope: "users" };
    const binding = folderProps(id);
    const name = facet("shared-to-view");
    expect(unwrap(await hooks().describe(name, binding))).toMatchObject({ tsType: "SharePointFolderReader" });
    expect(unwrap<SharePointScopeInfo>(await hooks().run(name, binding, [["getScope"]]))).toMatchObject({ can: { write: false } });
    expect(unwrap(await hooks().autoApprovable(name, binding))).toEqual([]);
  });

  it("keeps write where the user's role allows it, or Graph doesn't say", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    graph.items.get(SPECS)!.shared = { effectiveRoles: ["write"], scope: "users" };
    expect(unwrap(await hooks().describe(facet("shared-to-edit"), folderProps(id)))).toMatchObject({ tsType: "SharePointFolderSession" });
    graph.items.get(SPECS)!.shared = { scope: "users" };
    expect(unwrap(await hooks().describe(facet("shared-unsaid"), folderProps(id)))).toMatchObject({ tsType: "SharePointFolderSession" });
  });

  it("refuses a binding whose connection no longer grants SharePoint", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph, PHILLIP, { scopes: ["https://graph.microsoft.com/User.Read"] });
    expect(failure(await hooks().run(facet("no-sharepoint"), folderProps(id), [["getScope"]])))
      .toMatch(/no longer grants SharePoint access/);
  });

  it("offers for automatic approval only what each scope can submit, and never a delete", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const files = ["sharepoint.files.create", "sharepoint.files.edit", "sharepoint.files.organize"];
    const cases: Array<[GatekeeperProps["scope"], string[]]> = [
      [{ kind: "all" }, [...files, "sharepoint.lists.edit"]],
      [{ kind: "site", siteId: SITE_ID }, [...files, "sharepoint.lists.edit"]],
      [{ kind: "library", siteId: SITE_ID, driveId: DRIVE }, files],
      [{ kind: "folder", siteId: SITE_ID, driveId: DRIVE, itemId: SPECS }, files],
      // The file is the binding's top: it can be replaced, not renamed or moved.
      [{ kind: "file", siteId: SITE_ID, driveId: DRIVE, itemId: NOTES }, ["sharepoint.files.edit"]],
      [{ kind: "list", siteId: SITE_ID, listId: "11111111-2222-3333-4444-555555555555" }, ["sharepoint.lists.edit"]],
      [{ kind: "page", siteId: SITE_ID, pageId: "11111111-2222-3333-4444-555555555555" }, []],
    ];
    for (const [scope, tags] of cases) {
      const kinds = unwrap<Array<{ tag: string }>>(await hooks().autoApprovable(facet(`auto-${scope.kind}`), props(id, scope)));
      expect(kinds.map(kind => kind.tag).toSorted(), scope.kind).toEqual(tags.toSorted());
    }
  });
});

describe("a folder binding", () => {
  it("lists from the folder, with paths measured from it", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("folder-list");
    expect((await walk<DriveEntry>(name, binding, [["list"]])).map(entry => entry.path).toSorted())
      .toEqual(["Deep", "Empty", "brief.docx"]);
    expect((await walk<DriveEntry>(name, binding, [["list", { folderId: ref(DEEP) }]])).map(entry => entry.path))
      .toEqual(["Deep/notes.txt"]);
  });

  it("refuses everything whose ancestry leaves the folder, with one refusal for missing and outside alike", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("folder-outside");
    expect(failure(await hooks().run(name, binding, [["getEntry", ref(OTHER_FILE)]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["list", { folderId: ref(OTHER) }]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["list", { folderId: `${DRIVE}/root` }]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["getEntry", ref(ROOT)]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["getEntry", ref("01NOSUCHITEM00000000000000000000")]]))).toMatch(OUTSIDE);
    expect(failure(await hooks().run(name, binding, [["getEntry", "b!AnotherLibraryEntirely0001/01X"]]))).toMatch(OUTSIDE);
    // Nothing outside was revealed, so nothing was observed.
    expect((await hooks().queueLog(name)).observations).toEqual([]);
  });

  it("refuses to change the folder it is for", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    expect(failure(await hooks().run(facet("folder-top"), folderProps(id), [["rename", ref(SPECS), "Renamed"]])))
      .toMatch(/top of what this connection covers/);
  });
});

describe("observations", () => {
  it("name the folder and every child a listing revealed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const binding = folderProps(id);
    const name = facet("units-listing");
    await walk(name, binding, [["list"]]);
    const [observation] = (await hooks().queueLog(name)).observations;
    expect(observation).toMatchObject({ title: "Listed a SharePoint folder" });
    expect(observation.description).toContain("brief\\.docx");

    unwrap(await hooks().addObserver(name, binding, "sarah", sarah));
    expect(graph.probedItems(SARAH).toSorted()).toEqual([SPECS, DEEP, EMPTY, BRIEF].toSorted());
  });

  it("refuse a collaborator who can't open one of the children", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    graph.hide(SARAH, BRIEF);
    const binding = folderProps(id);
    const name = facet("units-hidden");
    await walk(name, binding, [["list"]]);
    expect(failure(await hooks().addObserver(name, binding, "sarah", sarah)))
      .toMatch(/can't open something in SharePoint that this workspace has read/);
  });

  it("authorize an empty listing against the folder itself", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    const binding = folderProps(id);
    const name = facet("units-empty");
    expect(await walk(name, binding, [["list", { folderId: ref(EMPTY) }]])).toEqual([]);
    const [observation] = (await hooks().queueLog(name)).observations;
    expect(observation.description).toMatch(/Listed the folder Empty; it holds nothing more\./);
    unwrap(await hooks().addObserver(name, binding, "sarah", sarah));
    expect(graph.probedItems(SARAH)).toEqual([EMPTY]);
  });

  it("leave an admitted collaborator out of a later read they can't open", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const sarah = await seedAccount(graph, SARAH);
    graph.hide(SARAH, NOTES);
    const binding = folderProps(id);
    const name = facet("units-exclude");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    unwrap(await hooks().addObserver(name, binding, "sarah", sarah));
    unwrap(await hooks().run(name, binding, [["getEntry", ref(NOTES)]]));
    const log = (await hooks().queueLog(name));
    expect(log.observations.at(-1)).toMatchObject({ title: "Read SharePoint file details", excludeObservers: ["sarah"] });
  });

  it("refuse a collaborator from another organization outright", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const outsider = await seedAccount(graph, { ...SARAH, tid: "22222222-2222-2222-2222-222222222222" });
    const binding = folderProps(id);
    const name = facet("units-tenant");
    unwrap(await hooks().run(name, binding, [["getScope"]]));
    expect(failure(await hooks().addObserver(name, binding, "outsider", outsider))).toMatch(/different organization/);
  });
});

describe("links", () => {
  /** Answers `/shares/{u!…}/driveItem` with the seeded item at that URL, and every other resolution facet with a miss. */
  function shares(graph: FakeGraph): FakeGraph {
    const missing = () => json({ error: { code: "itemNotFound", message: "The resource could not be found." } }, { status: 404 });
    graph.on("GET", /^\/v1\.0\/sites\/contoso\.sharepoint\.com:/, missing);
    graph.on("GET", /^\/v1\.0\/shares\//, request => {
      const [, shareId, facet] = /^\/v1\.0\/shares\/u!([^/]+)\/(\w+)/.exec(request.url.pathname) ?? [];
      const url = atob(shareId!.replace(/-/g, "+").replace(/_/g, "/"));
      const item = [...graph.items.values()].find(candidate => candidate.webUrl === url);
      if (facet !== "driveItem" || item === undefined) return missing();
      const { parentId: _parentId, ...wire } = item;
      return json(wire);
    });
    return graph;
  }

  it("resolves a link the binding covers", async () => {
    const graph = shares(new FakeGraph().install());
    const id = await seedAccount(graph);
    const link = unwrap<ResolvedLink>(await hooks().run(facet("link"), folderProps(id),
      [["resolveUrl", `https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Specs/Deep/notes.txt`]]));
    expect(link).toMatchObject({ kind: "file", id: ref(NOTES), name: "notes.txt" });
  });

  it("resolves a library link to its root folder, which list() and getEntry() take", async () => {
    const graph = shares(new FakeGraph().install());
    const id = await seedAccount(graph);
    const binding = props(id, { kind: "library", siteId: SITE_ID, driveId: DRIVE });
    const name = facet("link-library");
    const link = unwrap<ResolvedLink>(await hooks().run(name, binding,
      [["resolveUrl", "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents"]]));
    expect(link).toMatchObject({ kind: "library", id: `${DRIVE}/root` });
    expect((await walk<DriveEntry>(name, binding, [["list", { folderId: link.id }]])).map(entry => entry.name).toSorted()).toEqual(["Other", "Specs"]);
    expect(unwrap<DriveEntry>(await hooks().run(name, binding, [["getEntry", link.id!]]))).toMatchObject({ kind: "folder", path: "" });
  });

  it("refuses a link the owner can open but the binding doesn't cover exactly as one that leads nowhere, observing nothing", async () => {
    const graph = shares(new FakeGraph().install());
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("link-oracle");
    const outside = failure(await hooks().run(name, binding,
      [["resolveUrl", `https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Other/other.txt`]]));
    const nowhere = failure(await hooks().run(name, binding,
      [["resolveUrl", `https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Nope/missing.txt`]]));
    expect(outside).toMatch(OUTSIDE);
    expect(nowhere).toBe(outside);
    // A OneDrive link can't be in a site's binding, so Graph isn't asked.
    const asked = graph.count("GET", /\/shares\//);
    expect(failure(await hooks().run(name, binding, [["resolveUrl", "https://contoso-my.sharepoint.com/personal/phillip/Documents/a.txt"]]))).toBe(outside);
    expect(graph.count("GET", /\/shares\//)).toBe(asked);
    // What is wrong with a link that isn't SharePoint's at all is said before Graph is asked.
    expect(failure(await hooks().run(name, binding, [["resolveUrl", "https://example.com/a.txt"]]))).toMatch(/isn't a SharePoint or OneDrive link/);
    expect((await hooks().queueLog(name)).observations).toEqual([]);
  });

  it("refuses a file link Graph can't resolve rather than widening it to the site it is in", async () => {
    // `shares` misses everything but seeded files; the site itself answers by path, as for a link to it.
    const graph = shares(new FakeGraph().install());
    graph.on("GET", /^\/v1\.0\/sites\/contoso\.sharepoint\.com:\/sites\/Engineering(\?|$)/, () =>
      json({ id: SITE_ID, name: "Engineering", displayName: "Engineering", webUrl: "https://contoso.sharepoint.com/sites/Engineering" }));
    const id = await seedAccount(graph);
    const binding = props(id, { kind: "all" });
    const name = facet("link-widening");
    expect(unwrap<ResolvedLink>(await hooks().run(name, binding, [["resolveUrl", "https://contoso.sharepoint.com/sites/Engineering"]])))
      .toMatchObject({ kind: "site", name: "Engineering" });
    const asked = graph.count("GET", /\/sites\/contoso\.sharepoint\.com:/);
    // An "all" binding says why, since it covers whatever the owner can open; the site isn't even asked for.
    expect(failure(await hooks().run(name, binding,
      [["resolveUrl", "https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Specs/deleted.docx"]]))).toMatch(/doesn't lead to anything/);
    expect(graph.count("GET", /\/sites\/contoso\.sharepoint\.com:/)).toBe(asked);
  });
});

describe("the configurator", () => {
  it("returns the OneDrive tab's next page of a search, not its first page again", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/me\/drive(\?|$)/, () => json({
      id: DRIVE, name: "OneDrive", driveType: "business", webUrl: "https://contoso-my.sharepoint.com/personal/phillip_contoso_com/Documents",
    }));
    const wire = (itemId: string) => {
      const { parentId: _parentId, ...rest } = graph.items.get(itemId)!;
      return rest;
    };
    graph.on("GET", /\/root\/search\(q=/, request => request.url.searchParams.has("$skiptoken")
      ? json({ value: [wire(BRIEF)] })
      : json({ value: [wire(NOTES)], "@odata.nextLink": `${GRAPH}/v1.0/drives/${DRIVE}/root/search(q='plan')?$skiptoken=page2` }));
    const id = await seedAccount(graph);
    const first = unwrap<SharePointBrowserPage>(await hooks().configurator(id, "write", "loadItems", { tab: "onedrive", query: "plan" }));
    expect(first.items.map(item => item.title)).toEqual(["notes.txt"]);
    expect(first.nextPageToken).toContain("$skiptoken=page2");
    const second = unwrap<SharePointBrowserPage>(await hooks().configurator(id, "write", "loadItems",
      { tab: "onedrive", query: "plan", pageToken: first.nextPageToken }));
    expect(second.items.map(item => item.title)).toEqual(["brief.docx"]);
    expect(graph.count("GET", /skiptoken=page2/)).toBe(1);
  });
});

describe("changes", () => {
  it("refuses a second change to a file's content while one awaits approval", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /\/content$/, () => new Response("old text\n", { headers: { "content-type": "text/plain" } }));
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("second-change");
    expect(unwrap<DriveEntry>(await hooks().run(name, binding, [["replaceFile", ref(NOTES), "new text\n"]]))).toMatchObject({ pending: "replace" });
    expect(failure(await hooks().run(name, binding, [["replaceFile", ref(NOTES), "newer text\n"]]))).toMatch(/already awaiting approval/);
    expect((await hooks().queueLog(name)).submitted).toHaveLength(1);
  });

  it("takes ifUnchanged only as a version tag a read returned", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("fence-grammar");
    for (const bad of ["*", `"{x},1"\r\nX-Injected: 1`, "", "{x},1"]) {
      expect(failure(await hooks().run(name, binding, [["rename", ref(NOTES), "renamed.txt", { ifUnchanged: bad }]]))).toMatch(/ifUnchanged takes the eTag or cTag/);
    }
    expect((await hooks().queueLog(name)).submitted).toEqual([]);
    // A file's bytes are checked on upload as what its name says; a rename can't make them an Office file unchecked.
    expect(failure(await hooks().run(name, binding, [["rename", ref(NOTES), "notes.xlsx"]]))).toMatch(/upload it under that name/);
    expect(failure(await hooks().run(name, binding, [["rename", ref(NOTES), "notes.docm"]]))).toMatch(/upload it under that name/);
    expect((await hooks().queueLog(name)).submitted).toEqual([]);
    unwrap(await hooks().run(name, binding, [["rename", ref(NOTES), "renamed.txt", { ifUnchanged: `W/"{${NOTES}},1"` }]]));
    expect((await hooks().queueLog(name)).submitted).toHaveLength(1);
    // What the rename returns describes the file, so observers must be able to open it.
    expect((await hooks().queueLog(name)).observations.map(observation => observation.title)).toContain("Read SharePoint file details");
  });

  it("leaves an approved change waiting once the connection can no longer write", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("write-withdrawn");
    unwrap(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Drafts"]]));
    const [{ actionId }] = (await hooks().queueLog(name)).submitted as Submitted[];
    await runInDurableObject(accountStub(id), async (_instance, state) => {
      const credentials = state.storage.kv.get<Record<string, unknown>>("credentials")!;
      state.storage.kv.put("credentials", { ...credentials, scopes: READ_SCOPES });
    });
    expect(failure(await hooks().applyAction(name, binding, actionId))).toMatch(/no longer allows changes to SharePoint/);
    expect(graph.count("POST", /\/children/)).toBe(0);
    // Still pending, not failed: it is applied once write access returns.
    expect(await walk<DriveEntry>(name, binding, [["list"]])).toContainEqual(expect.objectContaining({ name: "Drafts", pending: "create" }));
  });

  it("leaves an undo waiting too once the connection can no longer write, since an undo writes as well", async () => {
    const graph = new FakeGraph().install();
    const created = "01DRAFTS000000000000000000000000";
    graph.on("POST", /\/children(\?|$)/, () => json({
      id: created, name: "Drafts", folder: { childCount: 0 }, parentReference: { driveId: DRIVE, id: SPECS },
      eTag: `"{${created}},1"`, cTag: `"c:{${created}},1"`, webUrl: "https://contoso.sharepoint.com/sites/Engineering/Specs/Drafts",
    }, { status: 201 }));
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("undo-withdrawn");
    unwrap(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Drafts"]]));
    const [{ actionId }] = (await hooks().queueLog(name)).submitted as Submitted[];
    unwrap(await hooks().applyAction(name, binding, actionId));
    expect(graph.count("POST", /\/children/)).toBe(1);
    await runInDurableObject(accountStub(id), async (_instance, state) => {
      const credentials = state.storage.kv.get<Record<string, unknown>>("credentials")!;
      state.storage.kv.put("credentials", { ...credentials, scopes: READ_SCOPES });
    });
    expect(unwrap(await hooks().revertAction(name, binding, actionId))).toMatchObject({ message: expect.stringMatching(/no longer allows changes to SharePoint/), canRetry: true });
    expect(graph.count("DELETE", /items\//)).toBe(0);
  });
});

describe("preparing writes", () => {
  it("prepares writes one at a time, so a second of two concurrent proposals sees the first", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("together");
    const outcomes = await hooks().runTogether(name, binding, [
      ["createFolder", ref(SPECS), "Drafts"], ["createFolder", ref(SPECS), "drafts"], ["uploadFile", ref(SPECS), "Drafts", "x"],
    ]) as unknown as Outcome<unknown>[];
    expect(outcomes.filter(outcome => "ok" in outcome)).toHaveLength(1);
    expect(outcomes.filter(outcome => "error" in outcome).map(failure)).toEqual([
      expect.stringMatching(/already awaiting approval/), expect.stringMatching(/already awaiting approval/),
    ]);
    expect((await hooks().queueLog(name)).submitted).toHaveLength(1);
  });
});

describe("reading a workbook range", () => {
  it("refuses a range without its sheet, or larger than the cell budget, before reading anything", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("range");
    expect(failure(await hooks().run(name, binding, [["readWorkbook", ref(NOTES), { range: "A1:B2" }]]))).toMatch(/Pass sheet with range/);
    expect(failure(await hooks().run(name, binding, [["readWorkbook", ref(NOTES), { sheet: "Budget", range: "A1:Z100", maxCells: 100 }]])))
      .toMatch(/more than maxCells \(100\)/);
    expect(failure(await hooks().run(name, binding, [["readWorkbook", ref(NOTES), { sheet: "Budget", range: "Budget!A1" }]])))
      .toMatch(/Pass the worksheet separately/);
    expect(graph.count("GET", /\/workbook\//)).toBe(0);
  });
});

describe("listing sites", () => {
  it("puts the user's own OneDrive first, as a personal site", async () => {
    const graph = new FakeGraph().install();
    graph.on("GET", /^\/v1\.0\/me\/drive(\?|$)/, () => json({
      id: "b!PhillipOneDrive0000000000000000", name: "OneDrive", driveType: "business",
      webUrl: "https://contoso-my.sharepoint.com/personal/phillip_contoso_com/Documents",
    }));
    graph.on("GET", /^\/v1\.0\/sites\/contoso-my\.sharepoint\.com:\/personal\/phillip_contoso_com(\?|$)/, () => json({
      id: "contoso-my.sharepoint.com,dddddddd-0000-0000-0000-000000000000,eeeeeeee-0000-0000-0000-000000000000",
      displayName: "Phillip Jones", webUrl: "https://contoso-my.sharepoint.com/personal/phillip_contoso_com", isPersonalSite: true,
    }));
    const id = await seedAccount(graph);
    const binding = props(id, { kind: "all" });
    const [sites] = unwrap<{ name: string; personal: boolean }[][]>(await hooks().run(facet("sites"), binding, [["listSites"]], { pages: 1 }));
    expect(sites![0]).toMatchObject({ name: "Phillip Jones", personal: true });
    expect(sites!.slice(1).map(site => site.name)).toEqual(["Communication site"]);
  });
});

describe("rejecting", () => {
  it("restarts the gadget when a rejected folder is one a pending upload builds on", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const binding = folderProps(id);
    const name = facet("reject");
    const folder = unwrap<DriveEntry>(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Drafts"]]));
    expect(folder).toMatchObject({ id: expect.stringMatching(/^~/), path: "Drafts", pending: "create" });
    unwrap(await hooks().run(name, binding, [["uploadFile", folder.id, "plan.md", "# Plan\n"]]));
    unwrap(await hooks().run(name, binding, [["createFolder", ref(SPECS), "Unrelated"]]));
    const [create, , unrelated] = (await hooks().queueLog(name)).submitted as Submitted[];
    expect(create.description.title).toContain("Drafts");

    expect(unwrap(await hooks().rejectAction(name, binding, unrelated.actionId))).toBeUndefined();
    expect(unwrap(await hooks().rejectAction(name, binding, create.actionId))).toEqual({ restart: true });
    // The upload built on the rejected folder went with it.
    expect(await walk<DriveEntry>(name, binding, [["list"]])).not.toContainEqual(expect.objectContaining({ name: "Drafts" }));
  });

  it("refuses a name already taken in the folder, before anything is proposed", async () => {
    const graph = new FakeGraph().install();
    const id = await seedAccount(graph);
    const name = facet("taken");
    expect(failure(await hooks().run(name, folderProps(id), [["createFolder", ref(SPECS), "Deep"]])))
      .toMatch(/already has something named "Deep"/);
    expect((await hooks().queueLog(name)).submitted).toEqual([]);
  });
});
