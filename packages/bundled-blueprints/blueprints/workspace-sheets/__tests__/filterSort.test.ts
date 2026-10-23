// @vitest-environment node
import { describe, expect, it } from "vitest";
import { moveFilterFormula } from "../files/lib/filterSort.ts";
import type { FilterSortFormula, SheetFilter } from "../files/lib/protocol.ts";

// Rows are zero-based, as in SheetFilter.rowOrder. Each call is the actual cell-value
// transformation used when the client moves a filter record, including after a reload.
describe("filter-sort formula recovery", () => {
  it("recovers B4's =A1 after A1:A4 = 10,b,c,a sorts B4 up to B2 as =#REF!", () => {
    const ascending = moveFilterFormula("=A1", undefined, 3, 1);
    expect(ascending).toEqual({ value: "=#REF!", sortFormula: { value: "=A1", row: 3 } });

    const filter: SheetFilter = {
      row: 0, endRow: 3, columns: [0, 1], criteria: {}, rowOrder: [3, 1, 2],
      sort: { column: 0, direction: "asc" }, sortFormulas: { B4: { value: "=A1", row: 3 } },
    };
    const reloaded = JSON.parse(JSON.stringify({ filter, value: ascending.value })) as { filter: SheetFilter; value: string };
    const cleared = moveFilterFormula(reloaded.value, reloaded.filter.sortFormulas?.B4, 1, reloaded.filter.rowOrder[0]);
    expect(cleared.value).toBe("=A1");
  });

  it("always shifts from the captured formula through repeated ascending/descending orders", () => {
    let value = "=A1", sortFormula: FilterSortFormula | undefined, currentRow = 3;
    // Ascending puts a first; descending puts it last. The intermediate row also exercises
    // a different ordering before Clear sort returns the record to its original row.
    for (const targetRow of [1, 3, 1, 2, 3]) {
      const moved = moveFilterFormula(value, sortFormula, currentRow, targetRow);
      expect(moved.value).toBe(targetRow === 3 ? "=A1" : "=#REF!");
      expect(moved.sortFormula).toEqual({ value: "=A1", row: 3 });
      value = moved.value; sortFormula = moved.sortFormula; currentRow = targetRow;
    }
  });

  it("recovers mixed and absolute components without changing their lock semantics", () => {
    const original = "=A1+$A1+A$1+$A$1+B2";
    const first = moveFilterFormula(original, undefined, 3, 1);
    expect(first.value).toBe("=#REF!+#REF!+A$1+$A$1+#REF!");
    const next = moveFilterFormula(first.value, first.sortFormula, 1, 2);
    expect(next.value).toBe("=#REF!+#REF!+A$1+$A$1+B1");
    expect(moveFilterFormula(next.value, next.sortFormula, 2, 3).value).toBe(original);
  });

  it("preserves quoted text, literal backslashes and escaped sheet names exactly on Clear sort", () => {
    const original = String.raw`=IF(A1,"C:\",'it\'s A1')&'Owner\'s Sheet'!$B2+LOG10(C4)+Q1!D4`;
    const first = moveFilterFormula(original, undefined, 3, 1);
    expect(first.value).toBe(String.raw`=IF(#REF!,"C:\",'it\'s A1')&#REF!+LOG10(C2)+Q1!D2`);
    expect(moveFilterFormula(first.value, first.sortFormula, 1, 3).value).toBe(original);
  });

  it("keeps the exact original spelling and spacing rather than a shifted normalization", () => {
    const original = "= sum(a1 : b2) + $c$3";
    const first = moveFilterFormula(original, undefined, 3, 1);
    expect(first.value).toBe("= sum(#REF! : #REF!) + $C$3");
    expect(moveFilterFormula(first.value, first.sortFormula, 1, 3).value).toBe(original);
    expect(moveFilterFormula(original, undefined, 3, 3).value).toBe(original);
  });

  it("recovers references that moved beyond the editable grid's upper row bound", () => {
    const first = moveFilterFormula("=A49999", undefined, 1, 3);
    expect(first.value).toBe("=A50001");
    expect(moveFilterFormula(first.value, first.sortFormula, 3, 1).value).toBe("=A49999");
  });

  it("does not restore captured originals over subsequent formula or text edits", () => {
    const original = { value: "=A1", row: 3 };
    const edited = moveFilterFormula("=B2", original, 1, 3);
    expect(edited).toEqual({ value: "=B4", sortFormula: { value: "=B2", row: 1 } });
    const sortedAgain = moveFilterFormula(edited.value, edited.sortFormula, 3, 1);
    expect(sortedAgain.value).toBe("=B2");
    expect(moveFilterFormula("replacement", original, 1, 3)).toEqual({ value: "replacement" });
    expect(moveFilterFormula("", original, 1, 3)).toEqual({ value: "" });
  });

  it("recaptures an edited formula at its current row and recovers repeated lossy sorts after reload", () => {
    // This record originally occupied row 2, moved to row 4, and was then edited to =A1.
    // Reverse-projecting the edit to the old row would lose A1 before sorting starts.
    const edited = moveFilterFormula("=A1", { value: "=B4", row: 1 }, 3, 2);
    expect(edited).toEqual({ value: "=#REF!", sortFormula: { value: "=A1", row: 3 } });
    const filter: SheetFilter = {
      row: 0, endRow: 3, columns: [0, 1], criteria: {}, rowOrder: [2, 1, 3],
      sort: { column: 0, direction: "asc" }, sortFormulas: { B2: { value: "=A1", row: 3 } },
    };
    const reloaded = JSON.parse(JSON.stringify({ filter, value: edited.value })) as { filter: SheetFilter; value: string };
    let value = reloaded.value, sortFormula = reloaded.filter.sortFormulas?.B2, currentRow = 2;
    for (const targetRow of [1, 3, 2, 3]) {
      const moved = moveFilterFormula(value, sortFormula, currentRow, targetRow);
      expect(moved.value).toBe(targetRow === 3 ? "=A1" : "=#REF!");
      expect(moved.sortFormula).toEqual({ value: "=A1", row: 3 });
      value = moved.value; sortFormula = moved.sortFormula; currentRow = targetRow;
    }
    // Clear sort respects the new edit's relative semantics; it must not revive old =B4.
    expect(moveFilterFormula(value, sortFormula, currentRow, 1).value).toBe("=#REF!");
  });

  it("supports older sorted filters without inventing already-lost references", () => {
    const legacy = moveFilterFormula("=A2", undefined, 1, 2);
    expect(legacy).toEqual({ value: "=A3", sortFormula: { value: "=A2", row: 1 } });
    expect(moveFilterFormula(legacy.value, legacy.sortFormula, 2, 3).value).toBe("=A4");
    expect(moveFilterFormula("=#REF!", undefined, 1, 3).value).toBe("=#REF!");
  });

  it.each(["plain A1", "'=A1", "42", ""])('leaves non-formula value "%s" untouched and does not capture recovery', (value) => {
    expect(moveFilterFormula(value, undefined, 3, 1)).toEqual({ value });
  });
});
