// Observers against the live tenant, with real sharing: a collaborator may see what the workspace
// read only if their own account can open everything those reads reported. Every probe runs as the
// collaborator, never as the owner.

import { describe, expect, it } from "vitest";
import type { DriveEntry } from "../../src/types";
import { admitted, bind, connect, facet, hooks, live, oneDrive, origin, run, unwrap, walk } from "./tenant";

describe.skipIf(!live)("observers", () => {
  it("each verifier answers for its own account, in the shared tenant", async () => {
    for (const label of ["phillip", "sarah", "bob"] as const) {
      const identity = unwrap<{ tenantId: string } | null>(await hooks().verifier(await connect(label), "verifiedIdentity"));
      expect(identity?.tenantId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("admits a member of a private site and refuses someone who isn't", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Engineering/Shared%20Documents/Specs`);
    const name = facet("obs-private-site");
    await walk<DriveEntry>(name, props, [["list"]]);
    expect(await admitted(name, props, ["sarah", "bob"])).toEqual(["sarah"]);
  });

  it("refuses a visitor a listing that names a folder only the owner can open, and nothing else", async () => {
    const base = await origin();
    const props = await bind("phillip", `${base}/sites/Marketing/Shared%20Documents`);
    const name = facet("obs-broken-inheritance");
    const top = await walk<DriveEntry>(name, props, [["list"]]);
    const launch = top.find(entry => entry.name === "Launch")!;
    const confidential = top.find(entry => entry.name === "Confidential")!;
    // Phillip's listing of the library names Confidential, which Bob can't open.
    expect(await admitted(name, props, ["bob"])).toEqual([]);

    const fresh = facet("obs-broken-inheritance-fresh");
    await walk<DriveEntry>(fresh, props, [["list", { folderId: launch.id }]]);
    expect(await admitted(fresh, props, ["bob"])).toEqual(["bob"]);
    await walk<DriveEntry>(fresh, props, [["list", { folderId: confidential.id }]]);
    expect((await hooks().queueLog(fresh)).observations.at(-1)!.description).toContain("Confidential");
    expect(await admitted(fresh, props, ["bob"], "last")).toEqual([]);
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

    const name = facet("obs-draft");
    unwrap(await run(name, props, [["readPage"]]));
    expect((await hooks().queueLog(name)).observations.at(-1)!.description).toContain("Launch Plan");
    expect(await admitted(name, props, ["bob"], "last")).toEqual([]);
  });

  it("follows a OneDrive share: the shared folder admits its recipient, the private one does not", async () => {
    const drive = await oneDrive();
    const props = await bind("phillip", `${await origin()}/_layouts/15/sharepoint.aspx`);
    const name = facet("obs-onedrive");
    const apollo = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${drive}/Documents/GadgetsSpike/Apollo`]]));
    await walk<DriveEntry>(name, props, [["list", { folderId: apollo.id }]]);
    expect(await admitted(name, props, ["sarah", "bob"])).toEqual(["sarah"]);

    const secret = unwrap<{ id: string }>(await run(name, props, [["resolveUrl", `${drive}/Documents/GadgetsSpike/Private/secret.txt`]]));
    unwrap(await run(name, props, [["readFile", secret.id]]));
    expect((await hooks().queueLog(name)).observations.at(-1)!.description).toContain("secret\\.txt");
    expect(await admitted(name, props, ["sarah"], "last")).toEqual([]);
  });
});
