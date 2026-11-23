// Writes against the live tenant, in a scratch folder of their own: every file and list change
// proposed, seen through the overlay while it waits, applied as an approver would, and reverted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriveEntry, FileContent, FileVersion, ListItem } from "../../src/types";
import type { GatekeeperProps } from "../workerd/worker";
import { bind, connect, failure, facet, hooks, live, origin, run, unwrap, walk } from "./tenant";

type Submitted = { actionId: number; description: { title: string; description: string } };

const SCRATCH = `Gadgets contract ${new Date().toISOString().replace(/[:.]/g, "-")}`;
let scratchId: string | undefined;
let driveId: string;

/** The action the facet's queue last recorded, applied as an approver would. */
async function approveLast(name: string, props: GatekeeperProps): Promise<Submitted> {
  const log = await hooks().queueLog(name);
  const last = log.submitted.at(-1) as Submitted;
  unwrap(await hooks().applyAction(name, props, last.actionId));
  return last;
}

describe.skipIf(!live)("writes, bound to a scratch folder", () => {
  let props: GatekeeperProps;

  beforeAll(async () => {
    const phillip = await connect("phillip");
    const library = unwrap<{ scope: { driveId: string } }>(
      await hooks().resolve(phillip, `${await origin()}/sites/Engineering/Shared%20Documents`));
    driveId = library.scope.driveId;
    const created = unwrap<{ id: string }>(await hooks().graph(phillip, "POST", `/drives/${driveId}/root/children`,
      { name: SCRATCH, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }));
    scratchId = created.id;
    props = await bind("phillip", `${await origin()}/sites/Engineering/Shared%20Documents/${encodeURIComponent(SCRATCH)}`);
  });

  afterAll(async () => {
    if (scratchId) await hooks().graph(await connect("phillip"), "DELETE", `/drives/${driveId}/items/${scratchId}`);
  });

  it("creates a folder and a file inside it before either exists, then applies both in order", async () => {
    const name = facet("writes-create");
    const folder = unwrap<DriveEntry>(await run(name, props, [["createFolder", `${driveId}/${scratchId}`, "Drafts"]]));
    expect(folder).toMatchObject({ name: "Drafts", path: "Drafts", pending: "create" });
    expect(folder.id).toMatch(/^~/);
    const file = unwrap<DriveEntry>(await run(name, props, [["uploadFile", folder.id, "plan.md", "# Plan\n\nShip it.\n"]]));
    expect(file).toMatchObject({ name: "plan.md", path: "Drafts/plan.md", pending: "create", mimeType: "text/markdown" });

    // Both show while they wait: the folder in the listing, the file inside the pending folder.
    const top = await walk<DriveEntry>(name, props, [["list"]]);
    expect(top.map(entry => [entry.name, entry.pending])).toEqual([["Drafts", "create"]]);
    const inside = await walk<DriveEntry>(name, props, [["list", { folderId: folder.id }]]);
    expect(inside.map(entry => entry.name)).toEqual(["plan.md"]);
    // The pending file reads back as what it will contain.
    const staged = unwrap<FileContent>(await run(name, props, [["readFile", file.id]]));
    expect(staged.content).toContain("Ship it.");

    const log = await hooks().queueLog(name);
    expect(log.submitted.map(entry => (entry as Submitted).description.title)).toEqual([
      expect.stringContaining("Drafts"), expect.stringContaining("plan.md"),
    ]);
    expect(JSON.stringify((log.submitted[1] as Submitted).description)).toContain("Ship it.");

    for (const entry of log.submitted) unwrap(await hooks().applyAction(name, props, (entry as Submitted).actionId));
    const applied = await walk<DriveEntry>(name, props, [["list"]]);
    const drafts = applied.find(entry => entry.name === "Drafts")!;
    expect(drafts.pending).toBeUndefined();
    expect(drafts.id).not.toMatch(/^~/);
    // The temporary IDs resolve to the real ones once applied.
    const real = unwrap<FileContent>(await run(name, props, [["readFile", file.id]]));
    expect(real.content).toContain("Ship it.");
    expect(real.entry.id).not.toMatch(/^~/);
  });

  it("replaces a file with a diff for the approver, fenced on its content, and reverts to the previous version", async () => {
    const name = facet("writes-replace");
    const created = unwrap<DriveEntry>(await run(name, props, [["uploadFile", `${driveId}/${scratchId}`, "notes.txt", "one\ntwo\nthree\n"]]));
    await approveLast(name, props);
    const file = unwrap<DriveEntry>(await run(name, props, [["getEntry", created.id]]));
    expect(file.eTag).toBeTruthy();

    unwrap(await run(name, props, [["replaceFile", file.id, "one\n2\nthree\nfour\n"]]));
    const proposed = await approveLast(name, props);
    expect(JSON.stringify(proposed.description)).toMatch(/two/);
    expect(JSON.stringify(proposed.description)).toMatch(/four/);
    const after = unwrap<FileContent>(await run(name, props, [["readFile", file.id]]));
    expect(after.content).toBe("one\n2\nthree\nfour\n");
    const versions = unwrap<FileVersion[]>(await run(name, props, [["listVersions", file.id]]));
    expect(versions.length).toBeGreaterThanOrEqual(2);

    // A replace fenced on the version read before the last one is refused, not applied over it.
    unwrap(await run(name, props, [["replaceFile", file.id, "stale\n", { ifUnchanged: file.eTag }]]));
    const log = await hooks().queueLog(name);
    const stale = (log.submitted.at(-1) as Submitted).actionId;
    expect(failure(await hooks().applyAction(name, props, stale))).toMatch(/changed after this was proposed/);

    unwrap(await hooks().revertAction(name, props, proposed.actionId));
    const reverted = unwrap<FileContent>(await run(name, props, [["readFile", file.id]]));
    expect(reverted.content).toBe("one\ntwo\nthree\n");
  });

  it("renames, moves and deletes, refusing a name already taken", async () => {
    const name = facet("writes-organize");
    const root = `${driveId}/${scratchId}`;
    unwrap(await run(name, props, [["createFolder", root, "Archive"]]));
    await approveLast(name, props);
    unwrap(await run(name, props, [["uploadFile", root, "draft.txt", "draft"]]));
    await approveLast(name, props);
    const entries = await walk<DriveEntry>(name, props, [["list"]]);
    const archive = entries.find(entry => entry.name === "Archive")!;
    const draft = entries.find(entry => entry.name === "draft.txt")!;

    expect(failure(await run(name, props, [["rename", draft.id, "Archive"]]))).toMatch(/already has something named "Archive"/);
    const renamed = unwrap<DriveEntry>(await run(name, props, [["rename", draft.id, "final.txt"]]));
    expect(renamed).toMatchObject({ name: "final.txt", pending: "rename" });
    await approveLast(name, props);
    const moved = unwrap<DriveEntry>(await run(name, props, [["move", draft.id, archive.id]]));
    expect(moved).toMatchObject({ path: "Archive/final.txt", pending: "move" });
    // While the move waits, the file is listed where it is going, not where it is.
    expect((await walk<DriveEntry>(name, props, [["list"]])).map(entry => entry.name)).not.toContain("final.txt");
    expect((await walk<DriveEntry>(name, props, [["list", { folderId: archive.id }]])).map(entry => entry.name)).toEqual(["final.txt"]);
    const move = await approveLast(name, props);
    unwrap(await hooks().revertAction(name, props, move.actionId));
    expect((await walk<DriveEntry>(name, props, [["list"]])).map(entry => entry.name)).toContain("final.txt");

    unwrap(await run(name, props, [["delete", draft.id]]));
    expect((await walk<DriveEntry>(name, props, [["list"]])).find(entry => entry.name === "final.txt")).toBeUndefined();
    const deleted = await approveLast(name, props);
    expect(deleted.description.title).toMatch(/final\.txt/);
    expect(await hooks().revertAction(name, props, deleted.actionId)).toEqual({
      ok: { message: expect.stringMatching(/recycle bin/), canRetry: false },
    });
  });

  it("refuses to change the folder the binding is for", async () => {
    const name = facet("writes-top");
    expect(failure(await run(name, props, [["rename", `${driveId}/${scratchId}`, "Other"]]))).toMatch(/top of what this connection covers/);
  });

  it("lets a file binding replace its file, but not rename or delete it", async () => {
    const setup = facet("writes-file-setup");
    unwrap(await run(setup, props, [["uploadFile", `${driveId}/${scratchId}`, "single.txt", "before\n"]]));
    await approveLast(setup, props);
    const fileProps = await bind("phillip",
      `${await origin()}/sites/Engineering/Shared%20Documents/${encodeURIComponent(SCRATCH)}/single.txt`);
    expect(fileProps.scope.kind).toBe("file");
    const name = facet("writes-file");
    expect(unwrap<Array<{ tag: string }>>(await hooks().autoApprovable(name, fileProps)).map(kind => kind.tag))
      .toEqual(["sharepoint.files.edit"]);
    const { fileId } = unwrap<{ fileId: string }>(await run(name, fileProps, [["getScope"]]));

    unwrap(await run(name, fileProps, [["replaceFile", fileId, "after\n"]]));
    await approveLast(name, fileProps);
    expect(unwrap<FileContent>(await run(name, fileProps, [["readFile", fileId]])).content).toBe("after\n");
    expect(failure(await run(name, fileProps, [["rename", fileId, "other.txt"]]))).toMatch(/top of what this connection covers/);
    expect(failure(await run(name, fileProps, [["delete", fileId]]))).toMatch(/top of what this connection covers/);
  });
});

describe.skipIf(!live)("list item writes", () => {
  it("creates, updates and deletes an item, and reverts the update", async () => {
    const props = await bind("phillip", `${await origin()}/sites/Engineering/Lists/Issue%20Tracker`);
    const name = facet("list-writes");
    const title = `Contract item ${Date.now()}`;
    const created = unwrap<ListItem>(await run(name, props, [["openList"], ["createItem", { Title: title }]]));
    expect(created).toMatchObject({ pending: "create", fields: { Title: title } });
    // The pending item joins an unfiltered query.
    const queued = await walk<ListItem>(name, props, [["openList"], ["queryItems"]]);
    expect(queued.find(item => item.id === created.id)).toBeDefined();
    await approveLast(name, props);

    const found = await walk<ListItem>(name, props, [["openList"], ["queryItems", { where: [{ field: "Title", op: "eq", value: title }] }]]);
    expect(found).toHaveLength(1);
    const item = found[0];
    unwrap(await run(name, props, [["openList"], ["updateItem", item.id, { Title: `${title} (edited)` }]]));
    const update = await approveLast(name, props);
    expect(JSON.stringify(update.description)).toContain("(was)");
    expect(unwrap<ListItem>(await run(name, props, [["openList"], ["getItem", item.id]])).fields.Title).toBe(`${title} (edited)`);
    unwrap(await hooks().revertAction(name, props, update.actionId));
    expect(unwrap<ListItem>(await run(name, props, [["openList"], ["getItem", item.id]])).fields.Title).toBe(title);

    unwrap(await run(name, props, [["openList"], ["deleteItem", item.id]]));
    await approveLast(name, props);
    expect(failure(await run(name, props, [["openList"], ["getItem", item.id]]))).toMatch(/outside what this SharePoint connection covers/);
  });
});
