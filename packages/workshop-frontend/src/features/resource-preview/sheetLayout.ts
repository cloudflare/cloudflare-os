import type {
  SpreadsheetArea, SpreadsheetBorder, SpreadsheetCell, SpreadsheetCellFormat, SpreadsheetDeletedLines,
} from '@gadgets/workshop-shared/gatekeeper'
import { fonts } from './googleTheme'
import { fontStack } from './safeStyle'
import { columnWidths, defaultAlignment, DEFAULT_COLUMN_WIDTH } from './sheetGrid'

// How Sheets lays out and draws cells, worked out from the preview alone so it can be tested
// without a browser: row heights, hidden lines, merges, and how far text runs on.

/** Sheets' default row height in pixels, which fits Arial 10pt with 2px padding above and below. */
export const DEFAULT_ROW_HEIGHT = 21
/** Sheets' cell padding: 2px above and below the text, 3px either side. */
export const CELL_PADDING = { vertical: 2, horizontal: 3 }

/** How Sheets draws a cell whose spreadsheet sets no default format of its own. */
export const STANDARD_FORMAT = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  fontFamily: 'Arial',
  fontSize: 10,
  textColor: '#000000',
  backgroundColor: '#ffffff',
  verticalAlignment: 'bottom',
  wrapStrategy: 'overflow',
} as const satisfies SpreadsheetCellFormat

/** A cell's format as drawn: its own over the spreadsheet's default over Sheets' standard. */
export type DrawnFormat = Omit<SpreadsheetCellFormat, keyof typeof STANDARD_FORMAT> & {
  -readonly [Field in keyof typeof STANDARD_FORMAT]-?: NonNullable<SpreadsheetCellFormat[Field]>
}

/** How `cell` is drawn; a font size Sheets could not have set falls back to its standard 10pt. */
export const drawnFormat = (cell: SpreadsheetCell | null | undefined, defaults: SpreadsheetCellFormat | undefined): DrawnFormat => {
  const format: DrawnFormat = { ...STANDARD_FORMAT, ...defaults, ...cell?.format }
  // A size from the file is used only when Sheets could have set it.
  const size = format.fontSize
  if (!Number.isFinite(size) || size < 1 || size > 400) format.fontSize = STANDARD_FORMAT.fontSize
  return format
}

/** The CSS font stack for a drawn format: the file's font when its name is plain, else Arial. */
export const fontFamilyOf = (format: DrawnFormat) => fontStack(format.fontFamily, fonts.document)

/** A CSS `font` shorthand for measuring text in `format`. */
export const cssFont = (format: DrawnFormat) =>
  `${format.italic ? 'italic ' : ''}${format.bold ? 'bold ' : ''}${format.fontSize}pt ${fontFamilyOf(format)}`

/**
 * The height Sheets grows a row to for one line of `points`-sized text: its default for 10pt or
 * 11pt, then about 1.15 times the text's pixel size plus padding (14pt 24px, 18pt 30px, 24pt 39px).
 */
export const lineFitHeight = (points: number) => Math.max(DEFAULT_ROW_HEIGHT, Math.ceil(points * 4 / 3 * 1.15 + 2))

/** How a border style is drawn in CSS, with Sheets' widths. */
export const BORDER_CSS: Record<SpreadsheetBorder['style'], { width: number; style: string }> = {
  solid: { width: 1, style: 'solid' },
  medium: { width: 2, style: 'solid' },
  thick: { width: 3, style: 'solid' },
  dashed: { width: 1, style: 'dashed' },
  dotted: { width: 1, style: 'dotted' },
  double: { width: 3, style: 'double' },
}

/** Holds nothing to show, so text from a neighbour can run on into it, as in Sheets. */
export const isBlank = (cell: SpreadsheetCell | null | undefined) =>
  !cell || (cell.text === undefined && cell.formula === undefined && !cell.previous)

/**
 * A merged cell: the area's rows and columns it covers, from its top left `row` and `column` to
 * just before `rowEnd` and `columnEnd`; how many of them are drawn; and its size in pixels.
 */
export type Span = {
  row: number
  column: number
  rowEnd: number
  columnEnd: number
  rows: number
  columns: number
  width: number
  height: number
}

/**
 * One line drawn along a side of an area, in order: one of the area's own, by its area-relative
 * index; a line a change deletes, by its run in `deletedRows` or `deletedColumns` and its place in
 * the run's `cells`; or a stand-in for the lines of a run that `cells` leaves out.
 */
export type Slot =
  | { kind: 'line'; index: number }
  | { kind: 'deleted'; run: number; line: number }
  | { kind: 'more'; run: number; count: number }

/** The lines drawn along one side of an area, with where each starts and how big it is. */
export type Axis = {
  /** Every line drawn, in order, with its offset in pixels and its size (0 for one not drawn). */
  slots: { slot: Slot; start: number; size: number }[]
  /** The runs of deleted lines, sanitized: each stands before a valid index, in order. */
  runs: SpreadsheetDeletedLines[]
  /** Each run's extent in pixels. */
  runBox: (run: number) => { start: number; size: number }
  /** Area-relative indices of lines with a run of deleted lines just before them. */
  deletedBefore: Set<number>
}

// The lines drawn along one side of an area of `count` lines sized `sizes`, with `deleted` among
// them, each deleted line `fallback` pixels unless the sheet sizes it.
function axisOf(count: number, sizes: number[], deleted: readonly SpreadsheetDeletedLines[] | undefined, fallback: number): Axis {
  const runs = (deleted ?? [])
    .filter(run => index(run.before, count + 1) !== undefined && Array.isArray(run.cells))
    .toSorted((a, b) => a.before - b.before)
  const slots: Axis['slots'] = []
  const boxes: { start: number; size: number }[] = []
  let at = 0
  const push = (slot: Slot, size: number) => {
    slots.push({ slot, start: at, size })
    at += size
  }
  const sizeOf = (given: number | undefined) => given && Number.isFinite(given) && given > 0 ? Math.min(given, 2000) : fallback
  let next = 0
  for (let position = 0; position <= count; position++) {
    for (; next < runs.length && runs[next].before === position; next++) {
      const run = runs[next]
      const start = at
      run.cells.forEach((_, line) => push({ kind: 'deleted', run: next, line }, sizeOf(run.sizes?.[line])))
      const more = Math.max(0, Math.floor(run.count) - run.cells.length)
      if (more > 0) push({ kind: 'more', run: next, count: more }, fallback)
      boxes[next] = { start, size: at - start }
    }
    if (position < count) push({ kind: 'line', index: position }, sizes[position])
  }
  return {
    slots,
    runs,
    runBox: run => boxes[run] ?? { start: 0, size: 0 },
    deletedBefore: new Set(runs.map(run => run.before)),
  }
}

/** Where an area's rows and columns are drawn. Indices are area-relative. */
export type AreaLayout = {
  /** Rows drawn, in order: all but those the sheet hides, unless a change is in one. */
  rows: number[]
  columns: number[]
  /** Each row's height and each column's width in pixels; 0 for a line not drawn. */
  heights: number[]
  widths: number[]
  /** The y of row `r`'s top edge, below the column headers; for `r` past the last, the bottom. */
  rowTop: (r: number) => number
  /** The x of column `c`'s left edge, right of the row headers; for `c` past the last, the right. */
  columnLeft: (c: number) => number
  /** Merged cells drawn, by `r:c` of their top left cell. */
  spans: Map<string, Span>
  /** Cells a merged cell covers, by `r:c`, which are not drawn. */
  covered: Set<string>
  /** The rows drawn, the area's own and those changes delete, in order. */
  rowAxis: Axis
  /** The columns drawn, the area's own and those changes delete, in order. */
  columnAxis: Axis
  /**
   * Whether a merged cell covers where a deleted line crosses the given row and column, each an
   * area-relative index or, for a deleted line, the index it stands before.
   */
  mergedOver: (row: { at: number; deleted: boolean }, column: { at: number; deleted: boolean }) => boolean
}

const index = (value: unknown, below: number) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < below ? value as number : undefined

export function areaLayout(area: SpreadsheetArea, defaults?: SpreadsheetCellFormat): AreaLayout {
  const columnCount = Math.max(0, ...area.cells.map(row => row.length))
  const rowCount = area.cells.length
  const changed = (cells: (SpreadsheetCell | null | undefined)[]) => cells.some(cell => cell?.change !== undefined)
  const hiddenRows = new Set((area.hiddenRows ?? []).filter(r => index(r, rowCount) !== undefined && !changed(area.cells[r])))
  const hiddenColumns = new Set((area.hiddenColumns ?? [])
    .filter(c => index(c, columnCount) !== undefined && !changed(area.cells.map(row => row[c]))))

  const widths = columnWidths(area).map((width, c) => hiddenColumns.has(c) ? 0 : width)
  const heights = area.cells.map((row, r) => {
    if (hiddenRows.has(r)) return 0
    const given = area.rowHeights?.[r]
    const height = given && Number.isFinite(given) && given > 0 ? Math.min(given, 2000) : DEFAULT_ROW_HEIGHT
    // Sheets grows a row for larger text once the change that enlarges it applies.
    const largest = Math.max(0, ...row.map(cell => isBlank(cell) ? 0 : drawnFormat(cell, defaults).fontSize))
    return Math.max(height, largest > 0 ? lineFitHeight(largest) : 0)
  })
  const rowAxis = axisOf(rowCount, heights, area.deletedRows, DEFAULT_ROW_HEIGHT)
  const columnAxis = axisOf(columnCount, widths, area.deletedColumns, DEFAULT_COLUMN_WIDTH)
  // Where each of the area's own lines starts, past the deleted lines before it; then the end.
  const offsets = (axis: Axis, count: number) => {
    const starts: number[] = []
    for (const { slot, start } of axis.slots) if (slot.kind === 'line') starts[slot.index] = start
    const last = axis.slots.at(-1)
    starts[count] = last ? last.start + last.size : 0
    return starts
  }
  const tops = offsets(rowAxis, rowCount)
  const lefts = offsets(columnAxis, columnCount)
  // How many deleted lines `axis` draws strictly between lines `from` and `to - 1`.
  const deletedWithin = (axis: Axis, from: number, to: number) =>
    axis.slots.filter(({ slot }) => slot.kind !== 'line' && axis.runs[slot.run].before > from && axis.runs[slot.run].before < to).length

  const spans = new Map<string, Span>()
  const covered = new Set<string>()
  for (const merge of area.merges ?? []) {
    const row = index(merge.row, rowCount)
    const column = index(merge.column, columnCount)
    if (row === undefined || column === undefined || hiddenRows.has(row) || hiddenColumns.has(column)) continue
    const bottom = Math.min(rowCount, row + Math.max(1, Math.floor(merge.rows)))
    const right = Math.min(columnCount, column + Math.max(1, Math.floor(merge.columns)))
    const key = `${row}:${column}`
    if (covered.has(key) || spans.has(key)) continue
    let overlaps = false
    for (let r: number = row; r < bottom && !overlaps; r++) {
      for (let c: number = column; c < right && !overlaps; c++) overlaps = covered.has(`${r}:${c}`) || spans.has(`${r}:${c}`)
    }
    if (overlaps) continue
    for (let r: number = row; r < bottom; r++) for (let c: number = column; c < right; c++) if (r !== row || c !== column) covered.add(`${r}:${c}`)
    const visible = (from: number, to: number, hidden: Set<number>) =>
      Array.from({ length: to - from }, (_, i) => from + i).filter(i => !hidden.has(i)).length
    spans.set(key, {
      row, column, rowEnd: bottom, columnEnd: right,
      rows: visible(row, bottom, hiddenRows) + deletedWithin(rowAxis, row, bottom),
      columns: visible(column, right, hiddenColumns) + deletedWithin(columnAxis, column, right),
      width: lefts[right] - lefts[column],
      height: tops[bottom] - tops[row],
    })
  }

  const all = (count: number, hidden: Set<number>) => Array.from({ length: count }, (_, i) => i).filter(i => !hidden.has(i))
  return {
    rows: all(rowCount, hiddenRows),
    columns: all(columnCount, hiddenColumns),
    heights,
    widths,
    rowTop: r => tops[Math.min(Math.max(r, 0), rowCount)],
    columnLeft: c => lefts[Math.min(Math.max(c, 0), columnCount)],
    spans,
    covered,
    rowAxis,
    columnAxis,
    mergedOver: (r, c) => [...spans.values()].some(span =>
      (r.deleted ? span.row < r.at && r.at < span.rowEnd : span.row <= r.at && r.at < span.rowEnd) &&
      (c.deleted ? span.column < c.at && c.at < span.columnEnd : span.column <= c.at && c.at < span.columnEnd)),
  }
}

/**
 * Where a cell's text box lies, relative to the cell: `left` px from its left edge (negative when
 * it runs on to the left) and `width` px wide, gridline excluded.
 */
export type TextBox = { left: number; width: number }

/** How each cell of a row lays out its text, and which right-hand gridlines the text runs over. */
export type RowText = { boxes: Map<number, TextBox>; overrun: Set<number> }

/** The width in pixels `text` takes in `format`, if it can be measured here. */
export type MeasureText = (text: string, format: DrawnFormat) => number | undefined

/**
 * How the text of row `r` lays out: text Sheets overflows runs on over blank neighbours, left-aligned
 * text to the right, right-aligned to the left and centred both ways evenly, as far as it needs
 * when `measure` can say, else as far as it may; wrapped, clipped and merged cells keep to
 * themselves. `shown` is what each cell shows, and `alignment` how it aligns it.
 */
export function rowText(
  area: SpreadsheetArea, layout: AreaLayout, r: number, defaults: SpreadsheetCellFormat | undefined,
  shown: (c: number) => { text: string; alignment: 'left' | 'center' | 'right'; overflows: boolean },
  measure: MeasureText,
): RowText {
  const row = area.cells[r] ?? []
  const boxes = new Map<number, TextBox>()
  const overrun = new Set<number>()
  const { columns, widths } = layout
  const free = (c: number) => isBlank(row[c]) && !layout.covered.has(`${r}:${c}`) && !layout.spans.has(`${r}:${c}`)
  columns.forEach((c, at) => {
    const width = widths[c]
    if (layout.covered.has(`${r}:${c}`)) return
    const span = layout.spans.get(`${r}:${c}`)
    const { text, alignment, overflows } = isBlank(row[c]) ? { text: '', alignment: 'left' as const, overflows: false } : shown(c)
    if (span || !overflows || !text) {
      boxes.set(c, { left: 0, width: (span?.width ?? width) - 1 })
      return
    }
    const measured = measure(text, drawnFormat(row[c], defaults))
    const needed = measured === undefined ? Infinity : measured + 2 * CELL_PADDING.horizontal
    // The blank columns either side the text may run over, nearest first, stopping at a deleted
    // column drawn between.
    const run = (step: 1 | -1) => {
      const reach: number[] = []
      for (let i = at + step; i >= 0 && i < columns.length && free(columns[i]); i += step) {
        if (layout.columnAxis.deletedBefore.has(step === 1 ? columns[i] : columns[i + 1])) break
        reach.push(columns[i])
      }
      return reach
    }
    // The px the text gains running on over as many of `reach` as it takes to gain `extra`.
    const take = (reach: number[], extra: number) => {
      let gained = 0
      for (let i = 0; i < reach.length && gained < extra; i++) gained += widths[reach[i]]
      return { gained }
    }
    let gained = { left: 0, right: 0 }
    if (needed > width) {
      if (alignment === 'left') gained.right = take(run(1), needed - width).gained
      else if (alignment === 'right') gained.left = take(run(-1), needed - width).gained
      else {
        // The text stays centred on its cell, so it runs on only as far as the nearer side allows.
        const extra = (needed - width) / 2
        const even = Math.min(take(run(-1), extra).gained, take(run(1), extra).gained, extra)
        gained = { left: even, right: even }
      }
    }
    boxes.set(c, { left: gained.left > 0 ? -gained.left : 0, width: width + gained.left + gained.right - 1 })
    // The gridlines the text crosses are not drawn, as in Sheets; without measuring, the text may
    // stop short of them, so they are kept.
    if (measured === undefined) return
    const start = layout.columnLeft(c) - gained.left
    const end = layout.columnLeft(c) + width + gained.right
    for (const column of columns) {
      const edge = layout.columnLeft(column) + widths[column]
      if (edge > start && edge < end) overrun.add(column)
    }
  })
  return { boxes, overrun }
}

/** How a cell's value aligns when its format does not say: as Sheets aligns a formula's result. */
export const alignmentOf = (cell: SpreadsheetCell, format: DrawnFormat, shown: string) =>
  format.horizontalAlignment ?? (cell.formula !== undefined ? defaultAlignment(shown) : 'left')

let context: OffscreenCanvasRenderingContext2D | null | undefined

/** Measures text with the browser's own fonts, as Sheets draws it; undefined where it can't. */
export const measureText: MeasureText = (text, format) => {
  if (context === undefined) {
    context = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
  }
  if (!context) return undefined
  context.font = cssFont(format)
  return context.measureText(text).width
}
