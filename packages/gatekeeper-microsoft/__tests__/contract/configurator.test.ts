// The configurator capability against the live tenant: browsing each kind of place, searching, pasted
// links, and the round trip from a choice to a resource URL and back into the picker.

import { describe, expect, it } from "vitest";
import type {
  SharePointBrowserPage, SharePointConfiguratorStatus, SharePointLocated,
} from "../../src/configurator/sharepoint-configurator-types";
import { connect, failure, hooks, live, oneDrive, origin, unwrap, type Label } from "./tenant";

async function ui<T>(method: string, ...args: unknown[]): Promise<T> {
  return await uiAs<T>("phillip", method, ...args);
}

async function uiAs<T>(label: Label, method: string, ...args: unknown[]): Promise<T> {
  return unwrap<T>(await hooks().configurator(await connect(label), "write", method, ...args));
}

const titles = (page: SharePointBrowserPage) => page.items.map(item => item.title);

describe.skipIf(!live)("configurator", () => {
  it("reports a ready connection with write access", async () => {
    expect(await ui<SharePointConfiguratorStatus>("getStatus")).toEqual({ state: "ready", access: "write", tenant: expect.any(String) });
  });

  it("lists sites, falling back to followed sites while search is unavailable", async () => {
    const page = await ui<SharePointBrowserPage>("loadItems", { tab: "sites" });
    expect(titles(page)).toEqual(expect.arrayContaining(["Engineering", "Marketing"]));
    for (const item of page.items) expect(item).toMatchObject({ icon: "site", navigable: true, value: expect.stringMatching(/^site:/) });
  });

  it("opens a site into its libraries, lists, pages and subsites", async () => {
    const sites = await ui<SharePointBrowserPage>("loadItems", { tab: "sites" });
    const marketing = sites.items.find(item => item.title === "Marketing")!;
    const contents = await ui<SharePointBrowserPage>("loadItems", { tab: "sites", container: marketing.value });
    expect(contents.items.map(item => [item.title, item.icon])).toEqual(expect.arrayContaining([
      ["Documents", "library"], ["Events", "list"], ["Site Pages", "pages"],
    ]));
    const pages = contents.items.find(item => item.icon === "pages")!;
    expect(pages).toMatchObject({ selectable: false, navigable: true });
    const inside = await ui<SharePointBrowserPage>("loadItems", { tab: "sites", container: pages.value });
    expect(titles(inside)).toEqual(expect.arrayContaining([expect.stringMatching(/Launch/)]));
  });

  it("lists a folder with folders first, sizes, counts and file icons", async () => {
    const library = await ui<SharePointLocated>("locate", `${await origin()}/sites/Engineering/Shared%20Documents/Specs`);
    expect(library).toMatchObject({ title: "Specs", tab: "sites" });
    expect(library.path.map(crumb => crumb.title)).toEqual(["Engineering", "Documents"]);
    const page = await ui<SharePointBrowserPage>("loadItems", { tab: "sites", container: library.ref });
    expect(page.items.map(item => [item.title, item.icon])).toEqual([
      ["Deep", "folder"], ["apollo-brief.docx", "document"], ["apollo-budget.xlsx", "spreadsheet"],
    ]);
    expect(page.items[0].meta).toBe("1 item");
    expect(page.items[1].meta).toMatch(/ KB$/);
    expect(page.items[1].subtitle).toMatch(/^Modified .+ by /);
  });

  it("shows the OneDrive tab as My files to open or choose, and Shared with you to open", async () => {
    const page = await ui<SharePointBrowserPage>("loadItems", { tab: "onedrive" });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ title: "My files", subtitle: "Your OneDrive", icon: "onedrive", navigable: true });
    expect(page.items[1]).toMatchObject({ value: "shared", title: "Shared with you", navigable: true, selectable: false });
    const inside = await ui<SharePointBrowserPage>("loadItems", { tab: "onedrive", container: page.items[0].value });
    expect(titles(inside)).toContain("GadgetsSpike");
    expect(failure(await hooks().configurator(await connect("phillip"), "write", "resourceUrlFor", "shared"))).toMatch(/Choose one of the things shared/);
  });

  // The tenant's fixture shares Phillip's `Shared with Sarah` folder with Sarah.
  it("lists what others shared from their OneDrives, outermost first, under Shared with you", async () => {
    const shared = await uiAs<SharePointBrowserPage>("sarah", "loadItems", { tab: "onedrive", container: "shared" });
    const folder = shared.items.find(item => item.title === "Shared with Sarah");
    expect(folder).toMatchObject({ icon: "folder", navigable: true, value: expect.stringMatching(/^folder:/) });
    expect(folder!.path?.[0]).toMatchObject({ value: "shared", title: "Shared with you" });
    // What's inside a shared folder is left to opening it, and Sarah's own files aren't there at all.
    expect(titles(shared)).not.toContain("Inside the shared folder.docx");
    for (const item of shared.items) expect(item.subtitle ?? "").not.toMatch(/by you$/);
    const inside = await uiAs<SharePointBrowserPage>("sarah", "loadItems", { tab: "onedrive", container: folder!.value });
    expect(titles(inside)).toEqual(["Inside the shared folder.docx"]);

    const searched = await uiAs<SharePointBrowserPage>("sarah", "loadItems", { tab: "onedrive", container: "shared", query: "Inside" });
    expect(titles(searched)).toContain("Inside the shared folder.docx");

    // A pasted link into someone else's OneDrive sits under Shared with you, not their OneDrive.
    const located = await uiAs<SharePointLocated>("sarah", "locate", `${await oneDrive()}/Documents/Shared%20with%20Sarah`);
    expect(located).toMatchObject({ title: "Shared with Sarah", tab: "onedrive" });
    expect(located.path[0]).toMatchObject({ value: "shared", title: "Shared with you" });
  });

  it("resolves a pasted link to one row with its breadcrumb", async () => {
    const url = `${await oneDrive()}/Documents/GadgetsSpike/Apollo/Specs`;
    const page = await ui<SharePointBrowserPage>("loadItems", { tab: "sites", query: url });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ title: "Specs", icon: "folder" });
    expect(page.items[0].path?.map(crumb => crumb.title)).toEqual(["OneDrive", "GadgetsSpike", "Apollo"]);

    const foreign = await ui<SharePointBrowserPage>("loadItems", { tab: "sites", query: "https://example.com/x" });
    expect(foreign).toEqual({ items: [], notice: expect.stringMatching(/isn't a SharePoint or OneDrive link/) });
    const everything = await ui<SharePointBrowserPage>("loadItems", { tab: "sites", query: `${await origin()}/_layouts/15/sharepoint.aspx` });
    expect(everything.notice).toMatch(/Choose “All of SharePoint & OneDrive” above/);
  });

  it("round-trips every kind of choice through a resource URL and back", async () => {
    const base = await origin();
    const urls = [
      `${base}/_layouts/15/sharepoint.aspx`,
      `${base}/sites/Engineering`,
      `${base}/sites/Engineering/Shared%20Documents`,
      `${base}/sites/Engineering/Shared%20Documents/Specs`,
      `${base}/sites/Engineering/Shared%20Documents/Specs/Deep/notes.txt`,
      `${base}/sites/Engineering/Lists/Issue%20Tracker`,
      `${base}/sites/Marketing/SitePages/Launch-Plan.aspx`,
      `${await oneDrive()}/Documents`,
    ];
    for (const url of urls) {
      const located = await ui<SharePointLocated>("locate", url);
      const resourceUrl = await ui<string>("resourceUrlFor", located.ref);
      const again = await ui<SharePointLocated>("locate", resourceUrl);
      expect(again.ref, url).toBe(located.ref);
    }
  });

  it("refuses a malformed ref", async () => {
    expect(failure(await hooks().configurator(await connect("phillip"), "write", "resourceUrlFor", "folder:../../me"))).toMatch(/isn't valid/);
    expect(failure(await hooks().configurator(await connect("phillip"), "write", "loadItems", { tab: "sites", container: "site:x/y" }))).toMatch(/isn't valid/);
  });
});
