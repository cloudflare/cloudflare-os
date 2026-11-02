// The Confluence configurator frame as the Workshop hosts it, in Chromium: the journeys a user takes
// through its picker, with the gatekeeper capability faked from ./fixtures. Needs the generated
// frame (`build:configurator`, which `test:run` runs first).

import { describe, expect, it, vi } from "vitest";
import type { ConfluenceBrowseRequest, ConfluenceConfiguratorStatus, ConfluenceNode } from "../src/configurator/confluence-configurator-types";
import { browse, ENGINEERING, MFS, READY, SEARCH_ARCH, SITE_REF, spaceAvatars } from "./fixtures";
import { PATTERNS, startFrame, useFrameHost, type Answer } from "./frame-host";

useFrameHost();

const CLOUD = "5c121664-a643-497d-99b3-25e02a81f02f";
const ENGINEERING_REF = `page:${CLOUD}/458753`;

/** 25 spaces from `from` on: one page of a long list. */
const many = (from: number): ConfluenceNode[] => Array.from({ length: 25 }, (_, index) => ({
  ref: `space:${CLOUD}/S${from + index}`, kind: "space", title: `Space ${from + index}`,
  expandable: true, selectable: true,
}));

/** The frame re-renders a moment after each reply or key, so every reading of it is polled. */
const poll = <T>(read: () => Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

async function start(options: { answers?: Record<string, Answer>; initialResource?: string; patterns?: string[] } = {}) {
  const hosted = await startFrame({
    ...options,
    answers: { getStatus: () => READY, loadItems: browse, locate: () => null, spaceAvatars, ...options.answers },
  });
  const frame = hosted.frame;
  const option = (title: string) => frame().getByRole("option").filter({ has: frame().getByText(title, { exact: true }) });
  return {
    ...hosted,
    option,
    tab: (name: string) => frame().getByRole("tab", { name }),
    wholeSite: () => frame().getByRole("button", { name: /^All of / }),
    search: () => frame().getByRole("searchbox"),
    /** The listing's rows: each one's title, then its second line. */
    rows: () => frame().getByRole("option").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.split("\n").slice(0, 2).join(" — "))),
    titles: () => frame().getByRole("option").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.split("\n")[0])),
    /** The chosen row's title, or the whole-site card's; empty when nothing is chosen. */
    chosen: () => frame().locator("[role=option][aria-selected=true], [aria-pressed=true]")
      .evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.split("\n")[0])),
    /** The breadcrumb, from the open tab down. */
    location: async () => (await frame().getByRole("navigation", { name: "Location" }).innerText()).replace(/\s+/g, " ").trim(),
    requests: () => hosted.callsOf("loadItems").map(call => call.args[0] as ConfluenceBrowseRequest),
  };
}

describe("the tabs", () => {
  it("opens on recently viewed pages, saying where each lives, with Starred and Spaces a tab away", async () => {
    const picker = await start();
    await poll(picker.rows).toEqual([
      "Architecture — My first space / Engineering",
      "Q4 planning — My first space",
      "Shipping the new editor — My first space / Blog",
    ]);
    expect(await picker.tab("Recent").getAttribute("aria-selected")).toBe("true");

    await picker.tab("Starred").click();
    await poll(picker.rows).toEqual(["My first space — MFS", "Architecture — My first space / Engineering"]);
    await picker.tab("Spaces").click();
    await poll(picker.titles).toEqual(["My first space", "Team Handbook", "Phillip Jones"]);
    expect(picker.requests().map(request => request.section)).toEqual(["recent", "starred", "spaces"]);
  });

  it("draws each tab's icon and each space's own icon once it arrives, keeping initials for one without", async () => {
    const picker = await start();
    await poll(() => picker.tab("Starred").locator("svg").count()).toBe(1);
    await picker.tab("Spaces").click();
    await poll(() => picker.option("Team Handbook").locator(".cf-avatar img").count()).toBe(1);
    expect(await picker.option("My first space").locator(".cf-avatar img").count()).toBe(1);
    expect(await picker.option("Phillip Jones").locator(".cf-avatar").count()).toBe(0);
    expect(picker.callsOf("spaceAvatars").flatMap(call => call.args[0] as string[])).toContain(MFS.ref);
  });

  it("says what an empty tab is for", async () => {
    const picker = await start({ answers: { loadItems: (request: ConfluenceBrowseRequest) => request.section === "starred" ? { items: [] } : browse(request) } });
    await picker.tab("Starred").click();
    await poll(picker.text).toContain("Spaces, pages and blog posts you star in Confluence show here.");
  });

  it("offers Retry when a tab can't be listed", async () => {
    let failing = true;
    const picker = await start({
      answers: {
        loadItems: (request: ConfluenceBrowseRequest) => {
          if (request.section === "spaces" && failing) throw new Error("Confluence is down.");
          return browse(request);
        },
      },
    });
    await picker.tab("Spaces").click();
    await poll(picker.text).toContain("Confluence is down.");
    failing = false;
    await picker.frame().getByRole("button", { name: "Retry" }).click();
    await poll(picker.titles).toContain("Team Handbook");
  });

  it("pages through a long list of spaces", async () => {
    const picker = await start({
      answers: {
        loadItems: (request: ConfluenceBrowseRequest) => request.section === "spaces"
          ? request.cursor ? { items: many(25) } : { items: many(0), nextCursor: "next" }
          : { items: [] },
      },
    });
    await picker.tab("Spaces").click();
    await poll(async () => (await picker.titles()).length).toBe(25);
    // Scrolling to the end loads the next page, as the Load more button there does.
    await picker.frame().getByRole("listbox").evaluate(list => { list.parentElement!.scrollTop = list.parentElement!.scrollHeight; });
    await poll(async () => (await picker.titles()).length).toBe(50);
    expect(picker.requests().filter(request => request.section === "spaces").at(-1)).toMatchObject({ cursor: "next" });
  });
});

describe("choosing", () => {
  it("binds the whole site from the card above the tabs", async () => {
    const picker = await start();
    await picker.wholeSite().click();
    await poll(picker.chosen).toEqual(["All of Slew"]);
    await poll(async () => (await picker.state()).ready).toBe(true);
    expect(await picker.collected()).toBe(SITE_REF);
  });

  it("chooses a recent page, and opens one that has child pages where it lives", async () => {
    const picker = await start();
    await picker.option("Q4 planning").click();
    await poll(picker.chosen).toEqual(["Q4 planning"]);
    expect(await picker.collected()).toBe(`page:${CLOUD}/589825`);

    await picker.option("Architecture").click();
    await poll(picker.location).toBe("Spaces My first space Engineering Architecture");
    expect(await picker.tab("Spaces").getAttribute("aria-selected")).toBe("true");
    await poll(picker.titles).toEqual(["All of Architecture", "Storage architecture", "Networking"]);
  });

  it("opens a space at its home page, blog and pages, and chooses it or a page in it", async () => {
    const picker = await start();
    await picker.tab("Spaces").click();
    await picker.option("My first space").click();
    await poll(picker.location).toBe("Spaces My first space");
    expect(await picker.titles()).toEqual([
      "All of My first space", "My first space", "Blog", "Engineering", "Onboarding", "Q4 planning",
      "Retro board", "Launch tracker", "Archive",
    ]);

    await picker.option("All of My first space").click();
    await poll(picker.chosen).toEqual(["All of My first space"]);
    expect(await picker.collected()).toBe(MFS.ref);

    await picker.option("Engineering").click();
    await picker.option("All of Engineering").click();
    await poll(picker.chosen).toEqual(["All of Engineering"]);
    expect(await picker.collected()).toBe(ENGINEERING_REF);
  });

  it("never chooses what can't be connected, and says why", async () => {
    const picker = await start();
    await picker.tab("Spaces").click();
    await picker.option("My first space").click();
    await poll(() => picker.option("Retro board").innerText()).toContain("Can't be connected yet.");
    expect(await picker.option("Retro board").getAttribute("aria-disabled")).toBe("true");

    await picker.option("Blog").click();
    await poll(picker.titles).toEqual(["Shipping the new editor", "Welcome to the team blog"]);
    expect(await picker.text()).toContain("Choose one post, or the whole space.");
    expect((await picker.state()).ready).not.toBe(true);
  });

  it("goes back by breadcrumb", async () => {
    const picker = await start();
    await picker.tab("Spaces").click();
    await picker.option("My first space").click();
    await picker.option("Engineering").click();
    await poll(picker.location).toBe("Spaces My first space Engineering");
    await picker.frame().getByRole("button", { name: "My first space", exact: true }).click();
    await poll(picker.titles).toContain("Onboarding");
  });
});

describe("search", () => {
  it("finds pages across the site, saying where each lives, and chooses one", async () => {
    const picker = await start();
    await picker.search().fill("arch");
    await poll(picker.rows).toEqual([
      "Architecture — Spaces / My first space / Engineering",
      "Storage architecture — Spaces / My first space / Engineering / Architecture",
    ]);
    expect(picker.requests().at(-1)).toEqual({ site: SITE_REF, query: "arch" });

    await picker.option("Storage architecture").click();
    await poll(picker.chosen).toEqual(["Storage architecture"]);
    expect(await picker.collected()).toBe(`page:${CLOUD}/524289`);
  });

  it("opens a container it found where it lives", async () => {
    const picker = await start({
      answers: {
        loadItems: (request: ConfluenceBrowseRequest) => request.query
          ? { items: SEARCH_ARCH.items.map(node => node.title === "Architecture" ? { ...node, expandable: true } : node) }
          : browse(request),
      },
    });
    await picker.search().fill("arch");
    await poll(picker.titles).toContain("Storage architecture");
    await picker.option("Architecture").click();
    await poll(picker.location).toBe("Spaces My first space Engineering Architecture");
    expect(await picker.tab("Spaces").getAttribute("aria-selected")).toBe("true");
  });

  it("points a pasted link to the site at the card above, or says this connection can't take it", async () => {
    const site: ConfluenceNode = { ref: SITE_REF, kind: "site", title: "Slew", expandable: true, selectable: true, path: [] };
    const answers = { loadItems: (request: ConfluenceBrowseRequest) => request.query ? { items: [site] } : browse(request) };
    const picker = await start({ answers });
    await picker.search().fill("https://slew.atlassian.net/wiki");
    await poll(picker.text).toContain("That link is to the whole site. Choose it above the tabs.");

    const pagesOnly = await start({ answers, patterns: [PATTERNS.page] });
    await pagesOnly.search().fill("https://slew.atlassian.net/wiki");
    await poll(pagesOnly.text).toContain("This connection needs a page or blog post.");
  });
});

describe("a resource URL that came with the frame", () => {
  const located: ConfluenceNode = {
    ...ENGINEERING.items[1]!, path: [{ ref: MFS.ref, title: MFS.title, kind: "space" }, { ref: ENGINEERING_REF, title: "Engineering", kind: "page" }],
  };

  it("opens where the bound page lives, with it chosen", async () => {
    const picker = await start({
      initialResource: "https://slew.atlassian.net/wiki/spaces/MFS/pages/327884",
      answers: { locate: () => located },
    });
    await poll(picker.location).toBe("Spaces My first space Engineering");
    await poll(() => picker.option("On-call runbook").getAttribute("aria-selected")).toBe("true");
    await poll(async () => (await picker.state()).ready).toBe(true);
  });

  it("chooses nothing when the connection can't open it, rather than the whole site", async () => {
    const picker = await start({ initialResource: "https://slew.atlassian.net/wiki/spaces/GONE" });
    await poll(picker.text).toContain("Couldn't find https://slew.atlassian.net/wiki/spaces/GONE");
    expect(await picker.wholeSite().getAttribute("aria-pressed")).toBe("false");
    expect((await picker.state()).ready).not.toBe(true);
  });

  it("keeps a choice made while a retried lookup was still running", async () => {
    // The first lookup fails; the retry is answered only once the user has chosen a page.
    const retry = Promise.withResolvers<ConfluenceNode>();
    let lookups = 0;
    const picker = await start({
      initialResource: "https://slew.atlassian.net/wiki",
      answers: { locate: () => { if (lookups++ === 0) throw new Error("Confluence is down."); return retry.promise; } },
    });
    await poll(picker.text).toContain("Couldn't look up https://slew.atlassian.net/wiki.");
    await picker.frame().getByRole("button", { name: "Try again" }).click();
    await picker.option("Q4 planning").click();
    await poll(picker.chosen).toEqual(["Q4 planning"]);
    retry.resolve({ ref: SITE_REF, kind: "site", title: "Slew", expandable: false, selectable: true, path: [] });
    await picker.page.waitForTimeout(300);
    expect(await picker.chosen()).toEqual(["Q4 planning"]);
    expect(await picker.collected()).toBe(`page:${CLOUD}/589825`);
  });

  it("tells a failed lookup from a missing page, and tries again on request", async () => {
    let failing = true;
    const picker = await start({
      initialResource: "https://slew.atlassian.net/wiki/spaces/MFS/pages/327884",
      answers: { locate: () => { if (failing) throw new Error("Confluence is down."); return located; } },
    });
    await poll(picker.text).toContain("Couldn't look up https://slew.atlassian.net/wiki/spaces/MFS/pages/327884. Confluence is down.");
    expect((await picker.state()).ready).not.toBe(true);
    failing = false;
    await picker.frame().getByRole("button", { name: "Try again" }).click();
    await poll(picker.location).toBe("Spaces My first space Engineering");
    await poll(() => picker.option("On-call runbook").getAttribute("aria-selected")).toBe("true");
    await poll(async () => (await picker.state()).ready).toBe(true);
  });
});

describe("a binding that takes only pages", () => {
  it("hides the whole site and lets spaces be opened but not chosen", async () => {
    const picker = await start({ patterns: [PATTERNS.page] });
    await poll(picker.titles).toContain("Q4 planning");
    expect(await picker.wholeSite().count()).toBe(0);
    await picker.tab("Spaces").click();
    await picker.option("My first space").click();
    await poll(picker.text).toContain("This connection needs a page or blog post.");
    expect(await picker.titles()).not.toContain("All of My first space");
    await picker.option("Q4 planning").click();
    await poll(async () => (await picker.state()).ready).toBe(true);
  });
});

describe("a connection to two sites", () => {
  const OTHER = "0d6e5c1a-0000-4000-8000-000000000000";
  const TWO: ConfluenceConfiguratorStatus = {
    state: "ready",
    sites: [...(READY as Extract<ConfluenceConfiguratorStatus, { state: "ready" }>).sites,
      { cloudId: OTHER, name: "Acme", host: "acme.atlassian.net", ref: `site:${OTHER}` }],
  };

  it("switches sites above the picker, which starts afresh on the other one", async () => {
    const picker = await start({ answers: { getStatus: () => TWO } });
    await poll(() => picker.wholeSite().innerText()).toContain("All of Slew");
    await picker.option("Q4 planning").click();
    await poll(picker.chosen).toEqual(["Q4 planning"]);

    await picker.frame().getByRole("radio", { name: /Acme/ }).click();
    await poll(() => picker.wholeSite().innerText()).toContain("All of Acme");
    expect(picker.requests().at(-1)).toEqual({ site: `site:${OTHER}`, section: "recent" });
    expect(await picker.chosen()).toEqual([]);
    expect((await picker.state()).ready).not.toBe(true);
  });

  it("chooses a space pasted from the other site, switching there and opening it where it lives", async () => {
    const platform: ConfluenceNode = { ref: `space:${OTHER}/PLAT`, kind: "space", title: "Platform", expandable: true, selectable: true, path: [] };
    const picker = await start({
      answers: { getStatus: () => TWO, loadItems: (request: ConfluenceBrowseRequest) => request.query ? { items: [platform] } : browse(request) },
    });
    await picker.search().fill("https://acme.atlassian.net/wiki/spaces/PLAT");
    await picker.option("Platform").click();

    await poll(() => picker.wholeSite().innerText()).toContain("All of Acme");
    await poll(picker.location).toBe("Spaces Platform");
    await expect.poll(() => picker.frame().locator("[role=option][aria-selected=true]").innerText()).toContain("All of Platform");
    expect(await picker.collected()).toBe(platform.ref);
  });

  it("still opens a space pasted from the other site when only pages can be chosen", async () => {
    const platform: ConfluenceNode = { ref: `space:${OTHER}/PLAT`, kind: "space", title: "Platform", expandable: true, selectable: true, path: [] };
    const runbook: ConfluenceNode = { ref: `page:${OTHER}/7001`, kind: "page", title: "Runbook", expandable: false, selectable: true };
    const picker = await start({
      patterns: [PATTERNS.page],
      answers: {
        getStatus: () => TWO,
        loadItems: (request: ConfluenceBrowseRequest) => request.query ? { items: [platform] }
          : request.parent === platform.ref ? { items: [runbook] } : browse(request),
        // Chosen, the page switches the picker to its site, which looks it up to show where it lives.
        locate: () => ({ ...runbook, path: [{ ref: platform.ref, title: "Platform", kind: "space" }] }),
        resourceUrlFor: () => "https://acme.atlassian.net/wiki/spaces/PLAT/pages/7001",
      },
    });
    await picker.search().fill("https://acme.atlassian.net/wiki/spaces/PLAT");
    await picker.option("Platform").click();
    await picker.option("Runbook").click();
    await poll(picker.chosen).toEqual(["Runbook"]);
    expect(await picker.collected()).toBe(runbook.ref);
  });

  it("shows no switcher for one site", async () => {
    const picker = await start();
    await poll(picker.titles).toContain("Q4 planning");
    expect(await picker.frame().getByRole("radio").count()).toBe(0);
  });
});

describe("the frame", () => {
  it("logs nothing to the console on a whole journey", async () => {
    const picker = await start();
    await picker.tab("Spaces").click();
    await picker.option("My first space").click();
    await picker.option("Engineering").click();
    await picker.search().fill("arch");
    await poll(picker.titles).toContain("Storage architecture");
    await vi.waitFor(() => expect(picker.consoleErrors).toEqual([]));
  });
});
