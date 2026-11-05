// Observers against the live tenant, with real sharing: a collaborator is admitted only if their own
// account can open everything the workspace has read, and is left out of each later read they could
// not open themselves. Every probe runs as the collaborator, never as the owner.

import { describe, expect, it } from "vitest";
import type { DriveEntry } from "../../src/types";
import { bind, connect, failure, facet, hooks, live, oneDrive, origin, run, unwrap, walk } from "./tenant";

const REFUSED = /can't open something in SharePoint that this workspace has read/;

describe.skipIf(!live)("observers", () => {
  it("each verifier answers for its own account, in the shared tenant", async () => {
    for (const label of ["phillip", "sarah", "bob"] as const) {
      const identity = unwrap<{ tenantId: string } | null>(await hooks().verifier(await connect(label), "getIdentity"));
      expect(identity?.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("admits a member of a private site and refuses someone who isn't", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Engineering/Shared%20Documents/Specs`);
    const name = facet("obs-private-site");
    await walk<DriveEntry>(name, props, [["list"]]);
    unwrap(await hooks().addObserver(name, props, "sarah", await connect("sarah")));
    expect(failure(await hooks().addObserver(name, props, "bob", await connect("bob")))).toMatch(REFUSED);
  });

  it("leaves an admitted visitor out of a folder only the owner can open", async () => {
    const base = await origin();
    const props = await bind("phillip", `${base}/sites/Marketing/Shared%20Documents`);
    const name = facet("obs-broken-inheritance");
    const top = await walk<DriveEntry>(name, props, [["list"]]);
    const launch = top.find(entry => entry.name === "Launch")!;
    const confidential = top.find(entry => entry.name === "Confidential")!;
    // Phillip's listing of the library named Confidential, which Bob can't open: Bob is refused
    // until a fresh binding has read only what he can open.
    expect(failure(await hooks().addObserver(name, props, "bob", await connect("bob")))).toMatch(REFUSED);

    const fresh = facet("obs-broken-inheritance-fresh");
    await walk<DriveEntry>(fresh, props, [["list", { folderId: launch.id }]]);
    unwrap(await hooks().addObserver(fresh, props, "bob", await connect("bob")));
    await walk<DriveEntry>(fresh, props, [["list", { folderId: confidential.id }]]);
    const log = await hooks().queueLog(fresh);
    const last = log.observations.at(-1)!;
    expect(last.description).toContain("Confidential");
    expect(last.excludeObservers).toEqual(["bob"]);
    // Launch, which Bob can open, was shared with him.
    expect(log.observations.find(observation => observation.description.includes("Launch"))?.excludeObservers).toBeUndefined();
  });

  it("shares a page's unpublished draft only with those shown the same draft", async () => {
    const base = await origin();
    const phillip = await connect("phillip");
    const url = `${base}/sites/Marketing/SitePages/Launch-Plan.aspx`;
    const page = unwrap<{ scope: { siteId: string; pageId: string } }>(await hooks().resolve(phillip, url)).scope;
    // An unpublished edit: Phillip, who can edit, now sees a draft; Bob, a visitor, the published page.
    unwrap(await hooks().graph(phillip, "PATCH", `/sites/${page.siteId}/pages/${page.pageId}/microsoft.graph.sitePage`,
      { "@odata.type": "#microsoft.graph.sitePage", description: `Contract draft ${Date.now()}` }));
    const props = await bind("phillip", url);

    const admitted = facet("obs-draft-admitted");
    unwrap(await hooks().addObserver(admitted, props, "bob", await connect("bob")));
    unwrap(await run(admitted, props, [["readPage"]]));
    const read = (await hooks().queueLog(admitted)).observations.at(-1)!;
    expect(read.description).toContain("Launch Plan");
    expect(read.excludeObservers).toEqual(["bob"]);

    const fresh = facet("obs-draft-fresh");
    unwrap(await run(fresh, props, [["readPage"]]));
    expect(failure(await hooks().addObserver(fresh, props, "bob", await connect("bob")))).toMatch(REFUSED);
  });

  it("follows a OneDrive share: the shared folder admits its recipient, the private one does not", async () => {
    const drive = await oneDrive();
    const props = await bind("phillip", `${await origin()}/_layouts/15/sharepoint.aspx`);
    const name = facet("obs-onedrive");
    const apollo = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${drive}/Documents/GadgetsSpike/Apollo`]]));
    await walk<DriveEntry>(name, props, [["list", { folderId: apollo.id }]]);
    unwrap(await hooks().addObserver(name, props, "sarah", await connect("sarah")));
    expect(failure(await hooks().addObserver(name, props, "bob", await connect("bob")))).toMatch(REFUSED);

    const secret = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${drive}/Documents/GadgetsSpike/Private/secret.txt`]]));
    unwrap(await run(name, props, [["readFile", secret.id]]));
    const last = (await hooks().queueLog(name)).observations.at(-1)!;
    expect(last.description).toContain("secret\\.txt");
    expect(last.excludeObservers).toEqual(["sarah"]);
  });
});
