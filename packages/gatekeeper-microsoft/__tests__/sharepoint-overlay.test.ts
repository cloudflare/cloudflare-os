import { describe, expect, it } from "vitest";
import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { GraphDriveItem } from "../src/graph-parse";
import type { FolderTarget, ItemTarget, SharePointAction } from "../src/sharepoint-actions";
import { Overlay, drivePath, itemSiteId, pageWebUrl, toEntry, toPageInfo } from "../src/sharepoint-overlay";
import type { DriveEntry } from "../src/types";

const DRIVE = "b!AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLECTION = "11111111-1111-1111-1111-111111111111";
const WEB = "33333333-3333-3333-3333-333333333333";
const SITE = `contoso.sharepoint.com,${COLLECTION},${WEB}`;
const LIST = { siteId: SITE, listId: "44444444-4444-4444-4444-444444444444", name: "Issues" };
const FILE = { handle: "h", size: 12, digest: "d" };
const AT = Date.UTC(2026, 9, 17);

function graphItem(id: string, name: string, parentPath: string | undefined, fields: Partial<GraphDriveItem> = {}): GraphDriveItem {
  return {
    id, driveId: DRIVE, name, webUrl: `https://contoso.sharepoint.com/${name}`, kind: "file", isRoot: false, isPackage: false,
    parentId: "PARENT", ...(parentPath !== undefined ? { parentPath } : {}), ...fields,
  };
}

const target = (itemId: string, name: string, path: string): ItemTarget =>
  ({ ref: { driveId: DRIVE, itemId }, name, kind: "file", location: "Eng › Documents", path });
const folder = (id: string, name: string, path: string): FolderTarget => ({ id, driveId: DRIVE, name, location: "Eng › Documents", path });
const entry = (itemId: string, name: string, path: string): DriveEntry =>
  ({ id: `${DRIVE}/${itemId}`, name, kind: "file", webUrl: "", path, libraryId: DRIVE });

let nextId = 1;
const pending = (...actions: SharePointAction[]): JournalEntry<SharePointAction>[] => actions.map(action => ({ id: nextId++, action }));
const identity = (id: string) => id;

describe("drivePath and toEntry", () => {
  it("measures an item's path from the binding's top folder", () => {
    const item = graphItem("NOTES", "notes.txt", "Specs/Deep");
    expect(drivePath(item)).toBe("Specs/Deep/notes.txt");
    expect(toEntry(item, { driveId: DRIVE, path: "" }).path).toBe("Specs/Deep/notes.txt");
    expect(toEntry(item, { driveId: DRIVE, path: "Specs", itemId: "SPECS" }).path).toBe("Deep/notes.txt");
  });

  it("calls the top folder \"\" and gives it no parent, since its parent is outside", () => {
    const top = toEntry(graphItem("SPECS", "Specs", "", { kind: "folder" }), { driveId: DRIVE, path: "Specs", itemId: "SPECS" });
    expect(top.path).toBe("");
    expect(top.parentId).toBeUndefined();
    const root = toEntry(graphItem("ROOT", "Documents", undefined, { kind: "folder", isRoot: true }), { driveId: DRIVE, path: "" });
    expect(root.path).toBe("");
  });

  it("calls a file binding's own file by its name", () => {
    const file = toEntry(graphItem("NOTES", "notes.txt", "Specs/Deep"), { driveId: DRIVE, path: "Specs/Deep/notes.txt", itemId: "NOTES" });
    expect(file.path).toBe("notes.txt");
  });

  it("never shows a path above the top folder, falling back to the name", () => {
    expect(toEntry(graphItem("X", "x.txt", "Other"), { driveId: DRIVE, path: "Specs" }).path).toBe("x.txt");
    // A sibling whose name begins like the top folder's is still outside it.
    expect(toEntry(graphItem("X", "x.txt", "Specs2"), { driveId: DRIVE, path: "Specs" }).path).toBe("x.txt");
    expect(toEntry({ ...graphItem("X", "x.txt", "Specs"), driveId: "b!OTHEROTHEROTHEROTHEROTHER" }, { driveId: DRIVE, path: "" }).path).toBe("x.txt");
  });

  it("fences a file on its content tag and a folder on its eTag", () => {
    expect(toEntry(graphItem("F", "f.txt", "", { eTag: "e", cTag: "c" }), { driveId: DRIVE, path: "" }).eTag).toBe("c");
    expect(toEntry(graphItem("F", "f.txt", "", { eTag: "e" }), { driveId: DRIVE, path: "" }).eTag).toBe("e");
    expect(toEntry(graphItem("D", "d", "", { kind: "folder", eTag: "e", cTag: "c", size: 9 }), { driveId: DRIVE, path: "" }))
      .toMatchObject({ eTag: "e", kind: "folder" });
    expect(toEntry(graphItem("D", "d", "", { kind: "folder", size: 9 }), { driveId: DRIVE, path: "" }).size).toBeUndefined();
  });

  it("names the item's site only when Graph said enough to build its ID", () => {
    expect(itemSiteId({ siteHost: "contoso.sharepoint.com", siteCollectionId: COLLECTION, webId: WEB })).toBe(SITE);
    expect(itemSiteId({ siteCollectionId: COLLECTION, webId: WEB })).toBeUndefined();
  });

  it("resolves a page's site-relative URL against its site", () => {
    const page = { id: "p", name: "Home.aspx", title: "Home", webUrl: "SitePages/Home.aspx" };
    expect(toPageInfo(page, SITE, "https://contoso.sharepoint.com/sites/eng/").webUrl).toBe("https://contoso.sharepoint.com/sites/eng/SitePages/Home.aspx");
    // Graph's site URLs have no trailing slash; the join must not drop the site's last segment.
    expect(pageWebUrl(page, "https://contoso.sharepoint.com/sites/eng")).toBe("https://contoso.sharepoint.com/sites/eng/SitePages/Home.aspx");
    expect(pageWebUrl({ webUrl: "https://contoso.sharepoint.com/sites/eng/SitePages/Home.aspx" }, "https://contoso.sharepoint.com/sites/other"))
      .toBe("https://contoso.sharepoint.com/sites/eng/SitePages/Home.aspx");
    expect(pageWebUrl(page, undefined)).toBe("SitePages/Home.aspx");
    expect(toPageInfo({ ...page, state: "draft" }, SITE).published).toBe(false);
  });
});

describe("Overlay over files", () => {
  it("is empty with nothing pending, and leaves entries alone", () => {
    const overlay = new Overlay([], identity);
    expect(overlay.empty).toBe(true);
    expect(overlay.apply(entry("A", "a.txt", "a.txt"), "ROOT")).toEqual(entry("A", "a.txt", "a.txt"));
  });

  it("shows a pending rename under its new name, in the same folder", () => {
    const overlay = new Overlay(pending({ kind: "rename", payload: { target: target("A", "a.txt", "Specs/a.txt"), name: "b.txt", submittedAt: AT } }), identity);
    expect(overlay.apply(entry("A", "a.txt", "Specs/a.txt"), `${DRIVE}/SPECS`)).toMatchObject({ name: "b.txt", path: "Specs/b.txt", pending: "rename" });
  });

  it("lists a pending move where it is going, not where it is, under any pending new name", () => {
    const overlay = new Overlay(pending(
      { kind: "rename", payload: { target: target("A", "a.txt", "a.txt"), name: "final.txt", submittedAt: AT } },
      { kind: "move", payload: { target: target("A", "a.txt", "a.txt"), from: { id: `${DRIVE}/ROOT`, location: "" }, to: folder(`${DRIVE}/ARCHIVE`, "Archive", "Archive"), submittedAt: AT } },
    ), identity);
    expect(overlay.apply(entry("A", "a.txt", "a.txt"), `${DRIVE}/ROOT`)).toBeNull();
    expect(overlay.apply(entry("A", "a.txt", "a.txt"), `${DRIVE}/ARCHIVE`)).toMatchObject({ path: "Archive/final.txt", pending: "move" });
    // A direct read finds it wherever it is listed.
    expect(overlay.apply(entry("A", "a.txt", "a.txt"))).toMatchObject({ name: "final.txt", parentId: `${DRIVE}/ARCHIVE` });
    expect(overlay.addedTo(`${DRIVE}/ARCHIVE`, "Archive", DRIVE, SITE)).toEqual([
      { id: `${DRIVE}/A`, name: "final.txt", kind: "file", webUrl: "", path: "Archive/final.txt", parentId: `${DRIVE}/ARCHIVE`, libraryId: DRIVE, pending: "move" },
    ]);
    expect(overlay.addedTo(`${DRIVE}/ROOT`, "", DRIVE, SITE)).toEqual([]);
  });

  it("drops a pending delete from listings, but a direct read shows it marked", () => {
    const overlay = new Overlay(pending({ kind: "deleteItem", payload: { target: target("A", "a.txt", "a.txt"), submittedAt: AT } }), identity);
    expect(overlay.apply(entry("A", "a.txt", "a.txt"), `${DRIVE}/ROOT`)).toBeNull();
    expect(overlay.apply(entry("A", "a.txt", "a.txt"))).toMatchObject({ pending: "delete" });
    expect(overlay.isDeleted(`${DRIVE}/A`)).toBe(true);
    expect(overlay.hasPendingChange(`${DRIVE}/A`)).toBe(true);
  });

  it("keeps a delete marked even when a later rename is pending too", () => {
    const overlay = new Overlay(pending(
      { kind: "deleteItem", payload: { target: target("A", "a.txt", "a.txt"), submittedAt: AT } },
      { kind: "rename", payload: { target: target("A", "a.txt", "a.txt"), name: "b.txt", submittedAt: AT } },
    ), identity);
    expect(overlay.apply(entry("A", "a.txt", "a.txt"))).toMatchObject({ pending: "delete" });
  });

  it("shows a pending replacement's size and type, and serves its staged content", () => {
    const overlay = new Overlay(pending({
      kind: "replaceFile", payload: { target: target("A", "a.txt", "a.txt"), file: FILE, mimeType: "text/markdown", submittedAt: AT },
    }), identity);
    expect(overlay.apply(entry("A", "a.txt", "a.txt"), `${DRIVE}/ROOT`)).toMatchObject({ size: 12, mimeType: "text/markdown", pending: "replace" });
    expect(overlay.pendingContent(`${DRIVE}/A`)).toEqual({ file: FILE, mimeType: "text/markdown", name: "a.txt" });
  });

  it("lists creations inside a folder that is itself still pending, with temporary IDs", () => {
    const overlay = new Overlay(pending(
      { kind: "createFolder", payload: { ref: "~1", parent: folder(`${DRIVE}/ROOT`, "Documents", ""), name: "Drafts", submittedAt: AT } },
      { kind: "uploadFile", payload: { ref: "~2", parent: folder("~1", "Drafts", "Drafts"), name: "plan.md", file: FILE, mimeType: "text/markdown", submittedAt: AT } },
    ), identity);
    expect(overlay.addedTo(`${DRIVE}/ROOT`, "", DRIVE, SITE)).toEqual([{
      id: "~1", name: "Drafts", kind: "folder", webUrl: "", path: "Drafts", parentId: `${DRIVE}/ROOT`, libraryId: DRIVE, siteId: SITE,
      childCount: 0, createdAt: new Date(AT).toISOString(), modifiedAt: new Date(AT).toISOString(), pending: "create",
    }]);
    expect(overlay.addedTo("~1", "Drafts", DRIVE, SITE)).toMatchObject([{ id: "~2", path: "Drafts/plan.md", size: 12, mimeType: "text/markdown" }]);
    expect(overlay.created("~2")).toMatchObject({ name: "plan.md", parentId: "~1", path: "Drafts/plan.md" });
    expect(overlay.created("~9")).toBeUndefined();
    expect(overlay.pendingContent("~2")).toEqual({ file: FILE, mimeType: "text/markdown", name: "plan.md" });
  });

  it("follows a temporary folder to its real ID once its creation applied", () => {
    const real = `${DRIVE}/REALDRAFTS`;
    const overlay = new Overlay(pending(
      { kind: "uploadFile", payload: { ref: "~2", parent: folder("~1", "Drafts", "Drafts"), name: "plan.md", file: FILE, mimeType: "text/plain", submittedAt: AT } },
    ), id => (id === "~1" ? real : id));
    expect(overlay.addedTo(real, "Drafts", DRIVE, undefined)).toMatchObject([{ id: "~2", parentId: real }]);
    expect(overlay.addedTo("~1", "Drafts", DRIVE, undefined)).toEqual([]);
  });
});

describe("Overlay over list items", () => {
  const other = { ...LIST, listId: "55555555-5555-5555-5555-555555555555" };

  it("adds pending creations to their own list only", () => {
    const overlay = new Overlay(pending(
      { kind: "createListItem", payload: { ref: "~1", list: LIST, fields: { Title: "New" }, labels: {}, submittedAt: AT } },
      { kind: "createListItem", payload: { ref: "~2", list: other, fields: { Title: "Elsewhere" }, labels: {}, submittedAt: AT } },
    ), identity);
    expect(overlay.createdItems(LIST, true)).toEqual([{
      id: "~1", fields: { Title: "New" }, createdAt: new Date(AT).toISOString(), modifiedAt: new Date(AT).toISOString(), pending: "create",
    }]);
  });

  it("shows a created item with its own pending changes, still as a creation, and hides its pending deletion from listings only", () => {
    const create: SharePointAction = { kind: "createListItem", payload: { ref: "~1", list: LIST, fields: { Title: "New", Status: "Open" }, labels: {}, submittedAt: AT } };
    const updated = new Overlay(pending(create,
      { kind: "updateListItem", payload: { list: LIST, itemId: "~1", fields: { Title: "Renamed" }, labels: {}, before: { Title: "New" }, submittedAt: AT } },
    ), identity);
    expect(updated.createdItems(LIST, true)).toMatchObject([{ id: "~1", fields: { Title: "Renamed", Status: "Open" }, pending: "create" }]);
    expect(updated.hasPendingItemChange(LIST, "~1")).toBe(true);

    const deleted = new Overlay(pending(create, { kind: "deleteListItem", payload: { list: LIST, itemId: "~1", submittedAt: AT } }), identity);
    expect(deleted.createdItems(LIST, true)).toEqual([]);
    expect(deleted.createdItems(LIST, false)).toMatchObject([{ id: "~1", pending: "delete" }]);
  });

  it("merges pending updates in order, and hides a pending delete from listings only", () => {
    const item = { id: "7", fields: { Title: "Old", Status: "Open" } };
    const overlay = new Overlay(pending(
      { kind: "updateListItem", payload: { list: LIST, itemId: "7", fields: { Title: "First" }, labels: {}, before: {}, submittedAt: AT } },
      { kind: "updateListItem", payload: { list: LIST, itemId: "7", fields: { Title: "Second" }, labels: {}, before: {}, submittedAt: AT } },
      { kind: "updateListItem", payload: { list: other, itemId: "7", fields: { Title: "Wrong list" }, labels: {}, before: {}, submittedAt: AT } },
    ), identity);
    expect(overlay.applyItem(LIST, item, true)).toEqual({ id: "7", fields: { Title: "Second", Status: "Open" }, pending: "update" });
    expect(overlay.hasPendingItemChange(LIST, "7")).toBe(true);
    expect(overlay.hasPendingItemChange(LIST, "8")).toBe(false);

    const deleting = new Overlay(pending({ kind: "deleteListItem", payload: { list: LIST, itemId: "7", submittedAt: AT } }), identity);
    expect(deleting.applyItem(LIST, item, true)).toBeNull();
    expect(deleting.applyItem(LIST, item, false)).toMatchObject({ pending: "delete" });
  });

  it("matches an update to a created item once its temporary ID resolves", () => {
    const overlay = new Overlay(pending(
      { kind: "updateListItem", payload: { list: LIST, itemId: "~1", fields: { Title: "Edited" }, labels: {}, before: {}, submittedAt: AT } },
    ), id => (id === "~1" ? "12" : id));
    expect(overlay.applyItem(LIST, { id: "12", fields: { Title: "Made" } }, true)).toMatchObject({ fields: { Title: "Edited" } });
  });
});
