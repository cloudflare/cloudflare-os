import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NEW_DECK from "../../src/blank-presentation.json";
import type { PresentationInfo, Slide } from "../../src/slides-read-types";

const SHEETS_PATTERN = "https://docs.google.com/spreadsheets/d/:spreadsheetId/*";
const SLIDES_PATTERN = "https://docs.google.com/presentation/d/:presentationId/*";

/** Each provider request, with the body of any POST. */
let requests: { url: URL; method: string; body?: unknown }[];

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    let body = request.method === "POST" ? await request.json() : undefined;
    requests.push({ url, method: request.method, body });
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
