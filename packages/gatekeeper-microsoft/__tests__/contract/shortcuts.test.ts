// OneDrive shortcuts against the live tenant. Sarah adds a shortcut to Phillip's shared
// `GadgetsSpike/Apollo` folder to her own OneDrive. Graph won't list or read through a shortcut,
// so listing one lists its target, which the binding must cover as it would the target's own ID.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriveEntry } from "../../src/types";
import { account, bind, connect, failure, facet, hooks, live, origin, unwrap, walk } from "./tenant";

const OUTSIDE = /is outside what this SharePoint connection covers, or doesn.t exist\./;
const NAME = `Apollo shortcut ${Date.now().toString(36)}`;

describe.skipIf(!live)("OneDrive shortcuts", { timeout: 120_000 }, () => {
  let shortcutId: string;
  /** The shortcut as the gatekeeper names it: OneDrive's root listing can take a while to show a new one. */
  let shortcutEntry: string;

  beforeAll(async () => {
    const phillip = await connect("phillip");
    const sarah = await connect("sarah");
    const apollo = unwrap<{ id: string; parentReference: { driveId: string } }>(
      await hooks().graph(phillip, "GET", "/me/drive/root:/GadgetsSpike/Apollo?$select=id,parentReference"));
    // A folder takes one shortcut per drive: a run that fails before afterAll leaves one to delete by hand.
    const made = unwrap<{ id: string; parentReference: { driveId: string } }>(await hooks().graph(sarah, "POST", "/me/drive/root/children", {
      name: NAME, remoteItem: { id: apollo.id, parentReference: { driveId: apollo.parentReference.driveId } },
    }));
    shortcutId = made.id;
    shortcutEntry = `${made.parentReference.driveId}/${made.id}`;
  });

  afterAll(async () => {
    if (shortcutId) await hooks().graph(await connect("sarah"), "DELETE", `/me/drive/items/${shortcutId}`);
  });

  async function sarahsOneDrive(): Promise<string> {
    const host = (await origin()).replace(".sharepoint.com", "-my.sharepoint.com");
    return `${host}/personal/${account("sarah").username.toLowerCase().replace(/[@.]/g, "_")}/Documents`;
  }

  it("a OneDrive binding covers the shortcut but not what it points to in someone else's drive", async () => {
    const props = await bind("sarah", await sarahsOneDrive());
    const name = facet("shortcut-onedrive");
    expect(unwrap<DriveEntry>(await hooks().run(name, props, [["getEntry", shortcutEntry]])).name).toContain(NAME);
    expect(failure(await hooks().run(name, props, [["list", { folderId: shortcutEntry }]]))).toMatch(OUTSIDE);
  });

  it("an all-files binding lists what the shortcut points to", async () => {
    const props = await bind("sarah", `${await origin()}/_layouts/15/sharepoint.aspx`);
    const name = facet("shortcut-all");
    const inside = await walk<DriveEntry>(name, props, [["list", { folderId: shortcutEntry }]]);
    expect(inside.length).toBeGreaterThan(0);
    // What it lists is Phillip's, named by his drive: a later read is guarded as his item.
    expect(inside.every(entry => !entry.id.startsWith(`${shortcutEntry.split("/")[0]!}/`))).toBe(true);
  });
});
