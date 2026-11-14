// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SheetOrder, type LineOp } from "../files/lib/lines.ts";
import { type RefContext, hasStoredRefs, render, renderRange, storeRange, storedSheets, toStored } from "../files/lib/refs.ts";

/** A line operation without its sheet (the tests name it separately). */
type SheetLineOp = LineOp extends infer T ? (T extends LineOp ? Omit<T, "sheetId"> : never) : never;

// A workbook of named sheets with their orders.
function workbook(sheets: Record<string, { name: string; rows?: number; cols?: number }>) {
  const orders = new Map(Object.entries(sheets).map(([id, s]) => [id, SheetOrder.from(null, s.rows ?? 20, s.cols ?? 10)]));
  const names = new Map(Object.entries(sheets).map(([id, s]) => [id, s.name]));
  const ctx = (sheetId: string): RefContext => ({
    sheetId,
    order: (id) => orders.get(id),
    sheetIdByName: (name) => [...names].find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0],
    sheetName: (id) => names.get(id),
  });
  const apply = (sheetId: string, op: SheetLineOp) => orders.get(sheetId)!.axis(op.axis).apply({ ...op, sheetId } as LineOp);
  return { orders, names, ctx, apply };
}
const rowIds = (book: ReturnType<typeof workbook>, sheetId: string, from: number, count: number) => book.orders.get(sheetId)!.rows.live().slice(from, from + count);

describe("stored formulas", () => {
  it("round-trip as typed", () => {
    const book = workbook({ a: { name: "Sheet1" }, b: { name: "Q1 Sales" } });
    for (const text of ["=A1+B2", "=SUM(A1:B5)", "=$A$1*B$2+$C3", "='Q1 Sales'!A1", "=SUM('Q1 Sales'!A1:B3)", "=\"A1\"&A1", "=SUM(A1 : B2)", "=A60", "=Nope!A1", "=A1:'Q1 Sales'!B2", "=SUM(Sheet1!A1:Sheet1!B2)"]) {
      expect(render(toStored(text, book.ctx("a")), book.ctx("a"))).toBe(text);
    }
    expect(toStored("hello A1", book.ctx("a"))).toBe("hello A1");
    expect(hasStoredRefs(toStored("=\"A1\"", book.ctx("a")))).toBe(false);
  });

  it("keeps pointing at a renamed sheet", () => {
    const book = workbook({ a: { name: "Sheet1" }, b: { name: "Data" } });
    const stored = toStored("=Data!B2*2", book.ctx("a"));
    expect(storedSheets(stored)).toEqual(new Set(["b"]));
    book.names.set("b", "Owner's data");
    expect(render(stored, book.ctx("a"))).toBe("='Owner''s data'!B2*2");
    book.names.delete("b");
    expect(render(stored, book.ctx("a"))).toBe("=#REF!*2");
  });

  it("drops marker characters typed into a formula", () => {
    const book = workbook({ a: { name: "Sheet1" } });
    const stored = toStored("=\"x\uE000y\"&A1", book.ctx("a"));
    expect(render(stored, book.ctx("a"))).toBe("=\"xy\"&A1");
  });

  // The rules the server and grid applied to formula text on an insert or delete (the agent's
  // insertRows/deleteRows and the grid's menu) now fall out of reading ids.
  describe("follow inserted and deleted lines as formulas always did", () => {
    const cases: [string, string, SheetLineOp, string][] = [
      ["insert above a reference", "=A1+A3", { kind: "insert", axis: "rows", ids: [100, 101], before: 2 }, "=A1+A5"],
      ["insert inside a range", "=SUM(A1:A5)", { kind: "insert", axis: "rows", ids: [100, 101], before: 2 }, "=SUM(A1:A7)"],
      ["insert above a range", "=SUM(A3:A5)", { kind: "insert", axis: "rows", ids: [100], before: 0 }, "=SUM(A4:A6)"],
      ["insert below a range", "=SUM(A1:A2)", { kind: "insert", axis: "rows", ids: [100], before: 2 }, "=SUM(A1:A2)"],
      ["insert above an absolute reference", "=$A$3", { kind: "insert", axis: "rows", ids: [100], before: 1 }, "=$A$4"],
      ["delete a referenced cell", "=A2+1", { kind: "delete", axis: "rows", ids: [1] }, "=#REF!+1"],
      ["delete inside a range", "=SUM(A1:A5)", { kind: "delete", axis: "rows", ids: [1, 2] }, "=SUM(A1:A3)"],
      ["delete a range's first line", "=SUM(A2:A5)", { kind: "delete", axis: "rows", ids: [1] }, "=SUM(A2:A4)"],
      ["delete a range's last line", "=SUM(A2:A5)", { kind: "delete", axis: "rows", ids: [4] }, "=SUM(A2:A4)"],
      ["delete a whole range", "=SUM(A2:A3)", { kind: "delete", axis: "rows", ids: [1, 2] }, "=SUM(#REF!)"],
      ["delete above a reference", "=A4", { kind: "delete", axis: "rows", ids: [0, 1] }, "=A2"],
      ["insert a column", "=C1+$B$1", { kind: "insert", axis: "cols", ids: [100], before: 1 }, "=D1+$C$1"],
      ["delete a column", "=SUM(A1:D1)", { kind: "delete", axis: "cols", ids: [2] }, "=SUM(A1:C1)"],
    ];
    for (const [name, before, op, after] of cases) {
      it(name, () => {
        const book = workbook({ a: { name: "Sheet1" } });
        const stored = toStored(before, book.ctx("a"));
        book.apply("a", op);
        expect(render(stored, book.ctx("a"))).toBe(after);
      });
    }

    it("only for references into the changed sheet", () => {
      const book = workbook({ a: { name: "Sheet1" }, b: { name: "Sheet2" } });
      const own = toStored("=A3", book.ctx("b")), into = toStored("=Sheet1!A3+'Sheet1'!A1", book.ctx("b"));
      book.apply("a", { kind: "insert", axis: "rows", ids: [100], before: 0 });
      expect(render(own, book.ctx("b"))).toBe("=A3");
      expect(render(into, book.ctx("b"))).toBe("=Sheet1!A4+Sheet1!A2");
    });
  });

  it("writes a range first line first, each end keeping its own $", () => {
    const book = workbook({ a: { name: "Sheet1" } });
    expect(render(toStored("=SUM($B$5:A1)", book.ctx("a")), book.ctx("a"))).toBe("=SUM(A1:$B$5)");
    expect(render(toStored("=SUM($A5:B$1)", book.ctx("a")), book.ctx("a"))).toBe("=SUM($A$1:B5)");
  });

  it("moves a range's end with the line it ends on", () => {
    const book = workbook({ a: { name: "Sheet1" } });
    const stored = toStored("=SUM(A2:A4)", book.ctx("a"));
    // Row 4 moved above row 2: the range spans what lies between its ends (the cut-insert rule),
    // written first row first.
    book.apply("a", { kind: "move", axis: "rows", ids: rowIds(book, "a", 3, 1), before: rowIds(book, "a", 1, 1)[0] });
    expect(render(stored, book.ctx("a"))).toBe("=SUM(A2:A3)");
    // Moving rows inside the range keeps it whole.
    const inner = toStored("=SUM(A1:A6)", book.ctx("a"));
    book.apply("a", { kind: "move", axis: "rows", ids: rowIds(book, "a", 2, 2), before: rowIds(book, "a", 4, 1)[0] });
    expect(render(inner, book.ctx("a"))).toBe("=SUM(A1:A6)");
  });

  it("gives the same result whichever order an insert and a delete land in", () => {
    const run = (first: SheetLineOp, second: SheetLineOp) => {
      const book = workbook({ a: { name: "Sheet1" } });
      const stored = toStored("=SUM(A2:A6)+A7", book.ctx("a"));
      book.apply("a", first); book.apply("a", second);
      return render(stored, book.ctx("a"));
    };
    const ins: SheetLineOp = { kind: "insert", axis: "rows", ids: [500], before: 5 };
    const rm: SheetLineOp = { kind: "delete", axis: "rows", ids: [5, 6] };
    expect(run(ins, rm)).toBe(run(rm, ins));
    expect(run(ins, rm)).toBe("=SUM(A2:A6)+#REF!");
  });

  it("keeps references past the sheet's edge at their position", () => {
    const book = workbook({ a: { name: "Sheet1", rows: 10 } });
    const stored = toStored("=SUM(A1:A30)+A40", book.ctx("a"));
    book.apply("a", { kind: "insert", axis: "rows", ids: Array.from({ length: 30 }, (_, i) => 1000 + i), before: null });
    expect(render(stored, book.ctx("a"))).toBe("=SUM(A1:A30)+A40");
  });

  it("moves references past the sheet's edge with the lines above them", () => {
    const book = workbook({ a: { name: "Sheet1", rows: 10 } });
    const stored = toStored("=SUM(A5:A30)+A40", book.ctx("a"));
    book.apply("a", { kind: "insert", axis: "rows", ids: [1000, 1001], before: 0 });
    expect(render(stored, book.ctx("a"))).toBe("=SUM(A7:A32)+A42");
    book.apply("a", { kind: "delete", axis: "rows", ids: [9] });
    expect(render(stored, book.ctx("a"))).toBe("=SUM(A7:A31)+A41");
    book.apply("a", { kind: "insert", axis: "rows", ids: Array.from({ length: 40 }, (_, i) => 2000 + i), before: null });
    expect(render(stored, book.ctx("a"))).toBe("=SUM(A7:A31)+A41");
    book.apply("a", { kind: "insert", axis: "rows", ids: [3000], before: 0 });
    expect(render(stored, book.ctx("a"))).toBe("=SUM(A8:A32)+A42");
  });

  it("stores chart and pivot ranges", () => {
    const order = SheetOrder.from(null, 10, 5);
    const stored = storeRange("B2:C5", order);
    order.rows.apply({ kind: "insert", sheetId: "a", axis: "rows", ids: [99], before: 0 });
    expect(renderRange(stored, order)).toBe("B3:C6");
    order.rows.apply({ kind: "delete", sheetId: "a", axis: "rows", ids: [1, 2, 3, 4] });
    expect(renderRange(stored, order)).toBe("");
    expect(storeRange("not a range", order)).toBe("not a range");
  });
});
