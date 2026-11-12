import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresentationInfo } from "../../src/slides-read-types";
import { GooglePresentationReadSessionImpl, GooglePresentationSessionImpl } from "../../src/slides";
import type { DriveBindingScope } from "../../src/drive-session";
import { DRIVE_WRITES_GRANT, GOOGLE_DRIVE_RESOURCE } from "../../src/resources";
import { DriveFiles, DOC_MIME, FOLDER_MIME, SLIDES_MIME } from "../drive-files";
import { DRIVE_SHEETS_KINDS, DRIVE_SLIDES_KINDS } from "../drive-edit-kinds";
import { presentation, shape, slide, text } from "../slides-fixture";
import { serveFakes, SlidesProvider, type ProviderFake } from "../slides-provider";

// Edits of Google Slides presentations through a read and write Drive binding: queued by the
// sessions it opens, proved again and applied or rejected by the gatekeeper, against several
// presentations and the Drive that holds them.

const ROOT = "folder-root";
const GRANTED = [GOOGLE_DRIVE_RESOURCE.urlPattern, DRIVE_WRITES_GRANT];
const COMMENTS = { tag: "driveComments", label: "Drive comments" };

const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
const IN_TRASH = "That file is in the trash, so it cannot be changed.";
const NOT_ALLOWED = "The connected Google account cannot edit that file.";
const OUT_OF_ORDER = "Changes to one file apply in the order they were queued. Approve or " +
  "reject the earlier change to this file first.";
const UNKNOWN_OUTCOME = "may or may not have taken effect";
const GRANT_MISSING =
  "Changes need a permission this Google account hasn't granted, or no longer grants. In " +
  "Workshop, start adding a Google Drive connection for this account, choose all of Drive or a " +
  "folder, then \"Read and write\", and select \"Allow changes\". The permission covers every " +
  "read and write Drive connection on the account, so the dialog can then be closed.";
const DEPLOYMENT_READ_ONLY =
  "This deployment keeps Google Drive read-only, so no Google Drive connection can make " +
  "changes, and none can be connected with read and write access. Only the deployment's " +
  "administrator can change that.";

function hooks() {
  return env.TEST_HOOKS.getByName("drive-editors");
}

/** Every Slides API request, in order; it answers none of them. */
class SlidesRequests implements ProviderFake {
  readonly requests: string[] = [];

  async handle(request: Request): Promise<Response | undefined> {
    let url = new URL(request.url);
    if (url.hostname === "slides.googleapis.com") this.requests.push(`${request.method} ${url.pathname}`);
    return undefined;
  }
}

function deck() {
  return presentation([
    slide("s1", [shape("t1", text(["Q3 review"]), { placeholder: "TITLE" })]),
    slide("s2", [shape("t2", text(["Revenue"]), { placeholder: "TITLE" })]),
    slide("s3", [shape("t3", text(["Thanks"]), { placeholder: "TITLE" })]),
  ]);
}

type Binding = { scope: DriveBindingScope; access?: "write"; deployment?: "read" };

const ACCOUNT: Binding = { scope: { kind: "account" }, access: "write" };
const FOLDER: Binding = { scope: { kind: "folder", folderId: ROOT }, access: "write" };
const fileBinding = (fileId: string): Binding => ({ scope: { kind: "file", fileId }, access: "write" });

let facetCount = 0;

/** One Drive gatekeeper over its own storage, reached as `binding` says, with calls on fresh sessions. */
function connection(binding: Binding, facet = `drive-editors-${++facetCount}`) {
  return {
    facet,
    /** Calls `method` of presentation `fileId`, opened from a fresh session. */
    call: (fileId: string, method: string, ...args: unknown[]) =>
      hooks().callDriveNative(facet, binding, "openGoogleSlides", fileId, method, args),
    /** As `call`, through each folder of `path` in turn. */
    callIn: (path: string[], fileId: string, method: string, ...args: unknown[]) =>
      hooks().callDriveNative(facet, binding, "openGoogleSlides", fileId, method, args, path),
    queued: async (fileId: string, method: string, ...args: unknown[]) => {
      let outcome = await hooks().callDriveNative(
        facet, binding, "openGoogleSlides", fileId, method, args);
      if (outcome.error !== undefined) throw new Error(outcome.error);
      if (outcome.actionId === undefined) throw new Error(`${method} queued nothing`);
      return outcome.actionId;
    },
    outline: async (fileId: string) =>
      (await hooks().callDriveNative(facet, binding, "openGoogleSlides", fileId, "getPresentation", []))
        .value as PresentationInfo,
    drive: (method: "comment", ...args: unknown[]) => hooks().callDrive(facet, binding, method, args),
    apply: (actionId: number) => hooks().applyDrive(facet, binding, actionId),
    reject: (actionId: number) => hooks().rejectDriveEdit(facet, binding, actionId),
    queuedIds: () => hooks().driveQueued(facet, binding),
    describe: () => hooks().describeDrive(facet, binding),
    autoApprovable: () => hooks().driveAutoApprovable(facet, binding),
    orphan: (actionId: number) => hooks().orphanDriveClaim(facet, binding, actionId),
    restart: () => hooks().restartDrive(facet),
  };
}

let drive: DriveFiles;
let deck1: SlidesProvider;
let deck2: SlidesProvider;
let slidesRequests: SlidesRequests;

beforeEach(async () => {
  drive = new DriveFiles({
    "my-root": { name: "My Drive", mimeType: FOLDER_MIME, parents: [] },
    [ROOT]: { name: "Reports", mimeType: FOLDER_MIME, parents: ["my-root"] },
    elsewhere: { name: "Elsewhere", mimeType: FOLDER_MIME, parents: ["my-root"] },
    "deck-1": { name: "Q3 deck", mimeType: SLIDES_MIME, parents: [ROOT] },
    "deck-2": { name: "Q4 deck", mimeType: SLIDES_MIME, parents: [ROOT] },
    "doc-1": { name: "Notes", mimeType: DOC_MIME, parents: [ROOT] },
  });
  deck1 = new SlidesProvider(deck(), "deck-1");
  deck2 = new SlidesProvider({ ...deck(), presentationId: "deck-2" }, "deck-2");
  slidesRequests = new SlidesRequests();
  serveFakes([slidesRequests, deck1, deck2, drive]);
  await hooks().setDriveGrants(GRANTED);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slides edits through a read and write Drive binding", () => {
  it("keeps each presentation's changes apart within the binding's one journal", async () => {
    let account = connection(ACCOUNT);
    let skipFirst = await account.queued("deck-1", "setSlidesSkipped", ["s1"], true);
    let comment = await account.drive("comment", "deck-1", "Looks good.");
    let skipOther = await account.queued("deck-2", "setSlidesSkipped", ["s1"], true);
    let removeFirst = await account.queued("deck-1", "deleteSlide", "s3");
    // One counter numbers every write the binding queues.
    expect([skipFirst, comment.actionId, skipOther, removeFirst]).toEqual([1, 2, 3, 4]);

    // Each presentation's reads show its own changes alone.
    let first = await account.outline("deck-1");
    expect(first.slides.map(({ id, skipped }) => [id, skipped])).toEqual([["s1", true], ["s2", false]]);
    let other = await account.outline("deck-2");
    expect(other.slides.map(({ id, skipped }) => [id, skipped]))
      .toEqual([["s1", true], ["s2", false], ["s3", false]]);

    // Only an earlier change to the same presentation holds a change back.
    expect(await account.apply(removeFirst)).toBe(OUT_OF_ORDER);
    expect(await account.apply(skipOther)).toBeNull();
    expect(deck1.batches).toEqual([]);
    expect(deck2.batches.map(({ requests }) => requests)).toEqual([[{
      updateSlideProperties: { objectId: "s1", slideProperties: { isSkipped: true }, fields: "isSkipped" },
    }]]);

    // A restart is asked for when the same presentation's later change was built on the rejected
    // one, and another presentation's later change does not count.
    let removeOther = await account.queued("deck-2", "deleteSlide", "s3");
    expect(await account.reject(skipFirst)).toEqual({ restart: true });
    expect(await account.reject(removeFirst)).toBeNull();
    expect(await account.apply(removeOther)).toBeNull();
    expect(deck1.batches).toEqual([]);
    expect(deck2.deck.slides!.map(({ objectId }) => objectId)).toEqual(["s1", "s2"]);
    // The comment is still the binding's to decide.
    expect(await account.queuedIds()).toEqual([comment.actionId]);
  });

  it("queues a change sent before the one before it has queued after it, built on it", async () => {
    let file = connection(fileBinding("deck-1"));
    let hold = drive.holdNextBatch();

    let calling = hooks().callDriveNativeTwice(
      file.facet, fileBinding("deck-1"), "openGoogleSlides", "deck-1",
      ["setSlidesSkipped", ["s1"], true], ["setSlidesSkipped", ["s1"], false]);
    // The first change's proof waits on Drive while the second is sent: a second proof made
    // meanwhile would be answered first, and its change queued first.
    await hold.reached;
    await scheduler.wait(5);
    expect(drive.batches()).toEqual([["deck-1"]]);
    hold.release();
    let { outcomes, submitted } = await calling;

    // Unskipping s1 queues only where skipping it was queued first.
    expect(outcomes).toEqual([{}, {}]);
    expect(submitted).toEqual([
      { actionId: 1, title: "Skip slide 1 (\"Q3 review\")" },
      { actionId: 2, title: "Stop skipping slide 1 (\"Q3 review\")" },
    ]);
  });

  it("refuses every write of a presentation that left the folder before any Slides request, and fails what it queued", async () => {
    let folder = connection(FOLDER);
    let queued = await folder.queued("deck-1", "setSlidesSkipped", ["s1"], true);
    let writes = Object.getOwnPropertyNames(GooglePresentationSessionImpl.prototype)
      .filter(name => name !== "constructor" &&
        !Object.getOwnPropertyNames(GooglePresentationReadSessionImpl.prototype).includes(name));
    let args: Record<string, unknown[]> = {
      updateSlides: [[{ op: "editText", slideId: "s2", elementId: "t2", replace: "Sales" }]],
      duplicateSlide: ["s2"],
      deleteSlide: ["s2"],
      moveSlides: [["s2"], null],
      createSlide: ["layout-title"],
      setSlidesSkipped: [["s2"], true],
    };
    // Every write method has its call here, so a new one cannot be left out.
    expect(writes.toSorted()).toEqual(Object.keys(args).toSorted());

    for (let method of writes) {
      slidesRequests.requests.length = 0;
      let refused = await hooks().callDriveNativeAfter(
        folder.facet, FOLDER, "openGoogleSlides", "deck-1", method, args[method], [],
        async () => { drive.files.get("deck-1")!.parents = ["elsewhere"]; });
      drive.files.get("deck-1")!.parents = [ROOT];
      expect(refused.error, method).toBe(OUT_OF_SCOPE);
      expect(refused.actionId, method).toBeUndefined();
      expect(slidesRequests.requests, method).toEqual([]);
    }

    drive.files.get("deck-1")!.parents = ["elsewhere"];
    slidesRequests.requests.length = 0;
    expect(await folder.apply(queued)).toBe(OUT_OF_SCOPE);
    expect(slidesRequests.requests).toEqual([]);
    expect(await folder.queuedIds()).toEqual([]);
    // Failed for good: back in the folder, approving it repeats why.
    drive.files.get("deck-1")!.parents = [ROOT];
    expect(await folder.apply(queued)).toBe(OUT_OF_SCOPE);
    expect(deck1.batches).toEqual([]);
    expect(await folder.reject(queued)).toBeNull();
  });

  it.each([
    { name: "in the trash", change: { trashed: true }, refusal: IN_TRASH },
    { name: "no longer editable by the account", change: { canEdit: false }, refusal: NOT_ALLOWED },
    { name: "no longer a presentation", change: { mimeType: DOC_MIME }, refusal: OUT_OF_SCOPE },
  ])("fails a change for good, sending nothing, once its presentation is $name", async ({ change, refusal }) => {
    let account = connection(ACCOUNT);
    let queued = await account.queued("deck-1", "deleteSlide", "s3");
    Object.assign(drive.files.get("deck-1")!, change);
    slidesRequests.requests.length = 0;

    expect(await account.apply(queued)).toBe(refusal);
    expect(slidesRequests.requests).toEqual([]);
    expect(await account.queuedIds()).toEqual([]);
    expect(await account.apply(queued)).toBe(refusal);
  });

  it("refuses to queue a change to a presentation the account cannot edit, before reading it", async () => {
    let account = connection(ACCOUNT);
    drive.files.get("deck-1")!.canEdit = false;
    slidesRequests.requests.length = 0;

    let refused = await account.call("deck-1", "deleteSlide", "s3");

    expect(refused.error).toBe(NOT_ALLOWED);
    expect(refused.actionId).toBeUndefined();
    expect(slidesRequests.requests).toEqual([]);
  });

  it("fails a change claimed by an activation that died as of unknown outcome, without sending it again", async () => {
    let account = connection(ACCOUNT);
    let queued = await account.queued("deck-1", "deleteSlide", "s3");
    await account.orphan(queued);

    expect(await account.apply(queued)).toContain(UNKNOWN_OUTCOME);
    expect(deck1.batches).toEqual([]);
    expect(await account.queuedIds()).toEqual([]);
    expect(await account.apply(queued)).toContain(UNKNOWN_OUTCOME);
    expect(deck1.batches).toEqual([]);
  });

  it("keeps a deployment's read-only setting: no editable session, no kind, and a queued change waits", async () => {
    let account = connection(ACCOUNT);
    let queued = await account.queued("deck-1", "deleteSlide", "s3");
    await account.restart();
    let readOnly = connection({ ...ACCOUNT, deployment: "read" }, account.facet);

    let refused = await readOnly.call("deck-1", "deleteSlide", "s2");
    expect(refused.error).toBe('The RPC receiver does not implement the method "deleteSlide".');
    expect(refused.actionId).toBeUndefined();
    // A read-only binding's sessions show the presentation as Google holds it.
    expect((await readOnly.outline("deck-1")).slides.map(({ id }) => id)).toEqual(["s1", "s2", "s3"]);
    expect(await readOnly.autoApprovable()).toEqual([]);
    expect(await readOnly.apply(queued)).toBe(DEPLOYMENT_READ_ONLY);
    expect(deck1.batches).toEqual([]);
    expect(await readOnly.queuedIds()).toEqual([queued]);

    await readOnly.restart();
    expect(await account.apply(queued)).toBeNull();
    expect(deck1.deck.slides!.map(({ objectId }) => objectId)).toEqual(["s1", "s2"]);
  });

  it("leaves a change waiting while the account does not allow changes, and applies it once it does", async () => {
    let account = connection(ACCOUNT);
    let queued = await account.queued("deck-1", "deleteSlide", "s3");
    await hooks().setDriveGrants([GOOGLE_DRIVE_RESOURCE.urlPattern]);

    expect(await account.apply(queued)).toBe(GRANT_MISSING);
    expect(deck1.batches).toEqual([]);
    expect(await account.queuedIds()).toEqual([queued]);

    await hooks().setDriveGrants(GRANTED);
    expect(await account.apply(queued)).toBeNull();
    expect(deck1.batches).toHaveLength(1);
  });

  it("opens a presentation from a read-only binding with no write method", async () => {
    let readOnly = connection({ scope: { kind: "account" } });

    let refused = await readOnly.call("deck-1", "setSlidesSkipped", ["s1"], true);

    expect(refused.error)
      .toBe('The RPC receiver does not implement the method "setSlidesSkipped".');
    expect((await readOnly.outline("deck-1")).slides).toHaveLength(3);
    expect(await readOnly.autoApprovable()).toEqual([]);
  });

  it("edits a presentation through a folder binding it opened", async () => {
    let folder = connection(FOLDER);
    let queued = await folder.queued("deck-1", "deleteSlide", "s3");

    expect(await folder.apply(queued)).toBeNull();
    expect(deck1.deck.slides!.map(({ objectId }) => objectId)).toEqual(["s1", "s2"]);
  });

  it("lists the presentations' kinds where the binding can edit them", async () => {
    expect(await connection(ACCOUNT).autoApprovable())
      .toEqual([COMMENTS, ...DRIVE_SLIDES_KINDS, ...DRIVE_SHEETS_KINDS]);
    expect(await connection(FOLDER).autoApprovable())
      .toEqual([COMMENTS, ...DRIVE_SLIDES_KINDS, ...DRIVE_SHEETS_KINDS]);

    // An exact-file binding lists its own file's editor alone, once it has described the file.
    let doc = connection(fileBinding("doc-1"));
    expect(await doc.autoApprovable()).toEqual([COMMENTS]);
    await doc.describe();
    expect(await doc.autoApprovable()).toEqual([COMMENTS]);

    let presentationFile = connection(fileBinding("deck-1"));
    expect(await presentationFile.autoApprovable()).toEqual([COMMENTS]);
    await presentationFile.describe();
    expect(await presentationFile.autoApprovable()).toEqual([COMMENTS, ...DRIVE_SLIDES_KINDS]);
  });
});
