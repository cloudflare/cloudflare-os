import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NEW_DECK from "../../src/blank-presentation.json";
import type { PresentationInfo, Slide } from "../../src/slides-read-types";

const SHEETS_PATTERN = "https://docs.google.com/spreadsheets/d/:spreadsheetId/*";
const SLIDES_PATTERN = "https://docs.google.com/presentation/d/:presentationId/*";
const FOLDER_PATTERN = "https://drive.google.com/drive/folders/:folderId";
const CREATED_FILES_GRANT = "https://drive.google.com/drive/created-files";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

/** Each provider request, with the body of any POST. */
let requests: { url: URL; method: string; body?: unknown }[];

type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean;
  capabilities?: { canListChildren: boolean; canAddChildren: boolean } };
/** The Drive files the account sees, by ID or by Drive's alias `root` for My Drive. */
let drive: Record<string, DriveFile>;
/** Whether the next move takes effect but its reply is lost. */
let loseMoveReply: boolean;
/**
 * How Drive answers the next folder creates, in turn: `lost` takes effect if not already and
 * answers 503, `refused` takes none and answers 403. Beyond them, a create takes effect or answers
 * 409 for an ID already used.
 */
let createAnswers: ("lost" | "refused")[];
/** How many IDs Drive has generated, each a new one. */
let generatedIds: number;

const folder = (id: string, name: string, canAddChildren = true): DriveFile =>
  ({ id, name, mimeType: FOLDER_MIME_TYPE, trashed: false, capabilities: { canListChildren: true, canAddChildren } });
const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

function driveResponse(method: string, url: URL, body: unknown): Response {
  if (url.pathname.endsWith("/files/generateIds")) return Response.json({ ids: [`folder-new-${++generatedIds}`] });
  if (method === "POST") {
    let { id, name, mimeType, parents } = body as DriveFile;
    let answer = createAnswers.shift();
    if (answer === "refused") {
      return Response.json({ error: { code: 403, message: "Insufficient permissions" } }, { status: 403 });
    }
    let exists = id in drive;
    if (!exists) drive[id] = { ...folder(id, name), mimeType, parents };
    if (answer === "lost") return Response.json({ error: { code: 503, message: "Backend Error" } }, { status: 503 });
    return exists
      ? Response.json({ error: { code: 409, message: "A file already exists with the provided ID." } }, { status: 409 })
      : Response.json({ id });
  }
  let file = drive[decodeURIComponent(url.pathname.split("/").at(-1)!)];
  if (!file) return Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
  if (method === "PATCH") {
    let removed = url.searchParams.get("removeParents")?.split(",") ?? [];
    file.parents = [...(file.parents ?? []).filter(parent => !removed.includes(parent)), url.searchParams.get("addParents")!];
    if (loseMoveReply) {
      loseMoveReply = false;
      return Response.json({ error: { code: 503, message: "Backend Error" } }, { status: 503 });
    }
  }
  return Response.json(file);
}

beforeEach(() => {
  requests = [];
  loseMoveReply = false;
  createAnswers = [];
  generatedIds = 0;
  drive = {
    root: folder("root-id", "My Drive"),
    "folder-1": folder("folder-1", "Plans"),
    "viewer-1": folder("viewer-1", "Read only", false),
    "trashed-1": { ...folder("trashed-1", "Old plans"), trashed: true },
    "sheet-1": { id: "sheet-1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["root-id"] },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    let body = request.method === "POST" ? await request.json() : undefined;
    requests.push({ url, method: request.method, body });
    if (url.href.startsWith(DRIVE_FILES)) return driveResponse(request.method, url, body);
    if (request.method === "POST" && url.origin + url.pathname === "https://sheets.googleapis.com/v4/spreadsheets") {
      return Response.json({ spreadsheetId: "sheet-1" });
    }
    if (request.method === "POST" && url.origin + url.pathname === "https://slides.googleapis.com/v1/presentations") {
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

    expect(await hooks().applyCreation("create-sheet"))
      .toEqual({ resourceUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" });
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
          "Google Slides Presentation (https://docs.google.com/presentation/d/:presentationId/*), " +
          "Google Drive Folder (https://drive.google.com/drive/folders/:folderId).",
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

const sheetPosts = () => requests.filter(({ url, method }) =>
  method === "POST" && url.hostname === "sheets.googleapis.com");
const moves = () => requests.filter(({ method }) => method === "PATCH")
  .map(({ url }) => [url.searchParams.get("addParents"), url.searchParams.get("removeParents")]);
const folderPosts = () => requests.filter(({ method, url }) => method === "POST" && url.href.startsWith(DRIVE_FILES));

describe("creating where the approver chooses", () => {
  it("keeps a file chosen for My Drive there, through its own API alone", async () => {
    await hooks().createResource("place-root", SHEETS_PATTERN, "Budget");
    expect(await hooks().applyCreation("place-root", "test-user", folderUrl("root")))
      .toEqual({ resourceUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" });
    expect(requests.map(({ url }) => url.hostname)).toEqual(["sheets.googleapis.com"]);
  });

  // Every approval brings the file to its own choice, and a retry binds the one already made.
  it("moves a created file into the chosen folder, and a retry only where it is not", async () => {
    await hooks().grant("test-user", [CREATED_FILES_GRANT]);
    await hooks().createResource("place-folder", SHEETS_PATTERN, "Budget");
    let created = { resourceUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" };

    expect(await hooks().applyCreation("place-folder", "test-user", folderUrl("folder-1"))).toEqual(created);
    expect(moves()).toEqual([["folder-1", "root-id"]]);
    expect(await hooks().applyCreation("place-folder", "test-user", folderUrl("folder-1"))).toEqual(created);
    expect(moves()).toHaveLength(1);
    expect(await hooks().applyCreation("place-folder", "test-user", folderUrl("root"))).toEqual(created);
    expect(moves()).toEqual([["folder-1", "root-id"], ["root-id", "folder-1"]]);
    expect(sheetPosts()).toHaveLength(1);
  });

  // A move whose reply is lost may still have happened, so the retry reads where the file is.
  it("finishes a move whose reply was lost without moving again", async () => {
    await hooks().grant("test-user", [CREATED_FILES_GRANT]);
    await hooks().createResource("place-lost", SHEETS_PATTERN, "Budget");
    loseMoveReply = true;

    expect(await hooks().applyCreation("place-lost", "test-user", folderUrl("folder-1"))).toMatchObject({
      error: expect.stringContaining(
        'The Google spreadsheet at https://docs.google.com/spreadsheets/d/sheet-1/edit was created, but moving it into "Plans" failed'),
    });
    expect(await hooks().applyCreation("place-lost", "test-user", folderUrl("folder-1")))
      .toEqual({ resourceUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" });
    expect(moves()).toHaveLength(1);
    expect(drive["sheet-1"].parents).toEqual(["folder-1"]);
    expect(sheetPosts()).toHaveLength(1);
  });

  // Only the account a file was made in can move it, and `root` is each account's own My Drive.
  it("lets another approver's retry bind the file only where it already is", async () => {
    await hooks().grant("test-user", [CREATED_FILES_GRANT]);
    await hooks().grant("other-user", [CREATED_FILES_GRANT]);
    await hooks().createResource("place-other", SHEETS_PATTERN, "Budget");
    let created = { resourceUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit" };
    let elsewhere = "This Google spreadsheet was already created in another approver's Google account. " +
      "Ask them to approve it";

    expect(await hooks().applyCreation("place-other", "test-user", folderUrl("root"))).toEqual(created);
    for (let place of ["root", "folder-1"]) {
      expect(await hooks().applyCreation("place-other", "other-user", folderUrl(place)))
        .toEqual({ error: `${elsewhere}.` });
    }
    expect(await hooks().applyCreation("place-other", "test-user", folderUrl("folder-1"))).toEqual(created);
    expect(await hooks().applyCreation("place-other", "other-user", folderUrl("folder-1"))).toEqual(created);
    expect(await hooks().applyCreation("place-other", "other-user", folderUrl("root")))
      .toEqual({ error: `${elsewhere}, or approve it for the folder folder-1.` });
    expect(moves()).toEqual([["folder-1", "root-id"]]);
    expect(sheetPosts()).toHaveLength(1);
  });

  it.each([
    ["a folder the account can't add to", folderUrl("viewer-1"), [CREATED_FILES_GRANT],
      "The Google account creating this can't add files to the folder viewer-1. " +
      "Approve it again with a folder that account can add files to."],
    ["a folder that is gone", folderUrl("missing-1"), [CREATED_FILES_GRANT],
      "The Google account creating this can't add files to the folder missing-1. " +
      "Approve it again with a folder that account can add files to."],
    ["a folder, without the created-files grant", folderUrl("folder-1"), [],
      "This Google account hasn't let this app put what it creates in Drive folders. " +
      "Approve it again and allow access when asked."],
    ["anything but a folder", "https://docs.google.com/document/d/doc-1/edit", [CREATED_FILES_GRANT],
      "A new Google file can only be put in a Google Drive folder."],
    ["a file named as a folder", folderUrl("sheet-1"), [CREATED_FILES_GRANT],
      "The Google account creating this can't add files to the folder sheet-1. " +
      "Approve it again with a folder that account can add files to."],
    ["a trashed folder", folderUrl("trashed-1"), [CREATED_FILES_GRANT],
      "The Google account creating this can't add files to the folder trashed-1. " +
      "Approve it again with a folder that account can add files to."],
  ])("refuses %s before creating anything", async (_name, configuration, grants, error) => {
    await hooks().grant("test-user", grants);
    await hooks().createResource("place-refused", SHEETS_PATTERN, "Budget");
    expect(await hooks().applyCreation("place-refused", "test-user", configuration)).toEqual({ error });
    expect(sheetPosts()).toEqual([]);
  });
});

describe("creating a Google Drive folder", () => {
  const created = { resourceUrl: "https://drive.google.com/drive/folders/folder-new-1" };
  const grants = [CREATED_FILES_GRANT, FOLDER_PATTERN];

  it("reads as an empty folder until created, then makes it where chosen", async () => {
    await hooks().grant("test-user", grants);
    expect(await hooks().createResource("create-folder", FOLDER_PATTERN, "Q3 plans"))
      .toMatchObject({ action: { title: "Create Google Drive Folder: Q3 plans" } });
    expect(await hooks().describe("create-folder")).toMatchObject({
      title: "Q3 plans", url: "https://drive.google.com/drive/", tsType: "GoogleDriveFolderSession",
    });
    expect(await hooks().readDriveFolder("create-folder")).toEqual({
      scope: { kind: "folder", folderId: "", rootFolderId: "", name: "Q3 plans" }, entries: null,
    });
    expect(await hooks().lastObservations).toEqual([
      'Listed Drive folder "Q3 plans", not created yet: empty.',
      'Read the name of Drive folder "Q3 plans", not created yet.',
    ]);
    expect(requests).toEqual([]);

    expect(await hooks().applyCreation("create-folder", "test-user", folderUrl("folder-1"))).toEqual(created);
    expect(await hooks().applyCreation("create-folder", "test-user", folderUrl("folder-1"))).toEqual(created);
    expect(folderPosts().map(({ body }) => body))
      .toEqual([{ id: "folder-new-1", name: "Q3 plans", mimeType: FOLDER_MIME_TYPE, parents: ["folder-1"] }]);

    // The binding then switches to the folder made.
    await hooks().adoptCreated("create-folder");
    expect(await hooks().describe("create-folder"))
      .toMatchObject({ title: "Q3 plans", url: "https://drive.google.com/drive/folders/folder-new-1" });
  });

  // Its ID is reserved before the create is sent, and kept whatever Drive answers, since a
  // replayed create's answer says nothing of the attempts before it. Sent again, by the request and
  // by a retry, under that one ID, it is answered 409 once made, so Drive makes the folder once.
  it.each([
    ["only lost replies", ["lost", "lost", "lost"] as const, "503"],
    ["a refusal after a lost reply", ["lost", "refused"] as const, "403"],
  ])("makes a folder once when an approval's create gets %s", async (_name, answers, status) => {
    let facet = `create-folder-${answers.join("-")}`;
    await hooks().grant("test-user", grants);
    await hooks().createResource(facet, FOLDER_PATTERN, "Q3 plans");
    createAnswers = [...answers];
    expect(await hooks().applyCreation(facet, "test-user", folderUrl("folder-1")))
      .toMatchObject({ error: expect.stringContaining(status) });
    // A retry for My Drive moves the folder made in Plans there.
    expect(await hooks().applyCreation(facet, "test-user", folderUrl("root"))).toEqual(created);
    expect(folderPosts()).toHaveLength(answers.length + 1);
    expect(generatedIds).toBe(1);
    expect(Object.values(drive).filter(file => file.name === "Q3 plans").map(file => file.id)).toEqual(["folder-new-1"]);
    expect(drive["folder-new-1"].parents).toEqual(["root-id"]);
  });

  it("refuses a retry whose folder was trashed after its create's reply was lost", async () => {
    await hooks().grant("test-user", grants);
    await hooks().createResource("create-folder-trashed", FOLDER_PATTERN, "Q3 plans");
    createAnswers = ["lost", "lost", "lost"];
    expect(await hooks().applyCreation("create-folder-trashed", "test-user", folderUrl("folder-1")))
      .toMatchObject({ error: expect.stringContaining("503") });

    // The retry's create is answered 409, so the folder made under the ID is read back.
    drive["folder-new-1"].trashed = true;
    expect(await hooks().applyCreation("create-folder-trashed", "test-user", folderUrl("folder-1"))).toEqual({
      error: "The Google Drive folder created for this approval is gone or in the trash, or its Google " +
        "account can no longer reach it. Reject the creation and ask for a new one.",
    });
    expect(generatedIds).toBe(1);
  });

  it.each([
    ["the created-files grant", [FOLDER_PATTERN], "hasn't let this app put what it creates in Drive folders. " +
      "Approve it again and allow access when asked."],
    ["the Drive folder grant", [CREATED_FILES_GRANT], "hasn't granted Google Drive Folder access, so the new " +
      "folder's connection could read only what this app puts in it. Grant it, then approve this again."],
  ])("needs %s even in My Drive", async (name, held, error) => {
    await hooks().grant("test-user", held);
    await hooks().createResource(name, FOLDER_PATTERN, "Q3 plans");
    expect(await hooks().applyCreation(name)).toEqual({ error: `This Google account ${error}` });
    expect(requests).toEqual([]);
  });
});
