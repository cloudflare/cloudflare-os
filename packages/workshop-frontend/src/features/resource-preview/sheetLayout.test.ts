import { describe, expect, it } from 'vitest'
import type { SpreadsheetArea } from '@gadgets/workshop-shared/gatekeeper'
import { areaLayout, drawnFormat, lineFitHeight, rowText, type MeasureText } from './sheetLayout'

const area = (cells: SpreadsheetArea['cells'], more: Partial<SpreadsheetArea> = {}): SpreadsheetArea =>
  ({ sheetId: 0, row: 0, column: 0, cells, ...more })

// Every character 10px wide, so text needs 10px a character plus 6px of padding.
const measure: MeasureText = text => text.length * 10
const shown = (a: SpreadsheetArea, r: number, alignment: 'left' | 'center' | 'right' = 'left') => (c: number) =>
  ({ text: a.cells[r][c]?.text ?? '', alignment, overflows: true })

describe('drawnFormat', () => {
  it('takes the cell’s own format over the spreadsheet’s default over Sheets’ standard', () => {
    expect(drawnFormat({ text: 'a', format: { bold: true } }, { fontFamily: 'Roboto', bold: false }))
      .toMatchObject({ bold: true, fontFamily: 'Roboto', fontSize: 10, verticalAlignment: 'bottom', wrapStrategy: 'overflow' })
  })

  it('ignores a font size Sheets could not have set', () => {
    expect(drawnFormat({ format: { fontSize: 4000 } }, undefined).fontSize).toBe(10)
  })
})

describe('areaLayout', () => {
  it('sizes rows as the sheet does, growing one for larger text as Sheets will', () => {
    const layout = areaLayout(area(
      [[{ text: 'a' }], [{ text: 'big', format: { fontSize: 24 } }], [null]],
      { rowHeights: [40, 21, 21] },
    ))
    expect(layout.heights).toEqual([40, lineFitHeight(24), 21])
    expect(lineFitHeight(10)).toBe(21)
    expect(lineFitHeight(18)).toBe(30)
    expect([layout.rowTop(0), layout.rowTop(1), layout.rowTop(3)]).toEqual([0, 40, 40 + lineFitHeight(24) + 21])
  })

  it('leaves out hidden lines, but not one holding a change', () => {
    const layout = areaLayout(area(
      [[{ text: 'a' }, null, null], [null, { text: 'b', change: 0 }, null]],
      { hiddenRows: [0, 1], hiddenColumns: [0, 2], columnWidths: [50, 60, 70] },
    ))
    expect(layout.rows).toEqual([1])
    expect(layout.columns).toEqual([1])
    expect(layout.widths).toEqual([0, 60, 0])
    expect(layout.columnLeft(2)).toBe(60)
  })

  it('spans merged cells over the lines they cover, ignoring ones that overlap or fall outside', () => {
    const layout = areaLayout(area(
      [[{ text: 'Q1' }, null, null], [null, null, null]],
      { merges: [{ row: 0, column: 0, rows: 2, columns: 2 }, { row: 1, column: 1, rows: 1, columns: 2 }, { row: 5, column: 0, rows: 1, columns: 1 }] },
    ))
    expect([...layout.spans.values()]).toEqual([
      { row: 0, column: 0, rowEnd: 2, columnEnd: 2, rows: 2, columns: 2, width: 200, height: 42 },
    ])
    expect([...layout.covered]).toEqual(['0:1', '1:0', '1:1'])
  })
})

describe('rowText', () => {
  it('runs left-aligned text on over as many blank cells as it needs, leaving out the gridlines it crosses', () => {
    const a = area([[{ text: 'x'.repeat(15) }, null, null, null]])
    const { boxes, overrun } = rowText(a, areaLayout(a), 0, undefined, shown(a, 0), measure)
    expect(boxes.get(0)).toEqual({ left: 0, width: 199 })
    expect([...overrun]).toEqual([0])
  })

  it('runs right-aligned text on to the left, and stops at a cell that shows something', () => {
    const a = area([[{ text: 'kept' }, null, null, { text: 'x'.repeat(30) }]])
    const { boxes, overrun } = rowText(a, areaLayout(a), 0, undefined, shown(a, 0, 'right'), measure)
    expect(boxes.get(3)).toEqual({ left: -200, width: 299 })
    expect([...overrun].toSorted()).toEqual([1, 2])
  })

  it('runs centred text on evenly, only as far as the nearer side allows', () => {
    const a = area([[null, { text: 'x'.repeat(25) }, null, null]])
    const { boxes, overrun } = rowText(a, areaLayout(a), 0, undefined, shown(a, 0, 'center'), measure)
    // 256px needed: 78px either side, and the left has 100px to give.
    expect(boxes.get(1)).toEqual({ left: -78, width: 255 })
    expect([...overrun].toSorted()).toEqual([0, 1])
  })

  it('keeps wrapped, clipped and merged text within its cell', () => {
    const a = area([[{ text: 'x'.repeat(30) }, null, null]], { merges: [{ row: 0, column: 1, rows: 1, columns: 2 }] })
    const { boxes, overrun } = rowText(a, areaLayout(a), 0, undefined, c => ({ ...shown(a, 0)(c), overflows: false }), measure)
    expect(boxes.get(0)).toEqual({ left: 0, width: 99 })
    expect(boxes.get(1)).toEqual({ left: 0, width: 199 })
    expect(overrun.size).toBe(0)
  })

  it('without measuring, lets text run as far as it may and keeps the gridlines', () => {
    const a = area([[{ text: 'short' }, null, { text: 'next' }]])
    const { boxes, overrun } = rowText(a, areaLayout(a), 0, undefined, shown(a, 0), () => undefined)
    expect(boxes.get(0)).toEqual({ left: 0, width: 199 })
    expect(overrun.size).toBe(0)
  })
})
