import type { CSSProperties, ReactNode } from 'react'
import { CaretDown, List, Plus, Table } from '@phosphor-icons/react'
import type {
  SpreadsheetArea, SpreadsheetCell, SpreadsheetCellFormat, SpreadsheetDeletedLines, SpreadsheetPreview,
} from '@gadgets/workshop-shared/gatekeeper'
import { changeAttributes, changeIdAt, changeLabel, changeState, isAttributed, isFocused, type ChangeMarks } from './changeMarks'
import { colors, fonts } from './googleTheme'
import { OVERLAY_CLEARANCE, PreviewOverlay } from './PreviewOverlay'
import { safeCssColor } from './safeStyle'
import { cellDisplay, cellReference, changedCells, columnLetter, deletedLines, sheetBlocks, type LocatedCell } from './sheetGrid'
import {
  alignmentOf, areaLayout, BORDER_CSS, CELL_PADDING, DEFAULT_ROW_HEIGHT, drawnFormat, fontFamilyOf, measureText,
  rowText, type AreaLayout, type Axis, type DrawnFormat, type Slot, type TextBox,
} from './sheetLayout'
import { useRovingTabs, useSelectionFollowingFocus } from './useRovingTabs'

// Sheets' row header is 46px wide, and its column header as tall as a default row.
const ROW_HEADER_WIDTH = 46
const COLUMN_HEADER_HEIGHT = DEFAULT_ROW_HEIGHT
const CELL_FONT = `${10}pt`
// The bar Sheets draws after frozen rows and columns.
const FROZEN_BAR = 4
const SCROLL_CLASS = 'sheet-preview-scroll'

const headerStyle = (highlight: string | undefined): CSSProperties => ({
  padding: 0,
  background: highlight ?? colors.headerFill,
  color: colors.headerInk,
  fontFamily: fonts.text,
  fontSize: 11,
  fontWeight: 400,
  textAlign: 'center',
  borderRight: `1px solid ${colors.headerBorder}`,
  borderBottom: `1px solid ${colors.headerBorder}`,
})

/** Cells a change enters in one area, as the rows and columns that bound them. */
type ChangeRange = { changeId: number; top: number; bottom: number; left: number; right: number }

function changeRanges(area: SpreadsheetArea, actions: readonly number[], layout: AreaLayout): ChangeRange[] {
  const ranges = new Map<number, ChangeRange>()
  area.cells.forEach((row, r) => row.forEach((cell, c) => {
    const changeId = changeIdAt(actions, cell?.change)
    if (changeId === undefined) return
    const range = ranges.get(changeId)
    if (!range) ranges.set(changeId, { changeId, top: r, bottom: r, left: c, right: c })
    else {
      range.top = Math.min(range.top, r)
      range.bottom = Math.max(range.bottom, r)
      range.left = Math.min(range.left, c)
      range.right = Math.max(range.right, c)
    }
  }))
  // A range takes in whole any merged cell it reaches, as Sheets' selection does.
  for (const range of ranges.values()) {
    for (let grown = true; grown;) {
      grown = false
      for (const span of layout.spans.values()) {
        const bottom = span.rowEnd - 1
        const right = span.columnEnd - 1
        const meets = span.row <= range.bottom && bottom >= range.top && span.column <= range.right && right >= range.left
        const within = span.row >= range.top && bottom <= range.bottom && span.column >= range.left && right <= range.right
        if (!meets || within) continue
        range.top = Math.min(range.top, span.row)
        range.bottom = Math.max(range.bottom, bottom)
        range.left = Math.min(range.left, span.column)
        range.right = Math.max(range.right, right)
        grown = true
      }
    }
  }
  return [...ranges.values()]
}

const VERTICAL: Record<DrawnFormat['verticalAlignment'], CSSProperties['alignItems']> = {
  top: 'flex-start', middle: 'center', bottom: 'flex-end',
}
const HORIZONTAL: Record<'left' | 'center' | 'right', CSSProperties['justifyContent']> = {
  left: 'flex-start', center: 'center', right: 'flex-end',
}

/** The lines along a cell's edges, each centred on the gridline it covers, as Sheets draws them. */
const CellBorders = ({ borders }: { borders: SpreadsheetCellFormat['borders'] }) => {
  if (!borders) return null
  return (['top', 'right', 'bottom', 'left'] as const).map(side => {
    const border = borders[side]
    const color = safeCssColor(border?.color)
    const css = border && BORDER_CSS[border.style]
    if (!css || !color) return null
    // The gridline is the pixel just outside the cell's top or left edge and just inside its
    // bottom or right one; a wider line spreads either side of it.
    const before = Math.floor((css.width - 1) / 2)
    const after = css.width - 1 - before
    const line = `${css.width}px ${css.style} ${color}`
    const style: CSSProperties = side === 'top' ? { top: -1 - before, left: -1, right: -1, borderTop: line }
      : side === 'bottom' ? { bottom: -1 - after, left: -1, right: -1, borderTop: line }
        : side === 'left' ? { left: -1 - before, top: -1, bottom: -1, borderLeft: line }
          : { right: -1 - after, top: -1, bottom: -1, borderLeft: line }
    return <span key={side} aria-hidden="true" className="pointer-events-none absolute" style={{ zIndex: 1, ...style }} />
  })
}

const SheetCell = ({ cell, format, reference, inserted, height, box, span, gridline, overrun, actions, marks }: {
  cell: SpreadsheetCell | null
  format: DrawnFormat
  reference: string
  inserted: boolean
  /** The cell's height in pixels, gridline included: the rows it spans. */
  height: number
  /** Where its text is drawn, which may run on over blank cells beside it. */
  box: TextBox | undefined
  span: { rows: number; columns: number } | undefined
  gridline: string
  /** Text runs on over the gridline to its right, which Sheets then leaves out. */
  overrun: boolean
  actions: readonly number[]
  marks: ChangeMarks
}) => {
  const base: CSSProperties = {
    position: 'relative',
    padding: 0,
    verticalAlign: 'top',
    borderRight: `1px solid ${overrun ? 'transparent' : gridline}`,
    borderBottom: `1px solid ${gridline}`,
    background: inserted ? colors.insertedTint : safeCssColor(format.backgroundColor) ?? colors.page,
  }
  const spans = span ? { rowSpan: span.rows, colSpan: span.columns } : {}
  const borders = <CellBorders borders={format.borders} />
  if (!cell || !box) return <td style={base} {...spans}>{borders}</td>

  const changeId = changeIdAt(actions, cell.change)
  const state = changeId === undefined ? null : changeState(marks, changeId)
  const display = cellDisplay(cell, state)
  // Filling an empty cell reads as an addition, in Docs' suggestion green; overwriting one stays
  // blue, with Sheets' corner marker, and what it held shows on hover.
  const adds = !cell.previous
  const background = state === 'pending' ? adds ? colors.insertedTint : colors.changedCell : base.background
  const alignment = alignmentOf(cell, format, display.shown)
  const wraps = format.wrapStrategy === 'wrap'
  const decorations = [format.underline && 'underline', format.strikethrough && 'line-through'].filter(Boolean).join(' ')
  const text: CSSProperties = {
    display: 'flex',
    position: 'relative',
    zIndex: 1,
    boxSizing: 'border-box',
    marginLeft: box.left,
    width: display.struck ? '100%' : box.width,
    height: height - 1,
    padding: `${CELL_PADDING.vertical}px ${CELL_PADDING.horizontal}px`,
    overflow: 'hidden',
    alignItems: VERTICAL[format.verticalAlignment],
    justifyContent: wraps ? undefined : HORIZONTAL[alignment],
    textAlign: alignment,
    whiteSpace: wraps ? 'pre-wrap' : 'pre',
    overflowWrap: wraps ? 'anywhere' : undefined,
    lineHeight: 'normal',
    fontFamily: fontFamilyOf(format),
    fontSize: `${format.fontSize}pt`,
    fontWeight: format.bold ? 700 : 400,
    fontStyle: format.italic || display.pendingFormula ? 'italic' : 'normal',
    textDecoration: decorations || undefined,
    color: display.pendingFormula ? colors.formulaPending : safeCssColor(format.textColor) ?? colors.documentInk,
  }
  const content = (
    <>
      {display.shown}
      {display.struck && (
        <span style={{ marginLeft: display.shown ? 4 : 0, textDecoration: 'line-through', color: colors.inkFaint, opacity: 0.7 }}>
          {display.struck}
        </span>
      )}
    </>
  )

  if (changeId === undefined) {
    return <td style={{ ...base, background }} {...spans}><span style={text}>{content}</span>{borders}</td>
  }

  const marker = state === 'pending' && !adds && (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute', top: 0, right: 0, zIndex: 1, width: 0, height: 0,
        borderTop: `6px solid ${colors.cellMarker}`, borderLeft: '6px solid transparent',
      }}
    />
  )
  const label = changeLabel(`${reference} ${display.pendingFormula ? cell.formula : display.shown || display.struck || 'cleared'}`)
  return (
    <td style={{ ...base, background, ...(state === 'rejected' ? { opacity: 0.75 } : {}) }} title={display.hover || undefined} {...spans}>
      {isAttributed(changeId) ? (
        <button
          type="button"
          {...changeAttributes(marks, changeId)}
          aria-label={label}
          style={{ ...text, cursor: 'pointer', background: 'transparent', border: 0, margin: 0, marginLeft: box.left }}
        >
          {content}
        </button>
      ) : (
        <span {...changeAttributes(marks, changeId)} style={text}>{content}</span>
      )}
      {borders}
      {marker}
    </td>
  )
}

/** What a run of deleted lines is called, for its label: "row 39", "rows 39 to 40", "column C". */
const deletedName = (run: SpreadsheetDeletedLines, axis: 'rows' | 'columns') => {
  const name = (i: number) => axis === 'rows' ? String(i + 1) : columnLetter(i)
  const count = Math.max(1, Math.floor(run.count))
  return count === 1 ? `${axis === 'rows' ? 'row' : 'column'} ${name(run.index)}`
    : `${axis} ${name(run.index)} to ${name(run.index + count - 1)}`
}

/**
 * A cell of a line a change deletes: what it holds now, struck through on Sheets' red. Once the
 * deletion is discarded the line is drawn as kept; once applied, faded.
 */
const DeletedCell = ({ text, decided, gridline, span }: {
  text: string | null
  decided: 'pending' | 'approved' | 'rejected'
  gridline: string
  span?: number
}) => (
  <td
    colSpan={span}
    style={{
      padding: `${CELL_PADDING.vertical}px ${CELL_PADDING.horizontal}px`,
      verticalAlign: 'bottom',
      overflow: 'hidden',
      whiteSpace: 'pre',
      textOverflow: 'clip',
      borderRight: `1px solid ${gridline}`,
      borderBottom: `1px solid ${decided === 'rejected' ? gridline : colors.deletedHeader}`,
      background: decided === 'rejected' ? colors.page : colors.deletedTint,
      color: decided === 'rejected' ? colors.documentInk : colors.deletedInk,
      textDecoration: decided === 'rejected' ? undefined : 'line-through',
      opacity: decided === 'approved' ? 0.55 : 1,
      fontFamily: fonts.document,
      fontSize: CELL_FONT,
      lineHeight: 'normal',
    }}
  >
    {text}
  </td>
)

const AreaTable = ({ area, sheet, defaults, withHeader, highlight, actions, marks, label }: {
  area: SpreadsheetArea
  sheet: SpreadsheetPreview['sheets'][number]
  defaults: SpreadsheetCellFormat | undefined
  withHeader: boolean
  /** The cell whose row and column headers are drawn selected, as Sheets does. */
  highlight: LocatedCell | undefined
  actions: readonly number[]
  marks: ChangeMarks
  label: string
}) => {
  const layout = areaLayout(area, defaults)
  const { rows, columns, heights, widths } = layout
  const insertedRows = new Set(area.insertedRows)
  const insertedColumns = new Set(area.insertedColumns)
  const headerTint = (inserted: boolean, selected: boolean) =>
    selected ? colors.changedHeader : inserted ? colors.insertedHeader : undefined
  const focused = changeRanges(area, actions, layout).find(range => isFocused(marks, range.changeId))
  const { rowAxis, columnAxis } = layout
  // The run of deleted lines whose change is focused, on either side, framed as a selection is.
  const focusedRun = (axis: Axis) => axis.runs.findIndex(run => {
    const changeId = changeIdAt(actions, run.change)
    return changeId !== undefined && isFocused(marks, changeId)
  })
  const focusedRows = focusedRun(rowAxis)
  const focusedColumns = focusedRun(columnAxis)
  const decided = (run: SpreadsheetDeletedLines) => {
    const changeId = changeIdAt(actions, run.change)
    return changeId === undefined ? 'pending' as const : changeState(marks, changeId)
  }
  // The header of a deleted line: its number as it is now, struck, and a handle on its change.
  const deletedHeader = (axis: 'rows' | 'columns', run: SpreadsheetDeletedLines, slot: Exclude<Slot, { kind: 'line' }>, key: string) => {
    const state = decided(run)
    const changeId = changeIdAt(actions, run.change)
    const label = slot.kind === 'more' ? `+${slot.count}` : axis === 'rows'
      ? String(run.index + (slot.kind === 'deleted' ? slot.line : 0) + 1)
      : columnLetter(run.index + (slot.kind === 'deleted' ? slot.line : 0))
    const style: CSSProperties = {
      ...headerStyle(state === 'rejected' ? undefined : colors.deletedHeader),
      color: state === 'rejected' ? colors.headerInk : colors.deletedInk,
      textDecoration: state === 'rejected' || slot.kind === 'more' ? undefined : 'line-through',
    }
    const name = `${state === 'rejected' ? 'Kept' : 'Deletes'} ${deletedName(run, axis)}`
    const button = changeId !== undefined && isAttributed(changeId) && (slot.kind === 'more' || slot.line === 0)
    return (
      <th key={key} scope={axis === 'rows' ? 'row' : 'col'} style={style} title={name}>
        {button ? (
          <button
            type="button"
            {...changeAttributes(marks, changeId)}
            aria-label={`Change: ${name.toLowerCase()}`}
            style={{ all: 'inherit', cursor: 'pointer', width: '100%', display: 'block' }}
          >
            {label}
          </button>
        ) : label}
      </th>
    )
  }
  const headerHeight = withHeader ? COLUMN_HEADER_HEIGHT : 0
  const gridWidth = layout.columnLeft(widths.length)
  const gridHeight = layout.rowTop(heights.length)
  const gridline = sheet.hideGridlines ? 'transparent' : colors.gridline
  // The row and column headers Sheets would draw selected: the focused change's, else the cell's.
  const rowSelected = (r: number) => focused ? r >= focused.top && r <= focused.bottom : highlight?.row === area.row + r
  const columnSelected = (c: number) => focused ? c >= focused.left && c <= focused.right : highlight?.column === area.column + c
  // Where the frozen rows and columns end within this area, if they do.
  const frozenEdge = (count: number | undefined, start: number, length: number) =>
    count !== undefined && count > start && count <= start + length ? count - start : undefined
  const frozenRow = frozenEdge(sheet.frozenRows, area.row, heights.length)
  const frozenColumn = frozenEdge(sheet.frozenColumns, area.column, widths.length)

  const shownAt = (r: number) => (c: number) => {
    const cell = area.cells[r][c]
    const changeId = cell ? changeIdAt(actions, cell.change) : undefined
    const display = cell ? cellDisplay(cell, changeId === undefined ? null : changeState(marks, changeId)) : undefined
    const format = drawnFormat(cell, defaults)
    return {
      text: display?.shown ?? '',
      alignment: cell ? alignmentOf(cell, format, display?.shown ?? '') : 'left' as const,
      overflows: format.wrapStrategy === 'overflow' && !display?.struck,
    }
  }

  return (
    <div className="relative" style={{ width: 'max-content', cursor: 'default' }}>
    <table
      aria-label={label}
      style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed', width: ROW_HEADER_WIDTH + gridWidth }}
    >
      <colgroup>
        <col style={{ width: ROW_HEADER_WIDTH }} />
        {columnAxis.slots.map(({ slot, size }, i) => slot.kind === 'line' && !columns.includes(slot.index)
          ? null : <col key={i} style={{ width: size }} />)}
      </colgroup>
      {withHeader && (
        <thead>
          <tr style={{ height: COLUMN_HEADER_HEIGHT }}>
            <td aria-hidden="true" style={headerStyle(undefined)} />
            {columnAxis.slots.map(({ slot }, i) => {
              if (slot.kind !== 'line') return deletedHeader('columns', columnAxis.runs[slot.run], slot, `d${i}`)
              const c = slot.index
              if (!columns.includes(c)) return null
              return (
                <th key={c} scope="col" style={headerStyle(headerTint(insertedColumns.has(c), columnSelected(c)))}>
                  {columnLetter(area.column + c)}
                </th>
              )
            })}
          </tr>
        </thead>
      )}
      <tbody>
        {rowAxis.slots.map(({ slot: rowSlot, size }, slotIndex) => {
          if (rowSlot.kind !== 'line') {
            const run = rowAxis.runs[rowSlot.run]
            const state = decided(run)
            const at = { at: run.before, deleted: true }
            return (
              <tr key={`d${slotIndex}`} style={{ height: size }}>
                {deletedHeader('rows', run, rowSlot, 'h')}
                {rowSlot.kind === 'more' ? (
                  <td
                    colSpan={columnAxis.slots.filter(({ slot }) => slot.kind !== 'line' || columns.includes(slot.index)).length}
                    style={{ ...headerStyle(colors.deletedTint), color: colors.deletedInk, textAlign: 'left', paddingLeft: CELL_PADDING.horizontal + 3 }}
                  >
                    {state === 'rejected' ? `${rowSlot.count} more kept` : `${rowSlot.count} more ${rowSlot.count === 1 ? 'row' : 'rows'} deleted`}
                  </td>
                ) : columnAxis.slots.map(({ slot }, i) => {
                  if (slot.kind === 'line' && !columns.includes(slot.index)) return null
                  const column = slot.kind === 'line'
                    ? { at: slot.index, deleted: false } : { at: columnAxis.runs[slot.run].before, deleted: true }
                  if (layout.mergedOver(at, column)) return null
                  const text = slot.kind === 'line' ? run.cells[rowSlot.line]?.[slot.index] ?? null : null
                  return <DeletedCell key={i} text={text} decided={state} gridline={gridline} />
                })}
              </tr>
            )
          }
          const r = rowSlot.index
          if (!rows.includes(r)) return null
          const row = area.cells[r]
          const { boxes, overrun } = rowText(area, layout, r, defaults, shownAt(r), measureText)
          return (
            <tr key={r} style={{ height: heights[r] }}>
              <th scope="row" style={headerStyle(headerTint(insertedRows.has(r), rowSelected(r)))}>
                {area.row + r + 1}
              </th>
              {columnAxis.slots.map(({ slot }) => slot).map((slot, i) => {
                if (slot.kind !== 'line') {
                  const run = columnAxis.runs[slot.run]
                  if (layout.mergedOver({ at: r, deleted: false }, { at: run.before, deleted: true })) return null
                  const text = slot.kind === 'deleted' ? run.cells[slot.line]?.[r] ?? null : null
                  return <DeletedCell key={`d${i}`} text={text} decided={decided(run)} gridline={gridline} />
                }
                const c = slot.index
                if (!columns.includes(c)) return null
                if (layout.covered.has(`${r}:${c}`)) return null
                const span = layout.spans.get(`${r}:${c}`)
                const cell = row[c] ?? null
                return (
                  <SheetCell
                    key={c}
                    cell={cell}
                    format={drawnFormat(cell, defaults)}
                    reference={cellReference(area.row + r, area.column + c)}
                    inserted={insertedRows.has(r) || insertedColumns.has(c)}
                    height={span?.height ?? heights[r]}
                    box={boxes.get(c)}
                    span={span}
                    gridline={gridline}
                    overrun={overrun.has(c)}
                    actions={actions}
                    marks={marks}
                  />
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
    {frozenRow !== undefined && (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0"
        style={{ zIndex: 2, top: headerHeight + layout.rowTop(frozenRow) - FROZEN_BAR / 2, width: ROW_HEADER_WIDTH + gridWidth, height: FROZEN_BAR, background: colors.frozenDivider }}
      />
    )}
    {frozenColumn !== undefined && (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0"
        style={{ zIndex: 2, left: ROW_HEADER_WIDTH + layout.columnLeft(frozenColumn) - FROZEN_BAR / 2, width: FROZEN_BAR, height: headerHeight + gridHeight, background: colors.frozenDivider }}
      />
    )}
    {/* One frame around everything the focused change enters, as Sheets frames a selected range. */}
    {focused && (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute"
        style={{
          zIndex: 3,
          top: headerHeight + layout.rowTop(focused.top) - 1,
          left: ROW_HEADER_WIDTH + layout.columnLeft(focused.left) - 1,
          width: layout.columnLeft(focused.right + 1) - layout.columnLeft(focused.left) + 1,
          height: layout.rowTop(focused.bottom + 1) - layout.rowTop(focused.top) + 1,
          border: `2px solid ${colors.focus}`,
        }}
      />
    )}
    {[{ run: focusedRows, axis: rowAxis, rows: true }, { run: focusedColumns, axis: columnAxis, rows: false }]
      .filter(({ run }) => run >= 0)
      .map(({ run, axis, rows: across }) => {
        const box = axis.runBox(run)
        const style: CSSProperties = across
          ? { top: headerHeight + box.start - 1, left: ROW_HEADER_WIDTH - 1, width: gridWidth + 1, height: box.size + 1 }
          : { top: headerHeight - 1, left: ROW_HEADER_WIDTH + box.start - 1, width: box.size + 1, height: gridHeight + 1 }
        return (
          <div
            key={across ? 'rows' : 'columns'}
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{ zIndex: 3, ...style, border: `2px solid ${colors.focus}` }}
          />
        )
      })}
    </div>
  )
}

const GapRow = () => (
  <div aria-hidden="true" className="flex" style={{ height: DEFAULT_ROW_HEIGHT, borderBottom: `1px solid ${colors.gridline}` }}>
    <div style={{ ...headerStyle(undefined), width: ROW_HEADER_WIDTH, lineHeight: `${DEFAULT_ROW_HEIGHT}px` }}>⋯</div>
    <div className="flex-1" style={{ background: colors.headerFill, opacity: 0.6 }} />
  </div>
)

// Sheets' scrollbars: a pale track with a rounded thumb. Scrollbars can only be styled from a
// stylesheet, so this one is scoped to the grid's scroll area.
const scrollbarCss = `
.${SCROLL_CLASS}::-webkit-scrollbar { width: 12px; height: 12px; background: ${colors.scrollbarTrack}; }
.${SCROLL_CLASS}::-webkit-scrollbar-thumb { background: ${colors.scrollbarThumb}; border-radius: 8px; border: 3px solid ${colors.scrollbarTrack}; }
.${SCROLL_CLASS}::-webkit-scrollbar-corner { background: ${colors.scrollbarTrack}; }
@supports not selector(::-webkit-scrollbar) {
  .${SCROLL_CLASS} { scrollbar-color: ${colors.scrollbarThumb} ${colors.scrollbarTrack}; }
}`

const ToolbarIcon = ({ children }: { children: ReactNode }) => (
  <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center" style={{ color: colors.inkMuted }}>{children}</span>
)

/** A Google Sheet as it will be: the chosen sheet's changed areas on Sheets' grid, sheets as tabs. */
export const SpreadsheetPreviewView = ({ content, actions, marks, overlay }: {
  /** Floated over the bottom of the main area: the file's review controls. */
  overlay?: ReactNode
  content: SpreadsheetPreview
  actions: readonly number[]
  marks: ChangeMarks
}) => {
  const changed = changedCells(content.areas)
  const deleted = deletedLines(content.areas)
  const touches = (id: number) => changed.some(c => c.sheetId === id) || deleted.some(d => d.sheetId === id)
  const firstChangedSheet = content.sheets.find(sheet => touches(sheet.id))?.id
  const [sheetId, setSheetId] = useSelectionFollowingFocus(
    firstChangedSheet ?? content.sheets[0]?.id ?? 0,
    marks.focusedChangeId,
    changeId => changed.find(c => changeIdAt(actions, c.cell.change) === changeId)?.sheetId ??
      deleted.find(d => changeIdAt(actions, d.change) === changeId)?.sheetId,
  )
  const selectedIndex = Math.max(0, content.sheets.findIndex(sheet => sheet.id === sheetId))
  const tabProps = useRovingTabs({
    count: content.sheets.length,
    selected: selectedIndex,
    onSelect: index => setSheetId(content.sheets[index].id),
  })
  const sheet = content.sheets[selectedIndex]
  const blocks = sheet ? sheetBlocks(content.areas, sheet.id) : []
  const onSheet = changed.filter(c => c.sheetId === sheet?.id)
  const focusedCell = onSheet.find(c => {
    const id = changeIdAt(actions, c.cell.change)
    return id !== undefined && isFocused(marks, id)
  })
  const barCell = focusedCell ?? onSheet[0]
  const barText = barCell ? barCell.cell.formula ?? barCell.cell.text ?? '' : ''

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: colors.canvas }}>
      <style>{scrollbarCss}</style>
      <div
        className="flex shrink-0 items-stretch"
        style={{ height: 30, background: colors.page, borderBottom: `1px solid ${colors.chromeDivider}`, fontFamily: fonts.document, fontSize: CELL_FONT }}
      >
        <div
          aria-label="Cell"
          className="flex items-center"
          style={{ width: 92, padding: '0 8px', borderRight: `1px solid ${colors.chromeDivider}`, color: colors.ink }}
        >
          {barCell ? cellReference(barCell.row, barCell.column) : ''}
        </div>
        <div aria-hidden="true" className="flex items-center px-3 italic" style={{ color: colors.inkFaint, fontFamily: 'Georgia, serif' }}>fx</div>
        <output aria-label="Cell contents" className="flex min-w-0 flex-1 items-center truncate pr-3" style={{ color: colors.ink }}>
          {barText}
        </output>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-preview-scroll
        role={content.sheets.length > 0 ? 'tabpanel' : undefined}
        className={`${SCROLL_CLASS} min-h-0 flex-1 overflow-scroll`}
        style={{ background: colors.page, paddingBottom: overlay ? OVERLAY_CLEARANCE : undefined }}
      >
        {sheet?.status === 'removed' && (
          <p className="m-3 rounded-md border border-kumo-line bg-kumo-tint px-3 py-2 text-xs text-kumo-subtle">
            This sheet will be deleted.
          </p>
        )}
        {blocks.length === 0 && sheet?.status !== 'removed' && (
          <p className="m-3 text-xs text-kumo-subtle">Nothing on this sheet changes.</p>
        )}
        {blocks.map(({ area, gapBefore, continued }, i) => (
          <div key={i}>
            {gapBefore && <GapRow />}
            <AreaTable
              area={area}
              sheet={sheet}
              defaults={content.defaultFormat}
              withHeader={!continued}
              highlight={barCell}
              actions={actions}
              marks={marks}
              label={`${sheet.title} ${cellReference(area.row, area.column)}:${cellReference(area.row + area.cells.length - 1, area.column + Math.max(0, ...area.cells.map(r => r.length)) - 1)}`}
            />
          </div>
        ))}
      </div>
      {overlay && <PreviewOverlay>{overlay}</PreviewOverlay>}
      </div>

      <div
        className="flex shrink-0 items-start gap-1 overflow-x-auto px-2"
        style={{ height: 40, background: colors.canvas, fontFamily: fonts.ui }}
      >
        <div className="flex h-10 shrink-0 items-center gap-1">
          <ToolbarIcon><Plus size={18} /></ToolbarIcon>
          <ToolbarIcon><Table size={18} /></ToolbarIcon>
          <ToolbarIcon><List size={18} /></ToolbarIcon>
        </div>
        <div role="tablist" aria-label="Sheets" className="ml-1 flex items-start gap-0.5">
          {content.sheets.map((s, index) => {
            const selected = index === selectedIndex
            const hasChanges = touches(s.id)
            return (
              <button
                key={s.id}
                type="button"
                {...tabProps(index)}
                aria-label={[s.title || 'Sheet', s.status === 'added' ? 'new' : s.status === 'removed' ? 'deleted' : null, hasChanges ? 'changed' : null].filter(Boolean).join(', ')}
                className="flex h-8 min-w-12 shrink-0 items-center gap-1.5 px-3 text-[14px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                style={{
                  // The selected tab hangs from the top of the bar: square above, rounded below.
                  borderRadius: '0 0 8px 8px',
                  background: selected ? colors.sheetTab : 'transparent',
                  color: s.status === 'removed' ? colors.inkFaint : selected ? colors.sheetTabInk : colors.inkMuted,
                  textDecoration: s.status === 'removed' ? 'line-through' : undefined,
                  outlineColor: colors.focus,
                }}
              >
                {s.title}
                {s.status === 'added' && (
                  <span className="rounded px-1 text-[10px] leading-4 font-medium" style={{ background: colors.badge, color: colors.badgeInk }}>New</span>
                )}
                {hasChanges && s.status !== 'added' && (
                  <span aria-hidden="true" className="inline-block size-1.5 rounded-full" style={{ background: colors.cellMarker }} />
                )}
                {selected && s.title && <CaretDown aria-hidden="true" size={12} weight="fill" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
