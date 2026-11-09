// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResourcePreview, SpreadsheetArea } from '@gadgets/workshop-shared/gatekeeper'
import { spreadsheetFixture } from './fixtures'
import { loadingPreview } from './loadingPreview'
import { changeElements, previewTestRoot, renderPreview } from './previewTestRoot'
import { cellDisplay, columnLetter, sheetBlocks } from './sheetGrid'

const testRoot = previewTestRoot()
afterEach(() => testRoot.cleanup())

describe('columnLetter', () => {
  it('names columns as Sheets does', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnLetter))
      .toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD'])
  })
})

describe('sheetBlocks', () => {
  const area = (row: number, rows: number, column = 0, columns = 2, sheetId = 1): SpreadsheetArea => ({
    sheetId, row, column, cells: Array.from({ length: rows }, () => Array.from({ length: columns }, () => null)),
  })

  it('orders a sheet’s areas and marks a gap only between rows that are not adjacent', () => {
    const blocks = sheetBlocks([area(10, 2), area(0, 3), area(3, 2), area(0, 1, 0, 2, 2)], 1)
    expect(blocks.map(b => [b.area.row, b.gapBefore, b.continued])).toEqual([
      [0, false, false],
      [3, false, true],
      [10, true, false],
    ])
  })

  it('gives an adjacent area with other columns its own header', () => {
    const blocks = sheetBlocks([area(0, 2, 0, 2), area(2, 2, 3, 2)], 1)
    expect(blocks[1]).toMatchObject({ gapBefore: false, continued: false })
  })
})

describe('cellDisplay', () => {
  it('shows a queued formula, marked as not yet calculated', () => {
    expect(cellDisplay({ formula: '=SUM(A1:A3)', change: 0 }, 'pending'))
      .toMatchObject({ shown: '=SUM(A1:A3)', pendingFormula: true, hover: 'Calculates when approved' })
  })

  it('keeps the previous value when the change is rejected, striking the new one', () => {
    expect(cellDisplay({ text: '$9', previous: '$7', change: 0 }, 'rejected'))
      .toMatchObject({ shown: '$7', struck: '$9', hover: 'Was: $7' })
  })
})

const sheet = (areas: SpreadsheetArea[], actions = [41, 42]): ResourcePreview => ({
  title: 'Budget',
  actions,
  content: { type: 'spreadsheet', sheets: [{ id: 1, title: 'Main' }, { id: 2, title: 'New', status: 'added' }], areas },
})

describe('SpreadsheetPreviewView', () => {
  it('draws an area at its real offset in the sheet', async () => {
    const page = await testRoot.render(renderPreview(sheet([{
      sheetId: 1, row: 6, column: 27, cells: [[{ text: 'a' }, { text: 'b', change: 0 }], [null, null]],
    }])))
    expect([...page.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['AB', 'AC'])
    expect([...page.querySelectorAll('tbody th')].map(th => th.textContent)).toEqual(['7', '8'])
    expect(page.querySelector('[aria-label="Cell"]')?.textContent).toBe('AC7')
  })

  it('shows a formula-only cell in the formula bar and marks it as calculated later', async () => {
    const page = await testRoot.render(renderPreview(sheet([{
      sheetId: 1, row: 0, column: 0, cells: [[{ formula: '=A2*2', change: 0 }]],
    }])))
    const [cell] = changeElements(page, 41)
    expect(cell.textContent).toBe('=A2*2')
    expect(cell.closest('td')?.getAttribute('title')).toBe('Calculates when approved')
    expect(page.querySelector('[aria-label="Cell contents"]')?.textContent).toBe('=A2*2')
  })

  it('shows a rejected cell’s previous value with the new one struck', async () => {
    const page = await testRoot.render(renderPreview(sheet([{
      sheetId: 1, row: 0, column: 0, cells: [[{ text: '$9', previous: '$7', change: 0 }]],
    }]), { decided: [[41, 'rejected']] }))
    const [cell] = changeElements(page, 41)
    expect(cell.getAttribute('data-change-state')).toBe('rejected')
    expect(cell.firstChild?.textContent).toBe('$7')
    expect(cell.querySelector('span')?.style.textDecoration).toBe('line-through')
    expect(cell.querySelector('span')?.textContent).toBe('$9')
  })

  it('lists sheets as tabs, badging added ones and switching with the arrow keys', async () => {
    const page = await testRoot.render(renderPreview(spreadsheetFixture))
    const tabs = [...page.querySelectorAll('[role="tablist"][aria-label="Sheets"] [role="tab"]')] as HTMLElement[]
    expect(tabs.map(t => t.getAttribute('aria-label'))).toEqual(['Budget, changed', 'Headcount', 'Q3 Forecast, new, changed', 'Old drafts, deleted'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    await act(async () => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])
    expect(page.querySelector('tbody th')?.textContent).toBe('3')
  })

  it('tints inserted rows', async () => {
    const page = await testRoot.render(renderPreview(sheet([{
      sheetId: 1, row: 0, column: 0, cells: [[{ text: 'a' }], [{ text: 'b' }]], insertedRows: [1],
    }])))
    const rows = page.querySelectorAll('tbody tr')
    expect((rows[0].querySelector('td') as HTMLElement).style.background).not.toBe((rows[1].querySelector('td') as HTMLElement).style.background)
  })
})

describe('lines a change deletes', () => {
  const deleting = sheet([{
    sheetId: 1, row: 36, column: 0, columnWidths: [100, 100],
    cells: [[{ text: 'kept' }, null], [{ text: 'after' }, null]],
    deletedRows: [{ before: 1, index: 37, count: 2, change: 0, cells: [['Gone', '$4'], [null, null]] }],
  }])

  it('draws deleted rows where they stood, numbered as now and struck, with what they hold', async () => {
    const page = await testRoot.render(renderPreview(deleting))
    expect([...page.querySelectorAll('tbody th')].map(th => th.textContent)).toEqual(['37', '38', '39', '38'])
    const rows = [...page.querySelectorAll('tbody tr')]
    expect([...rows[1].querySelectorAll('td')].map(td => td.textContent)).toEqual(['Gone', '$4'])
    expect((rows[1].querySelector('td') as HTMLElement).style.textDecoration).toBe('line-through')
    expect(rows[3].querySelector('td')?.textContent).toBe('after')
    const [handle] = changeElements(page, 41)
    expect(handle.getAttribute('aria-label')).toBe('Change: deletes rows 38 to 39')
  })

  it('frames the deleted rows when their change is focused, and draws them kept once discarded', async () => {
    const focused = await testRoot.render(renderPreview(deleting, { focusedChangeId: 41 }))
    const frames = [...focused.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(e => e.style.border.includes('2px solid'))
    expect(frames).toHaveLength(1)
    expect(frames[0].style.height).toBe(`${2 * 21 + 1}px`)
    expect(frames[0].style.top).toBe(`${21 + 21 - 1}px`)

    const kept = await testRoot.render(renderPreview(deleting, { decided: [[41, 'rejected']] }))
    expect((kept.querySelectorAll('tbody tr')[1].querySelector('td') as HTMLElement).style.textDecoration).toBe('')
  })

  it('counts deleted rows beyond those drawn', async () => {
    const page = await testRoot.render(renderPreview(sheet([{
      sheetId: 1, row: 0, column: 0, cells: [[{ text: 'a' }]],
      deletedRows: [{ before: 1, index: 1, count: 40, change: 0, cells: [['x'], ['y']] }],
    }])))
    expect(page.querySelector('tbody tr:last-child')?.textContent).toContain('38 more rows deleted')
  })

  it('draws a deleted column with its letter struck, stopping text running on across it', async () => {
    const page = await testRoot.render(renderPreview(sheet([{
      sheetId: 1, row: 0, column: 0, columnWidths: [100, 100],
      cells: [[{ text: 'A note long enough to run on over its neighbours' }, null]],
      deletedColumns: [{ before: 1, index: 1, count: 1, change: 0, cells: [['Old']] }],
    }])))
    expect([...page.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['A', 'B', 'B'])
    const cells = [...page.querySelectorAll('tbody td')]
    expect(cells.map(td => td.textContent)).toEqual(['A note long enough to run on over its neighbours', 'Old', ''])
  })
})

describe('a change across several cells', () => {
  const block: ResourcePreview = {
    title: 'Stats', actions: [7, 8],
    content: { type: 'spreadsheet', sheets: [{ id: 0, title: 'Sheet1' }], areas: [{
      sheetId: 0, row: 0, column: 0, columnWidths: [100, 100, 100],
      cells: [
        [{ text: 'Header', change: 0 }, { change: 0 }, null],
        [{ text: 'A long note that runs on', change: 0 }, { text: '1', change: 0 }, { text: 'Was here', change: 1, previous: 'Old' }],
      ],
    }] },
  }

  it('is framed once, as Sheets frames a range, with its rows and columns selected', async () => {
    const page = await testRoot.render(renderPreview(block, { focusedChangeId: 7 }))
    const frames = [...page.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(e => e.style.border.includes('2px solid'))
    expect(frames).toHaveLength(1)
    expect(frames[0].style.width).toBe('201px')
    expect(frames[0].style.height).toBe(`${2 * 21 + 1}px`)
    for (const cell of changeElements(page, 7)) expect((cell as HTMLElement).style.outline).toBe('')
  })

  it('lets text run on over a blank cell to its right, and no further', async () => {
    const page = await testRoot.render(renderPreview(block))
    const header = changeElements(page, 7).find(e => e.textContent === 'Header') as HTMLElement
    // B1 is part of the change but blank; C1 is empty: both take the overflow.
    expect(header.style.width).toBe('299px')
    const note = changeElements(page, 7).find(e => e.textContent === 'A long note that runs on') as HTMLElement
    expect(note.style.width).toBe('99px')
  })
})

describe('drawing cells as Sheets draws them', () => {
  const preview = (area: Partial<SpreadsheetArea>, sheetFields: object = {}, more: object = {}): ResourcePreview => ({
    title: 'Plan', actions: [5],
    content: {
      type: 'spreadsheet', sheets: [{ id: 0, title: 'Sheet1', ...sheetFields }], ...more,
      areas: [{ sheetId: 0, row: 0, column: 0, cells: [], ...area }],
    },
  })
  const cellText = (page: Element, text: string) =>
    [...page.querySelectorAll<HTMLElement>('td > span, td > button')].find(e => e.textContent === text)!

  it('draws merged cells as one, and frames a change in one whole, below rows of the sheet’s heights', async () => {
    const page = await testRoot.render(renderPreview(preview({
      rowHeights: [30, 21, 21],
      merges: [{ row: 1, column: 0, rows: 2, columns: 2 }],
      cells: [[{ text: 'Head' }, null], [{ text: 'Merged', change: 0 }, null], [null, null]],
    }), { focusedChangeId: 5 }))
    const merged = cellText(page, 'Merged').closest('td')!
    expect([merged.rowSpan, merged.colSpan]).toEqual([2, 2])
    expect(page.querySelectorAll('tbody td')).toHaveLength(3)
    expect([...page.querySelectorAll<HTMLElement>('tbody tr')].map(tr => tr.style.height)).toEqual(['30px', '21px', '21px'])
    const frame = [...page.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(e => e.style.border.includes('2px solid'))!
    expect([frame.style.top, frame.style.height, frame.style.width]).toEqual([`${21 + 30 - 1}px`, `${42 + 1}px`, '201px'])
  })

  it('draws a bar after the frozen rows and columns', async () => {
    const page = await testRoot.render(renderPreview(preview(
      { cells: [[{ text: 'a' }, null], [null, null]], rowHeights: [25, 21] },
      { frozenRows: 1, frozenColumns: 1 },
    )))
    const bars = [...page.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(e => e.style.height === '4px' || e.style.width === '4px')
    expect(bars.map(bar => bar.style.top || bar.style.left)).toEqual([`${21 + 25 - 2}px`, `${46 + 100 - 2}px`])
  })

  it('leaves out hidden rows and gridlines, and draws borders over them', async () => {
    const page = await testRoot.render(renderPreview(preview(
      {
        hiddenRows: [1],
        cells: [[{ text: 'Total', format: { borders: { bottom: { style: 'double', color: '#ff0000' }, top: { style: 'medium', color: 'url(x)' } } } }], [{ text: 'secret' }], [null]],
      },
      { hideGridlines: true },
    )))
    expect([...page.querySelectorAll('tbody th')].map(th => th.textContent)).toEqual(['1', '3'])
    const total = cellText(page, 'Total').closest('td')!
    expect(total.style.borderBottom).toContain('transparent')
    const lines = [...total.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')]
    // A colour that is not plainly a colour is not drawn.
    expect(lines.map(line => line.style.borderTop)).toEqual(['3px double rgb(255, 0, 0)'])
  })

  it('draws the cell’s font, decorations, alignment and wrapping, and the spreadsheet’s default font', async () => {
    const page = await testRoot.render(renderPreview(preview({
      cells: [[
        { text: 'Note', format: { underline: true, strikethrough: true, verticalAlignment: 'top', wrapStrategy: 'wrap', fontSize: 14 } },
        { text: '12', format: { horizontalAlignment: 'right', fontFamily: 'bad"font' } },
      ]],
    }, {}, { defaultFormat: { fontFamily: 'Roboto' } })))
    const note = cellText(page, 'Note')
    expect(note.style.textDecoration).toBe('underline line-through')
    expect(note.style.alignItems).toBe('flex-start')
    expect(note.style.whiteSpace).toBe('pre-wrap')
    expect(note.style.fontSize).toBe('14pt')
    expect(note.style.fontFamily).toContain('Roboto')
    const number = cellText(page, '12')
    expect(number.style.justifyContent).toBe('flex-end')
    expect(number.style.fontFamily).not.toContain('bad')
  })

  it('reads as read-only: no text cursor over the grid', async () => {
    const page = await testRoot.render(renderPreview(preview({ cells: [[{ text: 'a' }]] })))
    expect((page.querySelector('table')!.parentElement as HTMLElement).style.cursor).toBe('default')
  })

  it('draws a sheet with no title, as while loading, as a blank tab', async () => {
    const page = await testRoot.render(renderPreview(loadingPreview('spreadsheet')))
    const [tab] = [...page.querySelectorAll('[role="tab"]')]
    expect(tab.textContent).toBe('')
    expect(tab.querySelector('svg')).toBeNull()
    expect(page.querySelectorAll('tbody tr')).toHaveLength(60)
  })
})
