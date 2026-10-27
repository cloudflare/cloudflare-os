// The SharePoint configurator frame as the Workshop hosts it, in Chromium: the journeys a user takes
// through its picker, with the gatekeeper capability faked so each test decides what each listing
// answers and when. Needs the generated frame (`build:configurator`, which `test:run` runs first).

import type { Locator } from "playwright";
import { describe, expect, it, vi } from "vitest";
import type {
  SharePointBrowserPage, SharePointConfiguratorStatus, SharePointLocated,
} from "../src/configurator/sharepoint-configurator-types";
import { startFrame, useFrameHost } from "./frame-host";

useFrameHost();

const READY: SharePointConfiguratorStatus = { state: "ready", access: "read", tenant: "contoso" };
const SITES: SharePointBrowserPage = {
  items: [
    { value: "site:eng", title: "Engineering", icon: "site", navigable: true, subtitle: "/sites/engineering" },
    { value: "site:legal", title: "Legal", icon: "site", navigable: true },
    { value: "file:d/report", title: "Report.docx", icon: "document", meta: "Oct 3" },
  ],
};
const ENGINEERING: SharePointBrowserPage = {
  items: [
    { value: "drive:docs", title: "Documents", icon: "library", navigable: true },
    { value: "list:eng/issues", title: "Issues", icon: "list" },
  ],
};
/** More rows than the listing shows at its tallest, so it scrolls. */
const LONG: SharePointBrowserPage = {
  items: Array.from({ length: 20 }, (_, index) => ({ value: `file:d/${index + 1}`, title: `Row ${index + 1}` })),
};
const ALL = "All of SharePoint & OneDrive";

/** The frame re-renders a moment after each reply or key, so every reading of it is polled. */
const poll = <T>(read: () => Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });
const visible = async (node: Locator) => (await node.innerText()).replace(/\s+/g, " ").trim();

/**
 * Starts the frame. `getStatus` answers ready, and `locate` answers `located`; every `loadItems`
 * waits for the test to answer it with `respond` or `fail`.
 */
async function start({ located, initialResource }: { located?: SharePointLocated; initialResource?: string } = {}) {
  const hosted = await startFrame("sharepoint", {
    answers: { getStatus: () => READY, locate: () => located ?? null },
    initialResource,
  });
  const { frame, page, callsOf } = hosted;
  const loads = () => callsOf("loadItems");
  await vi.waitFor(() => {
    if (loads().length === 0) throw new Error("the picker has not asked for its first listing");
  });
  const list = () => frame().locator("#sp-list");
  /** Once nothing in the picker is still loading. */
  const settled = () => poll(() => frame().locator(".browser-skeleton, .browser-more.busy").count()).toBe(0);
  /** The `loadItems` call waiting for an answer, once there is one: the frame asks a moment after it re-renders. */
  const pending = async (index: number | undefined) => {
    if (index !== undefined) return loads()[index]!;
    await vi.waitFor(() => {
      if (hosted.waiting("loadItems").length === 0) throw new Error("no listing is waiting for an answer");
    });
    return hosted.waiting("loadItems").at(-1)!;
  };
  const picker = {
    ...hosted,
    /** What the picker asked `loadItems` for, in order. */
    requests: () => loads().map(call => call.args[0]),
    /** Answers the waiting listing, or the `index`th one asked for. */
    async respond(reply: SharePointBrowserPage, index?: number) {
      (await pending(index)).resolve(reply);
      await settled();
    },
    async fail(message: string, index?: number) {
      (await pending(index)).reject(message);
      await settled();
    },
    list,
    /** The listing's rows by accessible name. */
    rows: () => list().getByRole("radio").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))),
    row: (name: string) => frame().getByRole("radio", { name, exact: true }),
    /** The focused row's name, or the `data-sp-focus` id of anything else focused. */
    focused: () => frame().evaluate(() => {
      const { document } = globalThis as unknown as { document: { activeElement: { getAttribute(name: string): string | null } | null } };
      const active = document.activeElement;
      return active?.getAttribute(active.getAttribute("role") === "radio" ? "aria-label" : "data-sp-focus") ?? null;
    }),
    announced: async () => (await frame().locator("#sp-announcer").allTextContents())[0]?.trim() ?? null,
    search: () => frame().getByRole("searchbox"),
    /** Types `text` as one edit, as pasting does. */
    type: (text: string) => frame().getByRole("searchbox").fill(text),
    /** Presses `key` on whatever is focused. */
    press: (key: string) => page.keyboard.press(key),
    crumbs: () => frame().getByRole("navigation", { name: "Location" }).locator(".browser-crumb").allInnerTexts(),
    selectedTab: () => frame().getByRole("tab", { selected: true }).innerText(),
    location: () => frame().locator('[aria-current="location"]').innerText(),
    summary: () => visible(frame().locator(".browser-summary")),
    /** The ref the frame asks the gatekeeper to bind, answered so the collection completes. */
    async collected(): Promise<unknown> {
      const ref = await hosted.collected();
      for (const call of hosted.waiting("resourceUrlFor")) call.resolve(`https://contoso.sharepoint.com/${String(ref)}`);
      return ref;
    },
  };
  return picker;
}

type Picker = Awaited<ReturnType<typeof start>>;

async function openEngineering(picker: Picker) {
  await picker.respond(SITES);
  await picker.row("Engineering").focus();
  await picker.row("Engineering").click();
  await picker.respond(ENGINEERING);
}

/**
 * Whether each keydown since was consumed. Captured before the picker sees the key and read once the
 * dispatch is over, since the picker stops a consumed Escape from propagating any further.
 */
async function watchKeys(picker: Picker) {
  await picker.frame().evaluate(() => {
    const frameWindow = globalThis as unknown as {
      consumed: boolean[];
      setTimeout(callback: () => void): void;
      addEventListener(type: string, listener: (event: { defaultPrevented: boolean }) => void, capture: boolean): void;
    };
    frameWindow.consumed = [];
    frameWindow.addEventListener("keydown", event => frameWindow.setTimeout(() => frameWindow.consumed.push(event.defaultPrevented)), true);
  });
  return () => picker.frame().evaluate(() => (globalThis as unknown as { consumed: boolean[] }).consumed);
}

describe("the SharePoint configurator frame", () => {
  it("opens on everything, listing the Sites tab's root once, with placeholders until it arrives", async () => {
    const picker = await start();
    expect(picker.requests()).toEqual([{ tab: "sites" }]);
    expect(await picker.list().getAttribute("aria-busy")).toBe("true");
    expect(await picker.frame().locator(".browser-skeleton").count()).toBeGreaterThan(0);
    expect(await picker.row(ALL).getAttribute("aria-checked")).toBe("true");
    expect(await picker.summary()).toBe(
      "All of SharePoint & OneDrive: every site, library, list and file you can open, including ones you get access to later. Read only.");

    await picker.respond(SITES);
    await poll(picker.rows).toEqual(["Engineering", "Legal", "Report.docx"]);
    expect(await picker.row("Engineering").getAttribute("aria-description")).toBe("/sites/engineering. Has items. Press Right Arrow to open");
    expect(await picker.frame().getByRole("radiogroup", { name: "What to connect" }).count()).toBe(1);
    expect(picker.requests()).toHaveLength(1);
    expect(await picker.collected()).toBe("all");
  });

  it("opens a place, focuses its first row, and returns focus to it on the way back up", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.row("Engineering").focus();
    await picker.row("Engineering").click();
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng" });
    // The place's own row is there before its contents, so focus need not wait for them.
    await poll(picker.focused).toBe("All of Engineering");

    await picker.respond(ENGINEERING);
    await poll(picker.rows).toEqual(["All of Engineering", "Documents", "Issues"]);
    expect(await picker.focused()).toBe("All of Engineering");
    await poll(picker.announced).toBe("Opened Engineering, 2 items");
    expect(await picker.frame().getByRole("button", { name: "Back to Sites" }).count()).toBe(1);
    expect(await picker.location()).toBe("Engineering");

    await picker.press("ArrowLeft");
    await poll(picker.rows).toEqual(["Engineering", "Legal", "Report.docx"]);
    expect(picker.requests()).toHaveLength(2);
    await poll(picker.focused).toBe("Engineering");
  });

  it("goes up with the breadcrumb and the back button", async () => {
    const picker = await start();
    await openEngineering(picker);
    await picker.row("Documents").click();
    await picker.respond({ items: [{ value: "file:docs/spec", title: "Spec.docx" }] });
    await poll(() => picker.frame().getByRole("button", { name: "Back to Engineering" }).count()).toBe(1);
    expect(await picker.crumbs()).toEqual(["Sites", "Engineering", "Documents"]);

    const root = picker.frame().getByRole("navigation", { name: "Location" }).getByRole("button", { name: "Sites" });
    await root.focus();
    await root.click();
    await poll(picker.focused).toBe("Engineering");

    await picker.row("Engineering").click();
    await picker.respond(ENGINEERING);
    await picker.frame().getByRole("button", { name: "Back to Sites" }).click();
    await poll(picker.rows).toEqual(["Engineering", "Legal", "Report.docx"]);
  });

  it("remembers each tab's place and switches tabs with the arrow keys", async () => {
    const picker = await start();
    await openEngineering(picker);
    const sites = picker.frame().getByRole("tab", { selected: true });
    expect(await sites.innerText()).toBe("Sites");
    await sites.focus();
    await picker.press("ArrowRight");
    await poll(picker.selectedTab).toBe("OneDrive");
    await poll(picker.focused).toBe("tab:onedrive");
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "onedrive" });
    await picker.respond({ items: [{ value: "drive:me", title: "My files", icon: "onedrive", navigable: true }] });
    await poll(picker.rows).toEqual(["My files"]);

    await picker.press("ArrowLeft");
    await poll(picker.location).toBe("Engineering");
    expect(picker.requests()).toHaveLength(3);
    expect(await picker.rows()).toEqual(["All of Engineering", "Documents", "Issues"]);
  });

  it("chooses a row by its radio, the open place by its All of row, and everything by the All row", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.row("Engineering").locator(".browser-radio-hit").click();
    await poll(() => picker.row("Engineering").getAttribute("aria-checked")).toBe("true");
    expect(picker.requests()).toHaveLength(1);
    expect(await picker.row(ALL).getAttribute("aria-checked")).toBe("false");
    expect(await picker.announced()).toBe("Chose Engineering");
    expect(await picker.summary()).toBe(
      "Engineering: the site’s libraries, lists and pages, including anything added later. Not its subsites. Read only.");
    expect(await picker.collected()).toBe("site:eng");

    await picker.row("Legal").click();
    await picker.respond({ items: [] });
    await poll(picker.rows).toEqual(["All of Legal"]);
    expect(await picker.text()).toContain("Nothing here yet");
    await picker.row("All of Legal").press("Space");
    await poll(() => picker.row("All of Legal").getAttribute("aria-checked")).toBe("true");
    expect(await picker.collected()).toBe("site:legal");

    await picker.row(ALL).click();
    await poll(() => picker.row(ALL).getAttribute("aria-checked")).toBe("true");
    expect(await picker.row("All of Legal").getAttribute("aria-checked")).toBe("false");
    expect(await picker.collected()).toBe("all");
  });

  it("refuses a row that can't be chosen, with its reason, but still opens it", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.row("Engineering").click();
    await picker.respond({
      items: [{
        value: "pages:eng", title: "Site Pages", icon: "pages", navigable: true, subtitle: "Open to choose a page",
        selectable: false, unselectableReason: "Choose one page. To include every page, choose the whole site instead.",
      }],
    });
    const pages = picker.row("Site Pages");
    await poll(() => pages.getAttribute("aria-disabled")).toBe("true");
    expect(await pages.locator(".browser-row-subtitle").innerText()).toBe("Open to choose a page");
    expect(await pages.locator(".browser-radio").count()).toBe(0);
    // Playwright will not act on an aria-disabled row, so the keys and the click are sent regardless.
    await pages.focus();
    await picker.press("Space");
    await poll(picker.announced).toBe("Can't choose Site Pages. Choose one page. To include every page, choose the whole site instead.");
    expect(await picker.collected()).toBe("all");

    await pages.focus();
    await pages.click({ force: true });
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "pages:eng" });
    // With no row to land on yet, focus waits on the listing.
    await poll(picker.focused).toBe("list");
    await picker.respond({ items: [{ value: "page:eng/home", title: "Home", icon: "page" }] });
    await poll(picker.rows).toEqual(["Home"]);
    await poll(picker.focused).toBe("Home");
    expect(await picker.frame().locator(".browser-place-reason").innerText())
      .toBe("Choose one page. To include every page, choose the whole site instead.");
  });

  it("shows an error in place of the rows and retries just that place", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.row("Engineering").click();
    await picker.fail("You can't open this site anymore.");
    await poll(() => visible(picker.frame().locator(".browser-state")))
      .toBe("Couldn't open Engineering You can't open this site anymore. Try again");
    expect(await picker.announced()).toBe("Couldn't open Engineering. You can't open this site anymore.");

    const retry = picker.frame().getByRole("button", { name: "Try again" });
    await retry.focus();
    await retry.click();
    await poll(async () => picker.requests().slice(1))
      .toEqual([{ tab: "sites", container: "site:eng" }, { tab: "sites", container: "site:eng" }]);
    await picker.respond(ENGINEERING);
    await poll(picker.rows).toEqual(["All of Engineering", "Documents", "Issues"]);
    await poll(picker.focused).toBe("All of Engineering");
  });

  it("loads more on request, appending the page and moving focus to its first row", async () => {
    const picker = await start();
    await picker.respond({ ...SITES, nextPageToken: "from:3", notice: "Some sites are hidden." });
    await poll(() => picker.frame().locator(".browser-notice").innerText()).toBe("Some sites are hidden.");
    expect(await picker.frame().locator(".browser-count").innerText()).toBe("3 or more items");
    const more = picker.frame().locator('[data-sp-focus="more"]');
    expect(await more.innerText()).toBe("Show more");
    await more.focus();
    await more.click();
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", pageToken: "from:3" });
    await poll(() => more.getAttribute("aria-disabled")).toBe("true");
    expect(await picker.focused()).toBe("more");

    await picker.respond({ items: [{ value: "site:hr", title: "HR", icon: "site", navigable: true }, SITES.items[0]!] });
    await poll(picker.rows).toEqual(["Engineering", "Legal", "Report.docx", "HR"]);
    expect(await more.count()).toBe(0);
    await poll(picker.focused).toBe("HR");
    expect(await picker.announced()).toBe("Showing 1 more");
  });
});

describe("searching the SharePoint picker", () => {
  it("waits for a pause in typing, searches at once on Enter, and drops a superseded search's late reply", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.type("en");
    expect(picker.requests()).toHaveLength(1);
    await poll(() => picker.frame().locator(".browser-search").getAttribute("class")).toContain("busy");
    // In real time: the picker waits SEARCH_DELAY_MS for the typing to pause.
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", query: "en" });
    await poll(() => picker.frame().locator(".browser-scope").innerText()).toBe("Searching all of Sites…");

    await picker.type(" eng ");
    await picker.search().press("Enter");
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", query: "eng" });
    expect(await picker.focused()).toBe("search");

    await picker.respond({ items: [{ value: "site:eng", title: "Engineering", icon: "site", navigable: true, path: [] }] }, 2);
    await picker.respond({ items: [{ value: "site:late", title: "Late reply" }] }, 1);
    await poll(picker.rows).toEqual(["Engineering"]);
    expect(await picker.frame().locator(".browser-scope").innerText()).toBe("Results in all of Sites");
    expect(await picker.list().locator(".browser-row-subtitle").first().innerText()).toBe("Sites");
    expect(await picker.announced()).toBe("1 result");
  });

  it("searches the open place and offers to widen a search that found nothing", async () => {
    const picker = await start();
    await openEngineering(picker);
    await picker.type("zzz");
    await picker.search().press("Enter");
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng", query: "zzz" });
    await picker.respond({ items: [] });
    await poll(() => visible(picker.frame().locator(".browser-state")))
      .toBe("No results for “zzz” Only Engineering was searched. Search all of Sites");
    expect(await picker.announced()).toBe("No results for “zzz”");

    await picker.frame().getByRole("button", { name: "Search all of Sites" }).click();
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", query: "zzz" });
  });

  it("looks up a pasted link, shows where the result lives, and opens it with its breadcrumb", async () => {
    const picker = await start();
    await picker.respond(SITES);
    const link = "https://contoso.sharepoint.com/sites/eng/Shared%20Documents/Specs";
    await picker.type(link);
    await picker.search().press("Enter");
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", query: link });
    await poll(() => picker.frame().locator(".browser-scope").innerText()).toBe("Looking up link…");
    await picker.respond({
      items: [{
        value: "folder:docs/specs", title: "Specs", icon: "folder", navigable: true,
        path: [{ value: "site:eng", title: "Engineering", icon: "site" }, { value: "drive:docs", title: "Documents", icon: "library" }],
      }],
    });
    await poll(() => picker.list().locator(".browser-row-subtitle").first().innerText()).toBe("Engineering › Documents");
    await picker.row("Specs").locator(".browser-radio-hit").click();
    expect(await picker.collected()).toBe("folder:docs/specs");

    await picker.row("Specs").click();
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "folder:docs/specs" });
    await poll(() => picker.search().inputValue()).toBe("");
    expect(await picker.crumbs()).toEqual(["Sites", "Engineering", "Documents", "Specs"]);
  });

  it("clears the search on Escape, and leaves a second Escape to the host", async () => {
    const picker = await start();
    await picker.respond(SITES);
    const consumed = await watchKeys(picker);
    await picker.type("eng");
    await picker.search().press("Enter");
    await picker.respond({ items: [] });
    await picker.search().press("Escape");
    // Enter was consumed too, by the search.
    await poll(consumed).toEqual([true, true]);
    expect(await picker.search().inputValue()).toBe("");
    expect(await picker.rows()).toEqual(["Engineering", "Legal", "Report.docx"]);
    expect(await picker.focused()).toBe("search");
    await picker.search().press("Escape");
    await poll(consumed).toEqual([true, true, false]);
  });

  it("keeps only the listings the open places and the current search need", async () => {
    const picker = await start();
    await openEngineering(picker);
    for (const query of ["a", "b"]) {
      await picker.type(query);
      await picker.search().press("Enter");
      await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng", query });
      await picker.respond({ items: [] });
    }
    await picker.search().press("Escape");
    await poll(picker.rows).toEqual(["All of Engineering", "Documents", "Issues"]);
    // Engineering and the root were kept; the searches were not.
    expect(picker.requests()).toHaveLength(4);
    await picker.type("a");
    await picker.search().press("Enter");
    await poll(async () => picker.requests().length).toBe(5);
    // Nor was a place the picker has gone back up from.
    await picker.search().press("Escape");
    await picker.frame().getByRole("button", { name: "Back to Sites" }).click();
    await picker.row("Engineering").click();
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "site:eng" });
    expect(picker.requests()).toHaveLength(6);
  });
});

describe("the SharePoint picker's keyboard and focus", () => {
  it("keeps one tab stop and moves with the arrows, Home, End and type-ahead", async () => {
    const picker = await start();
    await picker.respond({ items: [...SITES.items, { value: "site:labs", title: "Labs", icon: "site", navigable: true }] });
    const stops = () => picker.list().locator('[tabindex="0"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
    await poll(stops).toEqual(["Engineering"]);

    await picker.row("Engineering").focus();
    await picker.press("ArrowDown");
    await poll(picker.focused).toBe("Legal");
    expect(await stops()).toEqual(["Legal"]);
    await picker.press("End");
    await poll(picker.focused).toBe("Labs");
    await picker.press("Home");
    await poll(picker.focused).toBe("Engineering");
    await picker.press("l");
    await poll(picker.focused).toBe("Legal");
    await picker.press("l");
    await poll(picker.focused).toBe("Labs");
    // Once the type-ahead has lapsed, the next letter starts a new prefix.
    await new Promise(resolve => setTimeout(resolve, 750));
    await picker.press("r");
    await poll(picker.focused).toBe("Report.docx");
  });

  it("opens with Enter and Right, chooses with Enter on a file and with Space, and keeps focus through the re-render", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.row("Engineering").focus();
    await picker.press("Enter");
    await picker.respond(ENGINEERING);
    await poll(picker.focused).toBe("All of Engineering");
    await picker.press("Backspace");
    await poll(picker.focused).toBe("Engineering");

    await picker.row("Report.docx").focus();
    await picker.press("Enter");
    await poll(() => picker.row("Report.docx").getAttribute("aria-checked")).toBe("true");
    expect(await picker.collected()).toBe("file:d/report");
    expect(await picker.focused()).toBe("Report.docx");

    await picker.row("Legal").focus();
    await picker.press("Space");
    await poll(() => picker.row("Legal").getAttribute("aria-checked")).toBe("true");
    expect(await picker.collected()).toBe("site:legal");
    expect(await picker.focused()).toBe("Legal");
    await picker.press("ArrowRight");
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "site:legal" });
  });

  it("jumps to the search box on slash, and back to the rows on ArrowDown", async () => {
    const picker = await start();
    await picker.respond(SITES);
    await picker.row("Legal").focus();
    await picker.press("ArrowDown");
    await poll(picker.focused).toBe("Report.docx");
    await picker.press("/");
    await poll(picker.focused).toBe("search");
    // Consumed on the way: the slash itself was not typed into the box.
    expect(await picker.search().inputValue()).toBe("");
    await picker.press("ArrowDown");
    await poll(picker.focused).toBe("Report.docx");
  });

  it("keeps the listing scrolled where it was as a choice re-renders it", async () => {
    const picker = await start();
    await picker.respond(LONG);
    await poll(() => picker.list().evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await picker.list().evaluate(node => { node.scrollTop = 120; });
    await picker.row("Row 5").click();
    await poll(() => picker.row("Row 5").getAttribute("aria-checked")).toBe("true");
    expect(await picker.list().evaluate(node => node.scrollTop)).toBe(120);
  });

  it("folds a deep breadcrumb's middle into a menu of the places it hides", async () => {
    const path = ["One", "Two", "Three", "Four"].map(title => ({ value: `folder:d/${title}`, title, icon: "folder" as const }));
    const picker = await start({
      initialResource: "https://contoso.sharepoint.com/x",
      located: { ref: "folder:d/Four", title: "Four", tab: "sites", path: path.slice(0, 3) },
    });
    // Opening on the chosen folder's parent: Three.
    expect(picker.requests()).toEqual([{ tab: "sites", container: "folder:d/Three" }]);
    await picker.respond({ items: [{ value: "folder:d/Four", title: "Four", icon: "folder", navigable: true }] });
    await poll(picker.rows).toEqual(["All of Three", "Four"]);
    expect(await picker.frame().locator(".browser-crumb-more").count()).toBe(0);
    await picker.row("Four").click();
    await picker.respond({ items: [] });
    const more = picker.frame().getByRole("button", { name: "Show 2 more places" });
    await poll(() => more.getAttribute("title")).toBe("One › Two");
    expect(await picker.frame().locator(".browser-crumbs > :not(.browser-crumb-separator)").allInnerTexts())
      .toEqual(["Sites", "…", "Three", "Four"]);

    await more.focus();
    await more.click();
    await poll(() => more.getAttribute("aria-expanded")).toBe("true");
    expect(await picker.frame().getByRole("menuitem").allInnerTexts()).toEqual(["One", "Two"]);
    await poll(picker.focused).toBe("menu:1");
    await picker.press("ArrowDown");
    await poll(picker.focused).toBe("menu:2");
    await picker.press("Escape");
    await poll(() => picker.frame().getByRole("menu").count()).toBe(0);
    expect(await picker.focused()).toBe("crumb-more");

    await more.click();
    await picker.frame().getByRole("menuitem", { name: "One" }).click();
    await poll(async () => picker.requests().at(-1)).toEqual({ tab: "sites", container: "folder:d/One" });
  });
});

describe("editing a SharePoint binding", () => {
  it("asks the user to choose when the resource it opened with can't be found, rather than binding everything", async () => {
    const gone = "https://contoso.sharepoint.com/sites/gone";
    const picker = await start({ initialResource: gone });
    expect(picker.requests()).toEqual([{ tab: "sites" }]);
    // The visible notice; the runtime also mirrors its text into a live region.
    const notice = picker.frame().locator("[data-configurator-info-notice]", { hasText: `Couldn't find ${gone} in SharePoint. Choose what to connect.` });
    await poll(() => notice.count()).toBe(1);
    expect(await picker.row(ALL).getAttribute("aria-checked")).toBe("false");
    await poll(async () => (await picker.state()).ready).toBe(false);
    expect(await picker.collect()).toHaveProperty("error");

    await picker.respond(SITES);
    await picker.row("Engineering").locator(".browser-radio-hit").click();
    await poll(() => picker.row("Engineering").getAttribute("aria-checked")).toBe("true");
    await poll(async () => (await picker.state()).ready).toBe(true);
    expect(await notice.count()).toBe(0);
    expect(await picker.collected()).toBe("site:eng");
  });

  it("opens where the bound item is, makes it the tab stop, and offers to show it once the user has moved", async () => {
    const picker = await start({
      initialResource: "https://contoso-my.sharepoint.com/personal/me/Documents/Projects/Two.docx",
      located: { ref: "file:me/two", title: "Two.docx", tab: "onedrive", path: [{ value: "folder:me/projects", title: "Projects", icon: "folder" }] },
    });
    expect(picker.requests()).toEqual([{ tab: "onedrive", container: "folder:me/projects" }]);
    expect(await picker.selectedTab()).toBe("OneDrive");
    expect(await picker.location()).toBe("Projects");
    await picker.respond({ items: [{ value: "file:me/one", title: "One.docx" }, { value: "file:me/two", title: "Two.docx" }] });
    await poll(() => picker.row("Two.docx").getAttribute("aria-checked")).toBe("true");
    expect(await picker.row("Two.docx").getAttribute("tabindex")).toBe("0");
    expect(await picker.summary()).toBe("Two.docx: just this file. Read only.");

    await picker.frame().getByRole("button", { name: "Back to OneDrive" }).click();
    await picker.respond({ items: [] });
    await poll(() => visible(picker.frame().locator(".browser-chosen-label"))).toBe("Chosen: Two.docx");
    const show = picker.frame().getByRole("button", { name: "Show Two.docx" });
    await show.focus();
    await show.click();
    await picker.respond({ items: [{ value: "file:me/one", title: "One.docx" }, { value: "file:me/two", title: "Two.docx" }] });
    await poll(picker.location).toBe("Projects");
    await poll(picker.focused).toBe("Two.docx");
    expect(await picker.frame().locator(".browser-chosen").count()).toBe(0);
    expect(await picker.collected()).toBe("file:me/two");
  });
});
