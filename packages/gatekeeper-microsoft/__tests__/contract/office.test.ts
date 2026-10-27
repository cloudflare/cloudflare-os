// Word, Excel and PowerPoint against the live tenant, in a scratch folder of their own: files
// written from Markdown and rows, edited in place, copied, and reverted, each checked the way a
// person would meet it, by having Microsoft 365 itself open and render it, then reading it back.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriveEntry, FileContent, PresentationContent, WorkbookContent } from "../../src/types";
import type { GatekeeperProps } from "../workerd/worker";
import { bind, connect, failure, facet, hooks, live, origin, run, unwrap } from "./tenant";

type Submitted = { actionId: number; description: { title: string; description: string } };

const SCRATCH = `Gadgets office ${new Date().toISOString().replace(/[:.]/g, "-")}`;
let scratchId: string | undefined;
let driveId: string;
let folder: string;

/** The action the facet's queue last recorded, applied as an approver would. */
async function approveLast(name: string, props: GatekeeperProps): Promise<Submitted> {
  const last = (await hooks().queueLog(name)).submitted.at(-1) as Submitted;
  unwrap(await hooks().applyAction(name, props, last.actionId));
  return last;
}

/** Everything the approver is shown for an action. */
function shown(action: Submitted): string {
  return JSON.stringify(action.description);
}

/** Proposes, approves and returns the real entry of a new file. */
async function create(name: string, props: GatekeeperProps, file: string, content: unknown, options?: unknown): Promise<{ entry: DriveEntry; proposed: Submitted }> {
  const pending = unwrap<DriveEntry>(await run(name, props, [["uploadFile", folder, file, content, ...(options ? [options] : [])]]));
  const proposed = await approveLast(name, props);
  return { entry: unwrap<DriveEntry>(await run(name, props, [["getEntry", pending.id]])), proposed };
}

/** How Microsoft 365 renders a file: it fails for anything Office for the web can't open. */
async function rendered(entry: DriveEntry): Promise<{ size: number; pages: number }> {
  const [drive, item] = entry.id.split("/");
  return unwrap(await hooks().renderPdf(await connect("phillip"), drive!, item!));
}

const BRIEF = [
  "# Apollo launch brief",
  "",
  "The launch moves to **March 3**, pending _legal review_.",
  "",
  "## Milestones",
  "",
  "1. Freeze the feature set",
  "2. Brief the [support team](https://example.com/support)",
  "   - Write the runbook",
  "",
  "| Owner | Task | Due |",
  "| --- | --- | ---: |",
  "| Ada | Runbook | Feb 20 |",
  "| Grace | Pricing | Feb 27 |",
  "",
  "> Decisions are final once the steering group signs off.",
  "",
].join("\n");

const DECK = [
  "# Apollo",
  "",
  "Launch review, Q1",
  "",
  "# Where we are",
  "",
  "- Feature set frozen",
  "- Support briefed",
  "  - Runbook in review",
  "",
  "> Notes: Pause for questions here.",
  "",
  "# Owners",
  "",
  "| Owner | Area |",
  "| --- | --- |",
  "| Ada | Support |",
  "| Grace | Pricing |",
  "",
].join("\n");

describe.skipIf(!live)("Office files, bound to a scratch folder", () => {
  let props: GatekeeperProps;

  beforeAll(async () => {
    const phillip = await connect("phillip");
    const library = unwrap<{ scope: { driveId: string } }>(
      await hooks().resolve(phillip, `${await origin()}/sites/Engineering/Shared%20Documents`));
    driveId = library.scope.driveId;
    const created = unwrap<{ id: string }>(await hooks().graph(phillip, "POST", `/drives/${driveId}/root/children`,
      { name: SCRATCH, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }));
    scratchId = created.id;
    folder = `${driveId}/${scratchId}`;
    props = await bind("phillip", `${await origin()}/sites/Engineering/Shared%20Documents/${encodeURIComponent(SCRATCH)}`);
  });

  afterAll(async () => {
    if (scratchId) await hooks().graph(await connect("phillip"), "DELETE", `/drives/${driveId}/items/${scratchId}`);
  });

  it("writes a Word document from Markdown that Office opens and reads back the same", async () => {
    const name = facet("office-docx");
    const pending = unwrap<DriveEntry>(await run(name, props, [["uploadFile", folder, "Brief.docx", BRIEF]]));
    expect(pending.mimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    // Before approval, the pending document reads back as the Markdown it was written from.
    const staged = unwrap<FileContent>(await run(name, props, [["readFile", pending.id]]));
    expect(staged.content).toContain("# Apollo launch brief");
    // The approver sees the source and what it becomes.
    const proposed = await approveLast(name, props);
    expect(shown(proposed)).toContain("Word document");
    expect(shown(proposed)).toContain("Apollo launch brief");

    const entry = unwrap<DriveEntry>(await run(name, props, [["getEntry", pending.id]]));
    expect((await rendered(entry)).pages).toBeGreaterThanOrEqual(1);
    const read = unwrap<FileContent>(await run(name, props, [["readFile", entry.id]]));
    expect(read.format).toBe("markdown");
    for (const text of ["# Apollo launch brief", "## Milestones", "**March 3**", "Freeze the feature set", "| Ada | Runbook | Feb 20 |", "> Decisions"]) {
      expect(read.content).toContain(text);
    }
  });

  it("edits a Word document in place as tracked changes, and reverts the edit", async () => {
    const name = facet("office-docx-edit");
    const { entry } = await create(name, props, "Edited.docx", BRIEF);
    unwrap(await run(name, props, [["editDocument", entry.id, [
      { find: "March 3", replace: "March 10" },
      { insertAfter: "Freeze the feature set", markdown: "Pricing is approved by finance." },
      { deleteParagraph: "Decisions are final" },
    ]]]));
    const proposed = (await hooks().queueLog(name)).submitted.at(-1) as Submitted;
    expect(proposed.description.title).toContain("Edit");
    expect(shown(proposed)).toContain("March 10");
    expect(shown(proposed)).toMatch(/tracked change/i);
    // The pending edit reads back as made.
    const staged = unwrap<FileContent>(await run(name, props, [["readFile", entry.id]]));
    expect(staged.content).toContain("March 10");
    expect(staged.content).toContain("Pricing is approved by finance.");
    // A second edit would show only its own change, yet write the pending one's too.
    expect(failure(await run(name, props, [["editDocument", entry.id, [{ find: "Pricing", replace: "Price" }]]]))).toMatch(/awaiting approval/);
    expect(failure(await run(name, props, [["replaceFile", entry.id, "# Brief"]]))).toMatch(/awaiting approval/);

    unwrap(await hooks().applyAction(name, props, proposed.actionId));
    expect(failure(await run(name, props, [["replaceFile", entry.id, "# Brief", { ifUnchanged: "*" }]]))).toMatch(/ifUnchanged takes/);
    expect((await rendered(entry)).pages).toBeGreaterThanOrEqual(1);
    const edited = unwrap<FileContent>(await run(name, props, [["readFile", entry.id]]));
    expect(edited.content).toContain("March 10");
    expect(edited.content).not.toContain("Decisions are final");
    // Everything not edited stays as it was.
    expect(edited.content).toContain("| Grace | Pricing | Feb 27 |");

    unwrap(await hooks().revertAction(name, props, proposed.actionId));
    const reverted = unwrap<FileContent>(await run(name, props, [["readFile", entry.id]]));
    expect(reverted.content).toContain("March 3");
    expect(reverted.content).not.toContain("March 10");
  });

  it("refuses an edit whose text isn't in the document, or is in it more than once", async () => {
    const name = facet("office-docx-refuse");
    const { entry } = await create(name, props, "Refuse.docx", BRIEF);
    expect(failure(await run(name, props, [["editDocument", entry.id, [{ find: "not in the brief", replace: "x" }]]]))).toMatch(/not in the brief/);
    expect(failure(await run(name, props, [["editDocument", entry.id, [{ find: "the", replace: "a" }]]]))).toMatch(/more than once|times|all/);
  });

  // Excel's calculation sessions slow down sharply while the other suites run beside it.
  it("writes a workbook from rows whose formulas show their results everywhere, and sets cells in place", { timeout: 150_000 }, async () => {
    const name = facet("office-xlsx");
    const { entry, proposed } = await create(name, props, "Budget.xlsx", [
      { name: "Costs", rows: [["Item", "Q1", "Q2"], ["Rent", 1200, 1250], ["Travel", 300.5, 410.25], ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)"]] },
      { name: "Notes", rows: [["Note"], ["Figures in USD"]] },
    ]);
    expect(shown(proposed)).toContain("Excel workbook");
    expect((await rendered(entry)).pages).toBeGreaterThanOrEqual(1);
    const book = unwrap<WorkbookContent>(await run(name, props, [["readWorkbook", entry.id]]));
    expect(book.worksheets.map(sheet => sheet.name)).toEqual(["Costs", "Notes"]);
    const costs = book.worksheets[0]!;
    expect(costs.formulas[3]).toEqual(["Total", "=SUM(B2:B3)", "=SUM(C2:C3)"]);
    expect(costs.values[3]).toEqual(["Total", 1500.5, 1660.25]);

    // One cell, in place: the pending change shows in reads, then applies, recalculating the total.
    const updated = unwrap<DriveEntry>(await run(name, props, [["updateCells", entry.id, "costs", "B2", [[1300]]]]));
    expect(updated.pending).toBe("update");
    const change = (await hooks().queueLog(name)).submitted.at(-1) as Submitted;
    expect(shown(change)).toContain("B2: 1200 → 1300");
    const staged = unwrap<WorkbookContent>(await run(name, props, [["readWorkbook", entry.id, { sheet: "Costs" }]]));
    expect(staged.worksheets[0]!.values[1]).toEqual(["Rent", 1300, 1250]);
    unwrap(await hooks().applyAction(name, props, change.actionId));
    const after = unwrap<WorkbookContent>(await run(name, props, [["readWorkbook", entry.id, { sheet: "Costs" }]]));
    expect(after.worksheets[0]!.values[3]).toEqual(["Total", 1600.5, 1660.25]);
    // The other sheet is untouched.
    const notes = unwrap<WorkbookContent>(await run(name, props, [["readWorkbook", entry.id, { sheet: "Notes" }]]));
    expect(notes.worksheets[0]!.values).toEqual([["Note"], ["Figures in USD"]]);

    unwrap(await hooks().revertAction(name, props, change.actionId));
    const reverted = unwrap<WorkbookContent>(await run(name, props, [["readWorkbook", entry.id, { sheet: "Costs" }]]));
    expect(reverted.worksheets[0]!.values[1]).toEqual(["Rent", 1200, 1250]);

    // Fenced on the eTag a read gave, as the agent API says to, it applies while nothing changed.
    const fresh = unwrap<DriveEntry>(await run(name, props, [["getEntry", entry.id]]));
    unwrap(await run(name, props, [["updateCells", entry.id, "Costs", "C2", [[1260]], { ifUnchanged: fresh.eTag }]]));
    const fenced = (await hooks().queueLog(name)).submitted.at(-1) as Submitted;
    unwrap(await hooks().applyAction(name, props, fenced.actionId));
  });

  it("refuses cells it can't write, naming the cell and the worksheets", async () => {
    const name = facet("office-xlsx-refuse");
    const { entry } = await create(name, props, "Refuse.xlsx", "Item,Cost\nRent,1200\n");
    expect(failure(await run(name, props, [["updateCells", entry.id, "Sheet1", "C2", [["=WEBSERVICE(\"https://example.com\")"]]]]))).toMatch(/^C2: .*WEBSERVICE/);
    expect(failure(await run(name, props, [["updateCells", entry.id, "Sheet1", "B2:C2", [[1]]]]))).toMatch(/1 row by 2 columns/);
    expect(failure(await run(name, props, [["updateCells", entry.id, "Totals", "A1", [[1]]]]))).toMatch(/no worksheet named "Totals".*Sheet1/);
    expect(failure(await run(name, props, [["updateCells", entry.id, "Sheet1", "Sheet1!A1", [[1]]]]))).toMatch(/Pass the worksheet separately/);
  });

  it("writes a PowerPoint deck from Markdown, one slide per heading, and edits it in place", async () => {
    const name = facet("office-pptx");
    const { entry, proposed } = await create(name, props, "Review.pptx", DECK);
    expect(shown(proposed)).toContain("PowerPoint deck");
    expect((await rendered(entry)).pages).toBe(3);
    const read = unwrap<FileContent>(await run(name, props, [["readFile", entry.id]]));
    for (const text of ["Apollo", "Where we are", "Feature set frozen", "Owners", "Grace"]) expect(read.content).toContain(text);

    // The structure an agent edits by: layouts and placeholder names.
    const deck = unwrap<PresentationContent>(await run(name, props, [["readPresentation", entry.id]]));
    expect(deck.slides.map(slide => slide.layout)).toEqual(["Title Slide", "Title and Content", "Title and Content"]);
    expect(deck.slides[1]!.placeholders.map(placeholder => placeholder.name)).toEqual(["title", "body"]);
    expect(deck.slides[1]!.notes).toContain("Pause for questions here.");
    expect(deck.layouts).toEqual(expect.arrayContaining(["Two Content", "Comparison", "Section Header"]));

    unwrap(await run(name, props, [["editPresentation", entry.id, [
      { find: "Q1", replace: "Q2" },
      { setText: { slide: 2, placeholder: "body", markdown: "- Feature set frozen\n- Support trained\n  - Runbook approved" } },
      { duplicateSlide: 2, after: 3 },
      { setText: { slide: 4, placeholder: "title", markdown: "Where we go next" } },
      { addSlides: "<!-- layout: Two Content -->\n# Options\n\n- Build\n- Own it\n\n+++\n\n- Buy\n- Faster\n" },
      { moveSlide: 5, to: 2 },
      { setNotes: { slide: 1, markdown: "Welcome everyone." } },
    ]]]));
    const edit = await approveLast(name, props);
    expect(shown(edit)).toContain("Q2");
    expect((await rendered(entry)).pages).toBe(5);
    const after = unwrap<PresentationContent>(await run(name, props, [["readPresentation", entry.id]]));
    expect(after.slides.map(slide => slide.placeholders.find(placeholder => placeholder.type === "title")?.markdown))
      .toEqual(["Apollo", "Options", "Where we are", "Owners", "Where we go next"]);
    expect(after.slides[1]!.layout).toBe("Two Content");
    expect(after.slides[0]!.notes).toBe("Welcome everyone.");
    expect(after.slides[2]!.placeholders.find(placeholder => placeholder.name === "body")?.markdown).toContain("Support trained");
    const edited = unwrap<FileContent>(await run(name, props, [["readFile", entry.id]]));
    expect(edited.content).toContain("Launch review, Q2");
  });

  it("writes a document in the look of a template, and copies a file, reverting the copy", async () => {
    const name = facet("office-template-copy");
    const { entry: template } = await create(name, props, "House style.docx", "# House style\n\nUse this look.\n");
    const { entry: styled, proposed } = await create(name, props, "Styled.docx", "# Styled\n\nIn the house style.\n", { template: template.id });
    expect(shown(proposed)).toContain("House style.docx");
    expect((await rendered(styled)).pages).toBeGreaterThanOrEqual(1);
    const read = unwrap<FileContent>(await run(name, props, [["readFile", styled.id]]));
    expect(read.content).toContain("In the house style.");
    expect(read.content).not.toContain("Use this look.");

    const copy = unwrap<DriveEntry>(await run(name, props, [["copyFile", styled.id, folder, "Styled copy.docx"]]));
    expect(copy).toMatchObject({ name: "Styled copy.docx", pending: "create" });
    // The pending copy reads as the file it copies.
    expect(unwrap<FileContent>(await run(name, props, [["readFile", copy.id]])).content).toContain("In the house style.");
    const copied = await approveLast(name, props);
    const real = unwrap<DriveEntry>(await run(name, props, [["getEntry", copy.id]]));
    expect(real.id).not.toMatch(/^~/);
    expect(unwrap<FileContent>(await run(name, props, [["readFile", real.id]])).content).toContain("In the house style.");
    unwrap(await hooks().revertAction(name, props, copied.actionId));
    expect(failure(await run(name, props, [["getEntry", real.id]]))).toBeTruthy();
  });

  it("refuses content that doesn't suit the file's format", async () => {
    const name = facet("office-refuse");
    expect(failure(await run(name, props, [["uploadFile", folder, "Report.pdf", "# Not a PDF"]]))).toMatch(/Text can't be written/);
    expect(failure(await run(name, props, [["uploadFile", folder, "Rows.docx", [["a", "b"]]]]))).toMatch(/Rows can only be written to an Excel workbook/);
    expect(failure(await run(name, props, [["uploadFile", folder, "Fake.docx", new Uint8Array([1, 2, 3])]]))).toMatch(/aren't a docx file/);
    expect(failure(await run(name, props, [["uploadFile", folder, "Bad.xlsx", [["=WEBSERVICE(\"https://example.com\")"]]]]))).toMatch(/WEBSERVICE/);
    const { entry } = await create(name, props, "Sheet.xlsx", "a,b\n1,2\n");
    expect(failure(await run(name, props, [["editDocument", entry.id, [{ find: "a", replace: "b" }]]]))).toMatch(/edits Word documents/);
  });
});
