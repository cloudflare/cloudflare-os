import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NEW_DECK from "../../src/blank-presentation.json";
import type { PresentationInfo, Slide } from "../../src/slides-read-types";
import { buildTab } from "../doc-fixture";

const DOC_PATTERN = "https://docs.google.com/document/d/:docId/*";
const SHEETS_PATTERN = "https://docs.google.com/spreadsheets/d/:spreadsheetId/*";
const SLIDES_PATTERN = "https://docs.google.com/presentation/d/:presentationId/*";
const MY_DRIVE_URL = "https://drive.google.com/drive/my-drive";
const FOLDER_URL = "https://drive.google.com/drive/folders/folder-1";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/sheet-1/edit";
/** The real ID Drive reports as the parent of a file in My Drive. */
const ROOT_ID = "root-id";

const FOLDER = "application/vnd.google-apps.folder";
/** Drive's `files.get` for My Drive and for each folder a creation may name. */
const FOLDERS: Record<string, object> = {
  root: { id: ROOT_ID, name: "My Drive" },
  "folder-1": { id: "folder-1", name: "Team", mimeType: FOLDER, capabilities: { canAddChildren: true } },
  "trashed-1": {
    id: "trashed-1", name: "Old", mimeType: FOLDER, trashed: true, capabilities: { canAddChildren: true },
  },
  "viewer-1": { id: "viewer-1", name: "Read only", mimeType: FOLDER, capabilities: { canAddChildren: false } },
  "doc-x": {
    id: "doc-x", name: "Notes", mimeType: "application/vnd.google-apps.document",
    capabilities: { canAddChildren: false },
  },
};

/** Each provider request, with the body of any POST. */
let requests: { url: URL; method: string; body?: unknown }[];
/** Drive's parents for each file created; Google creates each in My Drive. */
let parents: Map<string, string[]>;
/** How many Drive moves to refuse, and how many to apply but answer with a 503, as a lost reply. */
let refusedMoves: number;
let lostMoves: number;

/** Drive's `files.get` and `files.update`, for FOLDERS and the created files. */
function drive(method: string, url: URL): Response {
  let fileId = decodeURIComponent(url.pathname.slice("/drive/v3/files/".length));
  if (method === "GET" && fileId in FOLDERS) return Response.json(FOLDERS[fileId]);
  let current = parents.get(fileId);
  if (!current) return Response.json({ error: { code: 404 } }, { status: 404 });
  if (method === "GET") return Response.json({ id: fileId, name: "File", parents: current });
  if (refusedMoves > 0) {
    refusedMoves--;
    return Response.json(
      { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 });
  }
  let removed = url.searchParams.get("removeParents")?.split(",") ?? [];
  parents.set(fileId, [
    ...current.filter(parent => !removed.includes(parent)), url.searchParams.get("addParents")!,
  ]);
  if (lostMoves > 0) {
    lostMoves--;
    return new Response(null, { status: 503 });
  }
  return Response.json({ id: fileId });
}

beforeEach(() => {
  requests = [];
  parents = new Map();
  refusedMoves = 0;
  lostMoves = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    let body = request.method === "POST" ? await request.json() : undefined;
    requests.push({ url, method: request.method, body });
    if (url.origin === "https://www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
      return drive(request.method, url);
    }
    if (request.method === "POST" && url.origin + url.pathname === "https://docs.googleapis.com/v1/documents") {
      parents.set("doc-1", [ROOT_ID]);
      return Response.json({ documentId: "doc-1" });
    }
    if (url.origin + url.pathname === "https://docs.googleapis.com/v1/documents/doc-1") {
      return Response.json({
        documentId: "doc-1", title: "Plan",
        tabs: [{ tabProperties: { tabId: "t.0", title: "Tab 1" }, documentTab: buildTab([]) }],
      });
    }
    if (request.method === "POST" && url.origin + url.pathname === "https://sheets.googleapis.com/v4/spreadsheets") {
      parents.set("sheet-1", [ROOT_ID]);
      return Response.json({ spreadsheetId: "sheet-1" });
    }
    if (request.method === "POST" && url.origin + url.pathname === "https://slides.googleapis.com/v1/presentations") {
      parents.set("deck-1", [ROOT_ID]);
      return Response.json({ presentationId: "deck-1" });
    }
    // The presentation created is the one the blank deck was recorded from.
    if (url.origin + url.pathname === "https://slides.googleapis.com/v1/presentations/deck-1:batchUpdate") {
      return Response.json({ replies: [] });
    }
    if (url.origin + url.pathname === "https://slides.googleapis.com/v1/presentations/deck-1") {
      let outline = url.searchParams.get("fields")!.includes("revisionId");
      return Response.json({
        ...outline ? NEW_DECK.outline : NEW_DECK.presentation,
        presentationId: "deck-1", title: "Pitch", ...outline ? { revisionId: "r1" } : {},
      });
    }
    let page = url.pathname.match(/^\/v1\/presentations\/deck-1\/pages\/([^/]+)$/)?.[1];
    if (url.origin === "https://slides.googleapis.com" && page !== undefined) {
      let pages: Record<string, unknown> = { ...NEW_DECK.slides, ...NEW_DECK.layouts };
      return page in pages ? Response.json(pages[page]) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected provider request: ${request.method} ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

describe("creating a Google spreadsheet", () => {
  it("reads as one empty sheet until created, then creates exactly that", async () => {
    let created = await hooks().createResource("create-sheet", SHEETS_PATTERN, "Budget");
    expect(created).toMatchObject({ action: { title: "Create Google Spreadsheet: Budget" } });
    expect(await hooks().describe("create-sheet")).toMatchObject({
      title: "Budget",
      url: "https://docs.google.com/spreadsheets/",
      snippet: "Google Spreadsheet: Budget (read-only; not created yet)",
    });
    expect(await hooks().readSpreadsheet("create-sheet")).toEqual({
      id: "",
      title: "Budget",
      sheets: [{ id: 0, title: "Sheet1", index: 0, rowCount: 1000, columnCount: 26 }],
    });
    expect(await hooks().readRange("create-sheet", "Sheet1!A1:B2"))
      .toEqual({ range: "Sheet1!A1:B2", values: [[null, null], [null, null]] });
    expect(await hooks().readRange("create-sheet", "A:A"))
      .toMatchObject({ error: expect.stringMatching(/Invalid or unbounded A1 range "A:A"/) });
    expect(await hooks().readRange("create-sheet", "'Q1 Data'!A1"))
      .toEqual({ error: 'No sheet named "Q1 Data": a spreadsheet awaiting creation has only "Sheet1".' });
    expect(await hooks().readRange("create-sheet", "Sheet1!Z1000:AA1000")).toEqual({
      error: 'A1 range "Sheet1!Z1000:AA1000" exceeds the 1000 rows and 26 columns of "Sheet1".',
    });
    expect(requests).toEqual([]);

    expect(await hooks().applyCreation("create-sheet")).toEqual({ resourceUrl: SHEET_URL });
    // Google creates it in My Drive, so nothing else is asked of Drive.
    expect(requests).toHaveLength(1);
    expect(requests[0].url.href).toBe("https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId");
    expect(requests[0].body).toEqual({
      properties: { title: "Budget" },
      sheets: [{
        properties: { sheetId: 0, title: "Sheet1", gridProperties: { rowCount: 1000, columnCount: 26 } },
      }],
    });

    await hooks().adoptCreated("create-sheet");
    expect(await hooks().applyCreation("create-sheet"))
      .toEqual({ error: "This Google spreadsheet already exists." });
  });
});

describe("placing a created file", () => {
  it.each([
    ["Doc", DOC_PATTERN, "doc-1", "https://docs.google.com/document/d/doc-1/edit"],
    ["spreadsheet", SHEETS_PATTERN, "sheet-1", SHEET_URL],
    ["presentation", SLIDES_PATTERN, "deck-1", "https://docs.google.com/presentation/d/deck-1/edit"],
  ])("moves a new %s into the chosen folder before the creation applies",
    async (kind, pattern, fileId, resourceUrl) => {
      await hooks().createResource(`place-${kind}`, pattern, "Plan");

      expect(await hooks().applyCreation(`place-${kind}`, "test-user", FOLDER_URL))
        .toEqual({ resourceUrl });
      expect(parents.get(fileId)).toEqual(["folder-1"]);
      let moves = requests.filter(({ method }) => method === "PATCH");
      expect(moves.map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([{
        addParents: "folder-1", removeParents: ROOT_ID, fields: "id", supportsAllDrives: "true",
      }]);
    });

  it.each([
    ["a URL that names no folder", "https://docs.google.com/document/d/doc-x/edit",
      "A new Google file can only be put in My Drive or a Google Drive folder."],
    ...["missing-1", "trashed-1", "viewer-1", "doc-x"].map(folderId => [
      `the folder ${folderId}`, `https://drive.google.com/drive/folders/${folderId}`,
      `The Google account creating this can't add files to the folder ${folderId}. ` +
        "Approve it again with a folder that account can add files to.",
    ]),
  ])("refuses %s before creating anything", async (_, configuration, error) => {
    await hooks().createResource("place-refused-target", SHEETS_PATTERN, "Budget");

    expect(await hooks().applyCreation("place-refused-target", "test-user", configuration))
      .toEqual({ error });
    expect(requests.filter(({ method }) => method !== "GET")).toEqual([]);
  });

  // Such an account is reported to hold the Doc grant, so the approval dialog never asks it for
  // `drive.file`, while its token passes the folder's own checks and could create the file.
  it("refuses a folder before creating for an account without drive.file, but not My Drive", async () => {
    await hooks().denyPlacement("legacy-user");
    await hooks().createResource("place-legacy", DOC_PATTERN, "Plan");

    expect(await hooks().applyCreation("place-legacy", "legacy-user", FOLDER_URL)).toEqual({
      error: "This Google account was connected without access to put new files in folders. " +
        "Reconnect it to choose a folder, or approve this for My Drive.",
    });
    expect(requests).toEqual([]);
    expect(await hooks().applyCreation("place-legacy", "legacy-user", MY_DRIVE_URL))
      .toEqual({ resourceUrl: "https://docs.google.com/document/d/doc-1/edit" });
  });

  // The first move took effect, so applying the creation now as it stands would bind a file
  // sitting in a folder this approver didn't choose.
  it("moves the file back to My Drive when a retry after a lost move reply chooses it", async () => {
    lostMoves = 1;
    await hooks().createResource("place-lost", SHEETS_PATTERN, "Budget");

    expect(await hooks().applyCreation("place-lost", "test-user", FOLDER_URL))
      .toHaveProperty("error");
    expect(parents.get("sheet-1")).toEqual(["folder-1"]);
    expect(await hooks().applyCreation("place-lost", "test-user", MY_DRIVE_URL))
      .toEqual({ resourceUrl: SHEET_URL });
    expect(parents.get("sheet-1")).toEqual([ROOT_ID]);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  it("leaves the creation unapplied when the move fails, and a retry completes it", async () => {
    refusedMoves = 1;
    await hooks().createResource("place-refused", SHEETS_PATTERN, "Budget");

    expect(await hooks().applyCreation("place-refused", "test-user", FOLDER_URL)).toEqual({
      error: `The Google spreadsheet at ${SHEET_URL} was created, but moving it into "Team" ` +
        "(folder-1) failed: Google Drive API request failed: 403 (insufficientPermissions)",
    });
    expect(parents.get("sheet-1")).toEqual([ROOT_ID]);
    expect(await hooks().applyCreation("place-refused", "test-user", FOLDER_URL))
      .toEqual({ resourceUrl: SHEET_URL });
    expect(parents.get("sheet-1")).toEqual(["folder-1"]);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
  });

  // Moving it would apply the second approver's choice with the first approver's authority.
  it("refuses another approver's retry for anywhere but where the file is", async () => {
    refusedMoves = 1;
    await hooks().createResource("place-approvers", SHEETS_PATTERN, "Budget");

    expect(await hooks().applyCreation("place-approvers", "user-a", FOLDER_URL)).toHaveProperty("error");
    for (const configuration of [FOLDER_URL, MY_DRIVE_URL]) {
      expect(await hooks().applyCreation("place-approvers", "user-b", configuration)).toEqual({
        error: "This Google spreadsheet was already created in another approver's Google account, " +
          "and only they can move it. Ask them to approve it.",
      });
    }
    expect(requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
    expect(await hooks().applyCreation("place-approvers", "user-a", FOLDER_URL))
      .toEqual({ resourceUrl: SHEET_URL });
  });

  // Its file is where Google created it, so binding it in My Drive needs no Drive scope, which an
  // account connected before per-resource grants may lack.
  it("binds the file of a receipt from before folders in My Drive, without asking Drive", async () => {
    const docUrl = "https://docs.google.com/document/d/doc-1/edit";
    await hooks().createResource("place-old-receipt", DOC_PATTERN, "Plan");
    await hooks().applyStorage("place-old-receipt", [{ kind: "put", key: "createdFile", value: {
      userObjectId: env.USER_ACCOUNT.idFromName("user-a").toString(), fileId: "doc-1",
    } }]);
    parents.set("doc-1", [ROOT_ID]);

    expect(await hooks().applyCreation("place-old-receipt", "user-b", MY_DRIVE_URL))
      .toEqual({ resourceUrl: docUrl });
    expect(requests.filter(({ url }) => url.pathname.startsWith("/drive/"))).toEqual([]);
    expect(await hooks().applyCreation("place-old-receipt", "user-a", FOLDER_URL))
      .toEqual({ resourceUrl: docUrl });
    expect(parents.get("doc-1")).toEqual(["folder-1"]);
    expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
  });

  it("says so when the created file is gone before a retry moves it", async () => {
    refusedMoves = 1;
    await hooks().createResource("place-gone", SHEETS_PATTERN, "Budget");

    expect(await hooks().applyCreation("place-gone", "test-user", FOLDER_URL)).toHaveProperty("error");
    parents.delete("sheet-1");
    expect(await hooks().applyCreation("place-gone", "test-user", FOLDER_URL)).toEqual({
      error: "The Google spreadsheet created for this approval is gone, or its Google account can " +
        "no longer reach it. Reject the creation and ask for a new one.",
    });
  });
});

describe("creating a Google Slides presentation", () => {
  it("reads as the deck Google creates, and applies changes queued to it once created", async () => {
    let created = await hooks().createResource("create-deck", SLIDES_PATTERN, "Pitch");
    expect(created).toMatchObject({ action: { title: "Create Google Slides Presentation: Pitch" } });
    expect(await hooks().describe("create-deck")).toMatchObject({
      title: "Pitch",
      url: "https://docs.google.com/presentation/",
      snippet: "Google Slides presentation: Pitch (not created yet)",
    });
    let simulated = (await hooks().callSlides("create-deck", "getPresentation", [])).value as PresentationInfo;
    expect(simulated).toMatchObject({
      id: "",
      title: "Pitch",
      pageSize: { width: 720, height: 405 },
      slides: [{ id: "p", index: 0, layout: "Title slide", master: "simple-light-2" }],
    });
    expect(simulated.layouts.map(layout => [layout.id, layout.name])).toEqual([
      ["p2", "Title slide"], ["p3", "Section header"], ["p4", "Title and body"], ["p6", "Title only"],
      ["p12", "Blank"],
    ]);
    // The theme's other layouts are offered only once the presentation exists.
    expect(await hooks().callSlides("create-deck", "createSlide", ["p5"]))
      .toMatchObject({ error: expect.stringMatching(/^No layout with ID "p5"/), actionId: undefined });

    let title = await hooks().callSlides("create-deck", "updateSlides",
      [[{ op: "editText", slideId: "p", elementId: "i0", replace: "Pitch" }]]);
    let added = await hooks().callSlides("create-deck", "createSlide", ["p4", "p"]);
    let newSlideId = added.value as string;
    expect(title.actionId).toBeDefined();
    expect(added.actionId).toBeDefined();
    let [slide] = (await hooks().callSlides("create-deck", "getSlides", [[newSlideId]])).value as Slide[];
    // A new presentation shows no slide numbers, so Google gives the slide no slide-number placeholder.
    expect(slide).toMatchObject({
      index: 1, layout: "Title and body", elements: [{ placeholder: "TITLE" }, { placeholder: "BODY" }],
    });
    expect((await hooks().callSlides("create-deck", "getPresentation", [])).value)
      .toMatchObject({ slides: [{ id: "p", title: "Pitch" }, { id: newSlideId }] });
    expect(await hooks().callSlides("create-deck", "getSlideThumbnail", ["p"]))
      .toMatchObject({ error: expect.stringContaining("doesn't exist yet") });
    expect(requests).toEqual([]);

    expect(await hooks().applyCreation("create-deck"))
      .toEqual({ resourceUrl: "https://docs.google.com/presentation/d/deck-1/edit" });
    await hooks().adoptCreated("create-deck");
    expect(await hooks().applySlides("create-deck", title.actionId!)).toBeNull();
    expect(await hooks().applySlides("create-deck", added.actionId!)).toBeNull();

    let posts = requests.filter(({ method }) => method === "POST").map(({ url, body }) => [url.href, body]);
    // The IDs the simulation showed are the ones a new presentation has, so they reach Google as is.
    expect(posts).toMatchObject([
      ["https://slides.googleapis.com/v1/presentations?fields=presentationId", { title: "Pitch" }],
      ["https://slides.googleapis.com/v1/presentations/deck-1:batchUpdate", {
        requests: [
          { insertText: { objectId: "i0", insertionIndex: 0, text: "Pitch" } },
          { updateTextStyle: { objectId: "i0" } },
        ],
        writeControl: { requiredRevisionId: "r1" },
      }],
      ["https://slides.googleapis.com/v1/presentations/deck-1:batchUpdate", {
        requests: [{
          createSlide: {
            objectId: newSlideId,
            insertionIndex: 1,
            slideLayoutReference: { layoutId: "p4" },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: slide.elements[0].id },
              { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: slide.elements[1].id },
            ],
          },
        }],
        writeControl: { requiredRevisionId: "r1" },
      }],
    ]);
  });
});

describe("GatekeeperVendor.createResource", () => {
  it("refuses a resource type it cannot create", async () => {
    expect(await hooks().createResource("create-gmail", "https://mail.google.com/*", "Inbox"))
      .toEqual({
        error: "Google can create only these resource types: " +
          "Google Doc (https://docs.google.com/document/d/:docId/*), " +
          "Google Spreadsheet (https://docs.google.com/spreadsheets/d/:spreadsheetId/*), " +
          "Google Slides Presentation (https://docs.google.com/presentation/d/:presentationId/*).",
      });
  });

  it("trims the title it creates with", async () => {
    expect(await hooks().createResource("create-padded", SHEETS_PATTERN, "  Budget \t"))
      .toMatchObject({ action: { title: "Create Google Spreadsheet: Budget" } });
    expect(await hooks().describe("create-padded")).toMatchObject({ title: "Budget" });
  });

  it.each([
    ["blank", "   "], ["too long", "x".repeat(257)], ["multi-line", "Budget\nDraft"],
    ["line-separated", "Budget\u2028Draft"],
  ])("refuses a %s title", async (_name, title) => {
    expect(await hooks().createResource("create-bad-title", SHEETS_PATTERN, title))
      .toEqual({ error: "A new Google file needs a one-line title of 1 to 256 characters." });
  });
});
