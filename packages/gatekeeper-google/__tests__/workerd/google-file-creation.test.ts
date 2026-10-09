import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  it("reads as an empty 16:9 deck that takes no changes until created, then creates it", async () => {
    let created = await hooks().createResource("create-deck", SLIDES_PATTERN, "Pitch");
    expect(created).toMatchObject({ action: { title: "Create Google Slides Presentation: Pitch" } });
    expect(await hooks().describe("create-deck")).toMatchObject({
      title: "Pitch",
      url: "https://docs.google.com/presentation/",
    });
    expect(await hooks().callSlides("create-deck", "getPresentation", [])).toMatchObject({
      value: { id: "", title: "Pitch", pageSize: { width: 720, height: 405 }, slides: [] },
    });
    expect(await hooks().callSlides("create-deck", "duplicateSlide", ["p"])).toMatchObject({
      error: expect.stringMatching(/^No slide with ID "p" in "Pitch"/),
      actionId: undefined,
    });
    expect(requests).toEqual([]);

    expect(await hooks().applyCreation("create-deck"))
      .toEqual({ resourceUrl: "https://docs.google.com/presentation/d/deck-1/edit" });
    expect(requests.map(({ url, body }) => [url.href, body])).toEqual([
      ["https://slides.googleapis.com/v1/presentations?fields=presentationId", { title: "Pitch" }],
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
