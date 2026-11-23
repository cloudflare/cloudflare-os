// Reads against the live tenant: every scope kind, what each reveals, and what each refuses.

import { describe, expect, it } from "vitest";
import type { DriveEntry, FileContent, ListItem, SharePointScopeInfo, SiteContents, WorkbookContent } from "../../src/types";
import { bind, failure, facet, hooks, live, oneDrive, origin, run, unwrap, walk } from "./tenant";

const OUTSIDE = /is outside what this SharePoint connection covers, or doesn.t exist\./;

describe.skipIf(!live)("reads, bound to everything", () => {
  it("describes and scopes the binding", async () => {
    const props = await bind("phillip", `${await origin()}/_layouts/15/sharepoint.aspx`);
    expect(props.scope).toEqual({ kind: "all" });
    const name = facet("all");
    const description = unwrap<{ title: string; suggestedBindingName: string; tsType: string }>(await hooks().describe(name, props));
    expect(description).toMatchObject({ title: "SharePoint & OneDrive", suggestedBindingName: "SHAREPOINT", tsType: "SharePointSession" });
    const scope = unwrap<SharePointScopeInfo>(await run(name, props, [["getScope"]]));
    expect(scope).toMatchObject({ kind: "all", can: { sites: true, files: true, lists: true, pages: true, write: true } });
  });

  it("reads a site's contents, a library, and a nested folder with paths from the library root", async () => {
    const props = await bind("phillip", `${await origin()}/_layouts/15/sharepoint.aspx`);
    const name = facet("all-browse");
    const site = unwrap<SiteContents>(await run(name, props, [["resolveUrl", `${await origin()}/sites/Engineering`]]));
    const contents = unwrap<SiteContents>(await run(name, props, [["getSite", (site as unknown as { id: string }).id]]));
    expect(contents.name).toBe("Engineering");
    expect(contents.libraries.map(library => library.name)).toContain("Documents");
    expect(contents.lists.map(list => list.name)).toContain("Issue Tracker");
    // Libraries and hidden lists aren't lists.
    expect(contents.lists.map(list => list.name)).not.toContain("Documents");
    expect(contents.lists.map(list => list.name)).not.toContain("Web Template Extensions");

    const library = contents.libraries.find(candidate => candidate.name === "Documents")!;
    const top = await walk<DriveEntry>(name, props, [["list", { folderId: library.rootFolderId }]]);
    const specs = top.find(entry => entry.name === "Specs")!;
    expect(specs).toMatchObject({ kind: "folder", path: "Specs" });
    const inside = await walk<DriveEntry>(name, props, [["list", { folderId: specs.id }]]);
    expect(inside.map(entry => entry.path).toSorted()).toEqual(["Specs/Deep", "Specs/apollo-brief.docx", "Specs/apollo-budget.xlsx"]);
    const log = await hooks().queueLog(name);
    expect(log.observations.at(-1)?.description).toContain("apollo\\-brief\\.docx");
  });

  it("reads a Word document as Markdown, a workbook as cells, and a CSV as text", async () => {
    const base = await origin();
    const props = await bind("phillip", `${base}/_layouts/15/sharepoint.aspx`);
    const name = facet("all-files");
    const docx = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${base}/sites/Engineering/Shared%20Documents/Specs/apollo-brief.docx`]]));
    const brief = unwrap<FileContent>(await run(name, props, [["readFile", docx.id]]));
    expect(brief.format).toBe("markdown");
    expect(brief.content.length).toBeGreaterThan(50);
    expect(brief.entry.name).toBe("apollo-brief.docx");

    const xlsx = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${base}/sites/Engineering/Shared%20Documents/Specs/apollo-budget.xlsx`]]));
    const workbook = unwrap<WorkbookContent>(await run(name, props, [["readWorkbook", xlsx.id]]));
    expect(workbook.worksheets.length).toBeGreaterThan(0);
    expect(workbook.worksheets[0].values.length).toBeGreaterThan(0);

    const csv = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${base}/sites/Marketing/Shared%20Documents/Launch/roster.csv`]]));
    const roster = unwrap<FileContent>(await run(name, props, [["readFile", csv.id]]));
    expect(roster.content).toContain(",");
  });

  it("queries a list with a filter, and reads a page", async () => {
    const base = await origin();
    const props = await bind("phillip", `${base}/_layouts/15/sharepoint.aspx`);
    const name = facet("all-lists");
    const list = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${base}/sites/Engineering/Lists/Issue%20Tracker`]]));
    const columns = unwrap<Array<{ name: string; type: string }>>(await run(name, props, [["openList", list.id], ["getColumns"]]));
    expect(columns.map(column => column.name)).toContain("Title");
    const items = await walk<ListItem>(name, props, [["openList", list.id], ["queryItems", { where: [{ field: "Title", op: "startsWith", value: "" }] }]]);
    expect(Array.isArray(items)).toBe(true);

    const page = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${base}/sites/Marketing/SitePages/Launch-Plan.aspx`]]));
    const content = unwrap<{ page: { title: string }; markdown: string }>(await run(name, props, [["readPage", page.id]]));
    expect(content.page.title).toMatch(/Launch/);
    expect(content.markdown).toMatch(/^# /);
  });
});

describe.skipIf(!live)("reads, bound to one folder", () => {
  it("lists the folder by default, measures paths from it, and refuses everything else", async () => {
    const base = await origin();
    const props = await bind("phillip", `${base}/sites/Engineering/Shared%20Documents/Specs`);
    expect(props.scope.kind).toBe("folder");
    const name = facet("folder");
    const description = unwrap<{ title: string; snippet: string; suggestedBindingName: string }>(await hooks().describe(name, props));
    expect(description).toMatchObject({ title: "Specs", snippet: "Engineering › Documents › Specs", suggestedBindingName: "SHAREPOINT_FOLDER" });
    const entries = await walk<DriveEntry>(name, props, [["list"]]);
    expect(entries.map(entry => entry.path).toSorted()).toEqual(["Deep", "apollo-brief.docx", "apollo-budget.xlsx"]);

    const deep = entries.find(entry => entry.name === "Deep")!;
    const nested = await walk<DriveEntry>(name, props, [["list", { folderId: deep.id }]]);
    expect(nested.map(entry => entry.path)).toEqual(["Deep/notes.txt"]);

    // A file in another site, the library root, and the folder's parent are all outside.
    const other = unwrap<{ scope: { driveId: string; itemId: string } }>(
      await hooks().resolve(props.userObjectId, `${base}/sites/Marketing/Shared%20Documents/Launch/roster.csv`));
    expect(failure(await run(name, props, [["readFile", `${other.scope.driveId}/${other.scope.itemId}`]]))).toMatch(OUTSIDE);
    const scope = props.scope as { driveId: string };
    expect(failure(await run(name, props, [["list", { folderId: `${scope.driveId}/root` }]]))).toMatch(OUTSIDE);
    expect(failure(await run(name, props, [["listSites"]]))).toMatch(/covers one folder/);
    expect(failure(await run(name, props, [["resolveUrl", `${base}/sites/Marketing`]]))).toMatch(OUTSIDE);
  });
});

describe.skipIf(!live)("reads, bound to one file, list, page and a OneDrive", () => {
  it("binds a file and reads only it", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Engineering/Shared%20Documents/Specs/Deep/notes.txt`);
    expect(props.scope.kind).toBe("file");
    const name = facet("file");
    const scope = unwrap<SharePointScopeInfo>(await run(name, props, [["getScope"]]));
    expect(scope).toMatchObject({ kind: "file", name: "notes.txt", can: { files: true, sites: false, lists: false } });
    const content = unwrap<FileContent>(await run(name, props, [["readFile", scope.fileId]]));
    expect(content.entry.path).toBe("notes.txt");
    expect(failure(await run(name, props, [["list"]]))).toMatch(/covers one file/);
  });

  it("binds a list", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Engineering/Lists/Issue%20Tracker`);
    expect(props.scope.kind).toBe("list");
    const name = facet("list");
    const description = unwrap<{ title: string; suggestedBindingName: string }>(await hooks().describe(name, props));
    expect(description).toMatchObject({ title: "Issue Tracker", suggestedBindingName: "SHAREPOINT_LIST" });
    const info = unwrap<{ name: string }>(await run(name, props, [["openList"], ["getInfo"]]));
    expect(info.name).toBe("Issue Tracker");
    expect(failure(await run(name, props, [["list"]]))).toMatch(/covers one list/);
  });

  it("binds a page", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Marketing/SitePages/Launch-Plan.aspx`);
    expect(props.scope.kind).toBe("page");
    const name = facet("page");
    const content = unwrap<{ page: { title: string } }>(await run(name, props, [["readPage"]]));
    expect(content.page.title).toMatch(/Launch/);
  });

  it("binds a OneDrive as ONEDRIVE", async () => {
    const props = await bind("phillip", `${await oneDrive()}/Documents`);
    expect(props.scope.kind).toBe("library");
    const name = facet("onedrive");
    const description = unwrap<{ title: string; suggestedBindingName: string }>(await hooks().describe(name, props));
    expect(description.suggestedBindingName).toBe("ONEDRIVE");
    const entries = await walk<DriveEntry>(name, props, [["list"]]);
    expect(entries.map(entry => entry.name)).toContain("GadgetsSpike");
  });
});

describe.skipIf(!live)("search", () => {
  it("lists sites through Microsoft Search, home and followed sites first", async () => {
    const props = await bind("phillip", `${await origin()}/_layouts/15/sharepoint.aspx`);
    const sites = await walk<{ name: string; personal?: boolean }>(facet("sites"), props, [["listSites"]]);
    expect(sites.map(site => site.name)).toEqual(expect.arrayContaining(["Engineering", "Marketing"]));
    // The user's own OneDrive heads the list, as a personal site; nobody else's is listed.
    expect(sites[0]).toMatchObject({ personal: true });
    expect(sites.slice(1).some(site => site.personal)).toBe(false);
  });

  it("searches files within a folder binding, keeping only hits inside it", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Engineering/Shared%20Documents/Specs`);
    // What SharePoint's index holds lags uploads (by days on a new tenant), so this asserts only
    // that whatever it returns is inside the folder: relative paths, never the library around it.
    const hits = await walk<DriveEntry>(facet("search-folder"), props, [["search", "apollo"]]);
    for (const hit of hits) expect(["apollo-brief.docx", "apollo-budget.xlsx", "Deep/notes.txt"]).toContain(hit.path);
  });
});
