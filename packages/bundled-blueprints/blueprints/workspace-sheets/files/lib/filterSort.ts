import { shiftFormulaReferences } from "./formula.ts";
import type { FilterSortFormula } from "./protocol.ts";

/** Move a filter record's formula from its captured text, not from a potentially lossy prior shift. */
export function moveFilterFormula(
  value: string,
  sortFormula: FilterSortFormula | undefined,
  currentRow: number,
  targetRow: number,
): { value: string; sortFormula?: FilterSortFormula } {
  if (!value.startsWith("=")) return { value };

  // An edit (local, remote, pasted or undone) invalidates only this cell's captured text.
  // Keep its new anchor too: projecting an edited formula back to the original row can
  // itself erase a reference before the next sort even starts. Older filters capture
  // their current text; already-lost components cannot be inferred from #REF!.
  const expected = sortFormula === undefined ? undefined : sortFormula.row === currentRow
    ? sortFormula.value
    : shiftFormulaReferences(sortFormula.value, currentRow - sortFormula.row, 0);
  const captured = sortFormula !== undefined && expected === value ? sortFormula : { value, row: currentRow };

  // A zero-distance move retains the exact spelling, rather than normalizing references.
  return { value: captured.row === targetRow ? captured.value : shiftFormulaReferences(captured.value, targetRow - captured.row, 0), sortFormula: captured };
}

