import { describe, expect, it } from "vitest";
import { GraphApiError } from "../src/graph-api";
import {
  canonicalSiteId, isDeletedItem, parseCanvas, parseColumn, parseDrive, parseDriveItem, parseList, parseListItem, parseMe, parsePage,
  parseRange, parseSite, parseSitePage, parseWorksheet, splitSiteId,
} from "../src/graph-parse";

const COLLECTION = "11111111-1111-1111-1111-111111111111";
const WEB = "33333333-3333-3333-3333-333333333333";

describe("site IDs", () => {
  it("splits and canonicalizes Graph's composite ID", () => {
    expect(splitSiteId(`Contoso.SharePoint.com,${COLLECTION.toUpperCase()},${WEB}`))
      .toEqual({ host: "contoso.sharepoint.com", siteCollectionId: COLLECTION, webId: WEB });
    expect(canonicalSiteId(`Contoso.SharePoint.com,${COLLECTION.toUpperCase()},${WEB}`)).toBe(`contoso.sharepoint.com,${COLLECTION},${WEB}`);
  });

  it.each([
    `contoso.sharepoint.com,${COLLECTION}`,
    `contoso.sharepoint.com,${COLLECTION},${WEB},extra`,
    `contoso,${COLLECTION},${WEB}`,
    `contoso.sharepoint.com,not-a-guid,${WEB}`,
    `contoso.sharepoint.com/x,${COLLECTION},${WEB}`,
    "contoso.sharepoint.com:/sites/Eng",
  ])("refuses %s", id => {
    expect(splitSiteId(id)).toBeNull();
    expect(canonicalSiteId(id)).toBeNull();
  });
});

describe("parseSite", () => {
  const id = `contoso.sharepoint.com,${COLLECTION},${WEB}`;

  it("prefers the display name, and keeps only what it knows", () => {
    expect(parseSite({
      id, name: "eng", displayName: "Engineering", webUrl: "https://contoso.sharepoint.com/sites/eng", description: "Builders",
      root: {}, lastModifiedDateTime: "2026-10-01T00:00:00Z", siteCollection: { hostname: "contoso.sharepoint.com" }, secret: "x",
    })).toEqual({
      id, name: "Engineering", webUrl: "https://contoso.sharepoint.com/sites/eng", description: "Builders", personal: false, isRoot: true,
      modifiedAt: "2026-10-01T00:00:00Z",
    });
  });

  it("names the tenant's root site by its host when Graph gives it no name", () => {
    expect(parseSite({ id, webUrl: "https://contoso.sharepoint.com/" }).name).toBe("contoso.sharepoint.com");
  });

  it("recognizes a OneDrive by its -my host even when Graph doesn't flag it", () => {
    expect(parseSite({ id, name: "Sarah", webUrl: "https://contoso-my.sharepoint.com/personal/sarah_contoso_com" }).personal).toBe(true);
    expect(parseSite({ id, name: "x", webUrl: "https://contoso.sharepoint.com/sites/x", isPersonalSite: true }).personal).toBe(true);
  });

  it("refuses a site without a composite ID", () => {
    expect(() => parseSite({ id: "abc", webUrl: "https://contoso.sharepoint.com" })).toThrow(GraphApiError);
    expect(() => parseSite(null)).toThrow(/malformed site/);
  });
});

describe("parseDrive", () => {
  it("reads the library's site from sharePointIds, lower-cased, and its owner's name", () => {
    expect(parseDrive({
      id: "b!drive", webUrl: "https://contoso.sharepoint.com/sites/eng/Shared%20Documents", driveType: "documentLibrary",
      sharePointIds: { siteId: COLLECTION.toUpperCase(), webId: WEB, siteUrl: "https://contoso.sharepoint.com/sites/eng", listId: "ABC" },
      owner: { user: { displayName: "Sarah", email: "sarah@contoso.com" } },
    })).toEqual({
      id: "b!drive", name: "Documents", webUrl: "https://contoso.sharepoint.com/sites/eng/Shared%20Documents", driveType: "documentLibrary",
      siteCollectionId: COLLECTION, webId: WEB, siteUrl: "https://contoso.sharepoint.com/sites/eng", listId: "abc", ownerName: "Sarah",
    });
  });
});

describe("parseDriveItem", () => {
  const file = {
    id: "01FILE",
    name: "brief.docx",
    webUrl: "https://contoso.sharepoint.com/sites/eng/Shared%20Documents/Specs/brief.docx",
    eTag: "\"{A},3\"",
    cTag: "\"c:{A},2\"",
    size: 2048,
    file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    parentReference: { driveId: "b!drive", id: "01PARENT", path: "/drives/b!drive/root:/Specs%20%26%20Plans/Deep", name: "Deep" },
    createdBy: { user: { displayName: "Sarah", email: "sarah@contoso.com" } },
    lastModifiedBy: { application: { displayName: "Power Automate" } },
    sharepointIds: { siteId: COLLECTION.toUpperCase(), webId: WEB, siteUrl: "https://Contoso.sharepoint.com/sites/eng", listItemId: "7" },
    "@microsoft.graph.downloadUrl": "https://contoso.sharepoint.com/download?tempauth=secret",
  };

  it("keeps an allowlist of fields, never the pre-authenticated download URL", () => {
    const parsed = parseDriveItem(file);
    expect(parsed).toEqual({
      id: "01FILE", driveId: "b!drive", name: "brief.docx", webUrl: file.webUrl, kind: "file", parentId: "01PARENT",
      parentPath: "Specs & Plans/Deep", isRoot: false, eTag: file.eTag, cTag: file.cTag, size: 2048, mimeType: file.file.mimeType,
      createdBy: "Sarah", modifiedBy: "Power Automate", siteCollectionId: COLLECTION, webId: WEB, siteHost: "contoso.sharepoint.com",
      listItemId: "7", isPackage: false,
    });
    expect(JSON.stringify(parsed)).not.toContain("tempauth");
  });

  it("reads a drive's root as a folder with no parent, named Documents when Graph says nothing", () => {
    const root = parseDriveItem({
      id: "01ROOT", webUrl: "https://contoso.sharepoint.com/sites/eng/Shared%20Documents", root: {}, folder: { childCount: 4 },
      parentReference: { driveId: "b!drive", id: "should-not-show", path: "/drives/b!drive/root:" },
    });
    expect(root).toMatchObject({ id: "01ROOT", name: "Documents", kind: "folder", isRoot: true, childCount: 4 });
    expect(root.parentId).toBeUndefined();
    expect(root.parentPath).toBeUndefined();
  });

  it("reads a top-level item's parent path as the empty string", () => {
    expect(parseDriveItem({ ...file, parentReference: { driveId: "b!drive", id: "01ROOT", path: "/drives/b!drive/root:" } }).parentPath).toBe("");
  });

  it("keeps a parent path it can't decode as it was", () => {
    expect(parseDriveItem({ ...file, parentReference: { driveId: "b!drive", path: "/drives/b!drive/root:/100%" } }).parentPath).toBe("100%");
  });

  it("reads a OneNote notebook as a package that lists like a folder", () => {
    expect(parseDriveItem({ ...file, file: undefined, package: { type: "oneNote" } })).toMatchObject({ kind: "folder", isPackage: true });
  });

  it("reads a shared-with-me shortcut's real home", () => {
    const shortcut = parseDriveItem({
      id: "01SHORT", name: "Apollo", webUrl: "https://contoso-my.sharepoint.com/personal/p/Documents/Apollo",
      remoteItem: { id: "01REAL", folder: { childCount: 2 }, parentReference: { driveId: "b!theirs" } },
    });
    expect(shortcut).toMatchObject({ driveId: "b!theirs", kind: "folder", childCount: 2, remote: { driveId: "b!theirs", id: "01REAL" } });
  });

  it("reads a OneDrive shortcut, which Graph sends with no web URL", () => {
    const shortcut = parseDriveItem({
      id: "01SC", name: "Phillip's files - Apollo", parentReference: { driveId: "b!mine", id: "01ROOT" }, cTag: "\"c:{S},0\"",
      remoteItem: { id: "01REAL", folder: { childCount: 3 }, parentReference: { driveId: "b!theirs" }, size: 10 },
    });
    expect(shortcut).toMatchObject({ driveId: "b!mine", webUrl: "", kind: "folder", remote: { driveId: "b!theirs", id: "01REAL" } });
  });

  it("refuses an item with no drive, or a nameless one that isn't a root", () => {
    expect(() => parseDriveItem({ id: "x", name: "x", webUrl: "https://x" })).toThrow(/malformed file/);
    expect(() => parseDriveItem({ ...file, name: "" })).toThrow(/malformed file/);
  });

  it("recognizes a deleted item", () => {
    expect(isDeletedItem({ id: "x", deleted: { state: "deleted" } })).toBe(true);
    expect(isDeletedItem({ id: "x" })).toBe(false);
    expect(isDeletedItem("nope")).toBe(false);
  });
});

describe("parseList", () => {
  it("reads the list's template, visibility and site", () => {
    expect(parseList({
      id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", displayName: "Issue Tracker", name: "IssueTracker", webUrl: "https://x/Lists/Issue%20Tracker",
      list: { template: "genericList", hidden: false }, parentReference: { siteId: `Contoso.sharepoint.com,${COLLECTION},${WEB}` },
    })).toEqual({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Issue Tracker", webUrl: "https://x/Lists/Issue%20Tracker", template: "genericList",
      hidden: false, siteId: `contoso.sharepoint.com,${COLLECTION},${WEB}`,
    });
  });

  it("drops a parent site ID that isn't composite", () => {
    expect(parseList({ id: "a", name: "A", webUrl: "https://x", parentReference: { siteId: "nope" } }).siteId).toBeUndefined();
  });
});

describe("parseColumn", () => {
  it.each([
    [{ text: { allowMultipleLines: false } }, { type: "text" }],
    [{ text: { allowMultipleLines: true } }, { type: "note" }],
    [{ number: {} }, { type: "number" }],
    [{ currency: { locale: "en-us" } }, { type: "currency" }],
    [{ boolean: {} }, { type: "boolean" }],
    [{ dateTime: { format: "dateOnly" } }, { type: "dateTime" }],
    [{ choice: { choices: ["A", "B", 3], displayAs: "dropDownMenu" } }, { type: "choice", choices: ["A", "B"] }],
    [{ choice: { choices: ["A"], displayAs: "checkBoxes" } }, { type: "multiChoice", choices: ["A"] }],
    [{ personOrGroup: { allowMultipleSelection: true } }, { type: "person", multiple: true }],
    [{ hyperlinkOrPicture: {} }, { type: "hyperlink" }],
    [{ geolocation: {} }, { type: "other" }],
  ])("reads %j", (facet, expected) => {
    expect(parseColumn({ name: "Col", ...facet })).toMatchObject({ ...expected, readOnly: false });
  });

  it("marks calculated and lookup columns read-only whatever Graph says", () => {
    expect(parseColumn({ name: "Total", calculated: { formula: "=1" }, readOnly: false })).toMatchObject({ type: "calculated", readOnly: true });
    expect(parseColumn({ name: "Parent", lookup: { allowMultipleValues: false } })).toMatchObject({ type: "lookup", readOnly: true, multiple: false });
  });

  it("falls back to the internal name for the display name, and refuses a nameless column", () => {
    expect(parseColumn({ name: "Due", dateTime: {} })).toMatchObject({ name: "Due", displayName: "Due", required: false, hidden: false, indexed: false });
    expect(() => parseColumn({ displayName: "x" })).toThrow(/malformed column/);
  });
});

describe("parseListItem", () => {
  it("drops SharePoint's bookkeeping fields and keeps the item's own", () => {
    expect(parseListItem({
      id: "7", eTag: "\"e,1\"", webUrl: "https://x/7", createdBy: { user: { displayName: "Sarah" } },
      fields: {
        "@odata.etag": "x", "odata.type": "x", Title: "Fix it", Status: "Open", ContentType: "Item", LinkTitle: "Fix it",
        AuthorLookupId: "6", Attachments: false, _UIVersionString: "1.0", id: "7", Priority: 2,
      },
    })).toEqual({
      id: "7", eTag: "\"e,1\"", webUrl: "https://x/7", createdBy: "Sarah", fields: { Title: "Fix it", Status: "Open", Priority: 2 },
      version: "1.0",
    });
  });

  it("keeps the version and approval state an item is shown at, out of its fields", () => {
    const item = parseListItem({ id: "3", fields: { Title: "x", _UIVersionString: "2.1", _ModerationStatus: 2 } });
    expect(item).toMatchObject({ version: "2.1", moderation: 2, fields: { Title: "x" } });
    expect(parseListItem({ id: "3", fields: { _ModerationStatus: "2" } })).not.toHaveProperty("moderation");
  });
});

describe("pages", () => {
  it("reads a page, titling it from its file name when it has no title", () => {
    expect(parseSitePage({
      id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", name: "Launch-Plan.aspx", webUrl: "SitePages/Launch-Plan.aspx",
      publishingState: { level: "checkout" }, lastModifiedBy: { user: { displayName: "Bob" } },
    })).toEqual({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Launch-Plan.aspx", title: "Launch-Plan", webUrl: "SitePages/Launch-Plan.aspx",
      modifiedBy: "Bob", state: "checkout",
    });
    expect(parseSitePage({ id: "a", name: "p.aspx", webUrl: "SitePages/p.aspx", publishingState: { level: "draft", versionId: "1.1" } }))
      .toMatchObject({ state: "draft", version: "1.1" });
  });

  it("flattens a canvas into reading order: sections, columns, web parts, then the vertical section", () => {
    expect(parseCanvas({
      canvasLayout: {
        horizontalSections: [
          { columns: [{ webparts: [{ innerHtml: "<p>one</p>" }] }, { webparts: [{ data: { title: "Hero", description: "Banner" } }] }] },
          { columns: [{ webparts: [{ innerHtml: "<p>two</p>" }, null, { data: {} }] }] },
        ],
        verticalSection: { webparts: [{ innerHtml: "<p>side</p>" }] },
      },
    })).toEqual([
      { kind: "text", html: "<p>one</p>" },
      { kind: "other", title: "Hero", description: "Banner" },
      { kind: "text", html: "<p>two</p>" },
      { kind: "other" },
      { kind: "text", html: "<p>side</p>" },
    ]);
  });

  it("reads a page with no canvas as empty", () => {
    expect(parseCanvas({ id: "x" })).toEqual([]);
    expect(parseCanvas(null)).toEqual([]);
  });
});

describe("parsePage", () => {
  it("parses each row and keeps the next link", () => {
    expect(parsePage({ value: [1, 2], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" }, row => Number(row) * 2, "thing"))
      .toEqual({ items: [2, 4], nextLink: "https://graph.microsoft.com/v1.0/next" });
    expect(parsePage({ value: [] }, row => row, "thing")).toEqual({ items: [] });
  });

  it("refuses a page with no rows array, as a 502", () => {
    try {
      parsePage({ value: {} }, row => row, "thing");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GraphApiError);
      expect((error as GraphApiError).status).toBe(502);
      expect((error as GraphApiError).message).toBe("Microsoft Graph sent a malformed thing list.");
    }
  });
});

describe("the rest", () => {
  it("reads the signed-in user without needing a mail address", () => {
    expect(parseMe({ id: "ABC", userPrincipalName: "p@contoso.com" })).toEqual({ id: "abc", displayName: "p@contoso.com", userPrincipalName: "p@contoso.com" });
  });

  it("reads a range's values and formulas, refusing ragged shapes", () => {
    expect(parseRange({ address: "Sheet1!A1:B1", values: [[1, "=x"]], formulas: [[1, "=A1"]] }))
      .toEqual({ address: "Sheet1!A1:B1", values: [[1, "=x"]], formulas: [[1, "=A1"]] });
    expect(() => parseRange({ values: [1, 2] })).toThrow(/malformed worksheet range/);
  });

  it("reads a hidden worksheet as not visible", () => {
    expect(parseWorksheet({ id: "1", name: "Data", visibility: "Hidden" }).visible).toBe(false);
    expect(parseWorksheet({ id: "1", name: "Data" }).visible).toBe(true);
  });
});
