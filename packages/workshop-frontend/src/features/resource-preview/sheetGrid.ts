import type { SpreadsheetArea, SpreadsheetCell } from '@gadgets/workshop-shared/gatekeeper'
import type { ChangeState } from './changeMarks'

/** Sheets' column name for a zero-based index: A..Z, then AA..AZ, BA.., ZZ, AAA... */
export function columnLetter(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

/** A cell's A1 reference, from zero-based row and column indices. */
export const cellReference = (row: number, column: number) => `${columnLetter(column)}${row + 1}`

/** How an area is drawn below the one before it on the same sheet. */
export type AreaBlock = {
  area: SpreadsheetArea
  /** Rows of the sheet lie between this area and the previous, drawn as a "⋯" gap row. */
  gapBefore: boolean
  /** Carries straight on from the previous area's rows and columns, so needs no header of its own. */
  continued: boolean
}

const columnCount = (area: SpreadsheetArea) => Math.max(0, ...area.cells.map(row => row.length))

/** The areas of one sheet top to bottom, each knowing how it joins the one above. */
export function sheetBlocks(areas: readonly SpreadsheetArea[], sheetId: number): AreaBlock[] {
  const ordered = areas.filter(area => area.sheetId === sheetId)
    .toSorted((a, b) => a.row - b.row || a.column - b.column)
  return ordered.map((area, i) => {
    const prev = ordered[i - 1]
    if (!prev) return { area, gapBefore: false, continued: false }
    const adjacent = area.row === prev.row + prev.cells.length
    const sameColumns = area.column === prev.column && columnCount(area) === columnCount(prev)
    return { area, gapBefore: !adjacent, continued: adjacent && sameColumns }
  })
}

export const DEFAULT_COLUMN_WIDTH = 100

/** Each column's width in pixels: the sheet's own where it sets one, else Sheets' default. */
export const columnWidths = (area: SpreadsheetArea) =>
  Array.from({ length: columnCount(area) }, (_, i) => {
    const width = area.columnWidths?.[i]
    return width && Number.isFinite(width) && width > 0 ? Math.min(width, 2000) : DEFAULT_COLUMN_WIDTH
  })

/** A located cell of an area, by its place in the sheet. */
export type LocatedCell = { cell: SpreadsheetCell; row: number; column: number; sheetId: number }

/** Every cell a change enters, in sheet then row order. */
export function changedCells(areas: readonly SpreadsheetArea[]): LocatedCell[] {
  return areas.flatMap(area => area.cells.flatMap((row, r) => row.flatMap((cell, c) =>
    cell && cell.change !== undefined ? [{ cell, row: area.row + r, column: area.column + c, sheetId: area.sheetId }] : [])))
}

/** Every run of lines a change deletes, with its sheet, in sheet then row order. */
export function deletedLines(areas: readonly SpreadsheetArea[]): { sheetId: number; change?: number }[] {
  return areas.flatMap(area => [...area.deletedRows ?? [], ...area.deletedColumns ?? []]
    .map(run => ({ sheetId: area.sheetId, change: run.change })))
}

// Sheets right-aligns numbers, currency and percentages, and centres booleans, unless told
// otherwise; text it leaves to the left.
const NUMBER = /^[-+(]?[$€£¥]?\s?[\d,]*\.?\d+\s?%?\)?$/
export function defaultAlignment(text: string): 'left' | 'center' | 'right' {
  if (NUMBER.test(text.trim())) return 'right'
  if (text === 'TRUE' || text === 'FALSE') return 'center'
  return 'left'
}

const PENDING_FORMULA = 'Calculates when approved'

/** What a cell shows, and its hover text, given where its change stands. */
export function cellDisplay(cell: SpreadsheetCell, state: ChangeState | null) {
  const pendingFormula = cell.text === undefined && cell.formula !== undefined
  const hover = [
    pendingFormula ? PENDING_FORMULA : null,
    state !== null && cell.previous !== undefined ? `Was: ${cell.previous}` : null,
  ].filter(Boolean).join(' · ')
  const entered = cell.text ?? cell.formula ?? ''
  if (state === 'rejected') {
    // The cell keeps what it held; what the change would have entered is struck through after it.
    return { shown: cell.previous ?? '', struck: entered, pendingFormula: false, hover }
  }
  return { shown: entered, struck: null, pendingFormula, hover }
}
