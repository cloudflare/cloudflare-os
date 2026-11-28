// The Google Sheets preview client, run in a same-origin frame with a scripted session so its
// drawing can be read. ConnectionPreviewPane's test runs a preview in the real sandbox, where it
// cannot.

import { afterEach, expect, it } from 'vitest'
import FONT_URL from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'
import { prepareUiPage } from '@gadgets/workshop-shared/ui-page'
import { previewHost } from './previewBundle'
import { SHEETS_PREVIEW_BUNDLE } from './sheetsPreviewBundle'

type Cell = Record<string, unknown>
type Line = { size?: number, hidden?: true, inserted?: true }
type Info = {
  id: number, title: string, index: number, rowCount: number, columnCount: number, hidden?: true
  frozenRowCount?: number, frozenColumnCount?: number
}
type Sheet = Info & {
  /** Set on a sheet a pending change touches, which getPendingChanges() says of it after the changes. */
  touched?: true
  gridlinesHidden?: true
  /** Cells by name, such as `B2`, and what rows and columns have that is not the usual. */
  cells?: Record<string, Cell>
  rows?: Record<number, Line>
  columns?: Record<number, Line>
  formats?: object[]
  merges?: string[]
  filter?: string
  charts?: object[]
}
type Book = {
  sheets: Sheet[]
  /** The sheets as saved, when the pending changes leave others. */
  saved?: Info[]
  /** What getPendingChanges() says of each sheet, by title. */
  pending?: Record<string, { changes?: object[], areas?: object[] }>
  fail?: string
  /** Why a read of `title`'s pending changes fails, or of the drawing of `range`, when it does. */
  failChanges?: (title: string) => string | undefined
  failDrawing?: (range: string) => string | undefined
  /** What a read of the pending changes waits for before it answers. */
  wait?: Promise<void>
  /** The bytes of any font asked for, when one is served. */
  font?: Promise<ArrayBuffer>
  /** The stream of any font asked for, in place of `font`'s bytes. */
  fontStream?: () => ReadableStream<Uint8Array>
  /** Called with the frame's window as the client starts, before it has read anything. */
  started?: (frame: Window) => void
}

const letters = (column: number): string =>
  column <= 26 ? String.fromCharCode(64 + column) : letters(Math.floor((column - 1) / 26)) + letters((column - 1) % 26 + 1)
const columnOf = (name: string) => [...name].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
/** The first and last row and column, from 1, of a range as the client asks for it, such as `'Sales'!A1:F12`. */
function boundsOf(range: string) {
  const [, c0, r0, c1, r1] = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)!
  return { r0: Number(r0), r1: Number(r1), c0: columnOf(c0), c1: columnOf(c1) }
}
/** A sheet as the session lists it, in getSpreadsheet() and as saved: with the lines it keeps in view. */
const info = ({ id, title, index, rowCount, columnCount, hidden, frozenRowCount, frozenColumnCount }: Sheet): Info => ({
  id, title, index, rowCount, columnCount, ...(hidden ? { hidden } : {}),
  ...(frozenRowCount ? { frozenRowCount } : {}), ...(frozenColumnCount ? { frozenColumnCount } : {}),
})
/** A sheet as getPendingChanges() lists it after the changes: marked where one of them touches it. */
const pendingInfo = (sheet: Sheet) => ({ ...info(sheet), ...(sheet.touched ? { touched: true as const } : {}) })

/** Lines `from` to `to` with the frozen ones before them, each `size` unless `held` says otherwise. */
const lines = (from: number, to: number, frozen: number, held: Record<number, Line> = {}, size: number) => [
  ...Array.from({ length: Math.min(frozen, from - 1) }, (_line, n) => n + 1),
  ...Array.from({ length: to - from + 1 }, (_line, n) => from + n),
].map(number => ({ number, size, ...held[number] }))

/**
 * A window of `sheet` as readDrawing() returns it: its frozen lines but those of an axis
 * `unfrozen` names, then the range's own, with the merges that reach into them. Throws as the
 * session does for more cells than it draws.
 */
function drawingOf(sheet: Sheet, range: string, unfrozen: string[] = []) {
  const { r0, r1, c0, c1 } = boundsOf(range)
  const frozen = (axis: string, count = 0) => unfrozen.includes(axis) ? 0 : count
  const columns = lines(c0, c1, frozen('columns', sheet.frozenColumnCount), sheet.columns, 100)
  const cellAt = (row: number, column: number) => sheet.cells?.[`${letters(column)}${row}`]
  // A row nobody has sized is as tall as its tallest text, as the session works it out.
  const tall = (row: number) => Math.max(21, ...columns.map(({ number }) => {
    const { text, format } = (cellAt(row, number) ?? {}) as { text?: string, format?: number }
    const { fontSize = 10 } = (sheet.formats?.[format ?? -1] ?? {}) as { fontSize?: number }
    return text ? Math.round(text.split('\n').length * fontSize * 1.6) + 5 : 0
  }))
  const rows = lines(r0, r1, frozen('rows', sheet.frozenRowCount), sheet.rows, 21)
    .map(row => sheet.rows?.[row.number]?.size ? row : { ...row, size: tall(row.number) })
  if (rows.length * columns.length > 10_000) {
    throw new Error("readDrawing may draw at most 10,000 cells, those of the sheet's frozen rows and columns included.")
  }
  const { gridlinesHidden, filter, charts } = sheet
  const merges = (sheet.merges ?? []).filter(merge => {
    const at = boundsOf(`!${merge}`)
    return rows.some(({ number }) => number >= at.r0 && number <= at.r1) && columns.some(({ number }) => number >= at.c0 && number <= at.c1)
  })
  // The first cell of a merge comes apart when the window leaves it out.
  const drawn = new Set(rows.flatMap(row => columns.map(column => `${letters(column.number)}${row.number}`)))
  const anchors = Object.fromEntries(merges.map(merge => merge.split(':')[0])
    .filter(name => !drawn.has(name) && sheet.cells?.[name]).map(name => [name, sheet.cells![name]]))
  return {
    // Named as the session names it, which quotes a title only where it must.
    range: range.replace(/^'(\w+)'!/, '$1!'),
    sheet: { ...info(sheet), ...(gridlinesHidden ? { gridlinesHidden } : {}) },
    rows,
    columns,
    cells: rows.map(row => columns.map(column => cellAt(row.number, column.number) ?? null)),
    formats: sheet.formats ?? [],
    merges,
    ...(Object.keys(anchors).length > 0 ? { anchors } : {}),
    ...(filter ? { filter } : {}),
    ...(charts ? { charts } : {}),
  }
}

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

/** Holds the frame's waits of `time`, each to be ended by running what `held` gathers of it. */
const holding = (time: number, held: (() => void)[]) => (window: Window) => {
  const { setTimeout: wait } = window
  window.setTimeout = ((run: () => void, ms?: number) => ms === time ? held.push(run) : wait(run, ms)) as typeof setTimeout
}

/**
 * Draws `book` in a frame `width` wide and `height` tall, and resolves once its first sheet is
 * drawn. `at` is the spot its host sends it to.
 */
async function draw(book: Book, width = 900, height = 600, at?: string) {
  const { host, said, go } = previewHost(at)
  const reads: string[] = []
  const without: string[][] = []
  const asked: string[] = []
  const fonts: [string, number, boolean][] = []
  const gadget = {
    // No font is served unless the book has one: the cells are drawn in what the browser has.
    readFont: async (...font: [string, number, boolean]) => {
      fonts.push(font)
      if (book.fontStream) return book.fontStream()
      if (!book.font) throw new Error('readFont: Google Fonts does not serve this font.')
      return new Blob([await book.font]).stream()
    },
    getSpreadsheet: async () => ({ id: 'book', title: 'Book', sheets: book.sheets.map(info) }),
    getPendingChanges: async (title: string) => {
      if (asked.length === 0) book.started?.(frame!.contentWindow!)
      asked.push(title)
      await book.wait
      const failure = book.fail ?? book.failChanges?.(title)
      if (failure) throw new Error(failure)
      // A title is one a sheet has with the changes made, or failing that as saved.
      if (![...book.sheets, ...book.saved ?? []].some(sheet => sheet.title === title)) throw new Error(`no sheet named "${title}"`)
      return {
        changes: [], areas: [], ...book.pending?.[title],
        sheets: { saved: book.saved ?? book.sheets.map(info), pending: book.sheets.map(pendingInfo) },
      }
    },
    readDrawing: async (range: string, unfrozen?: string[]) => {
      reads.push(range)
      without.push(unfrozen ?? [])
      const failure = book.failDrawing?.(range)
      if (failure) throw new Error(failure)
      return drawingOf(book.sheets.find(sheet => range.startsWith(`'${sheet.title}'!`))!, range, unfrozen)
    },
  }
  Object.assign(window, { sheetsPreviewGadget: gadget, sheetsPreviewHost: host })
  frame = document.body.appendChild(document.createElement('iframe'))
  Object.assign(frame.style, { width: `${width}px`, height: `${height}px` })
  // Started as the gadget UI frame starts it: main(gadget, host) on the module's default export.
  const { entryUrl, importMap } = prepareUiPage(SHEETS_PREVIEW_BUNDLE, '')
  frame.srcdoc = `<body><script type="importmap">${importMap}</script><script type="module">
    import client from ${JSON.stringify(entryUrl)}
    client.main(parent.sheetsPreviewGadget, parent.sheetsPreviewHost)
  </script>`
  const doc = () => frame!.contentDocument!
  await expect.poll(() => doc()?.querySelector('#error, #grid .h') !== null, { timeout: 10_000 }).toBe(true)
  const cells = () => [...doc().querySelectorAll<HTMLElement & { at: { row: number, column: number } }>('#grid .c')]
  return {
    doc: doc(),
    reads,
    /** The axes each of `reads` asked for without their frozen lines. */
    without,
    /** The sheets whose pending changes were asked for, in order. */
    asked,
    /** Each focus the host was told, and what sends the preview to a spot as its host does. */
    said,
    go,
    /** The fonts asked for, in order: family, weight and whether italic. */
    fonts,
    cells,
    /** The element drawn for the cell named, such as `B2`. */
    cell: (name: string) => cells().find(({ at }) => `${letters(at.column + 1)}${at.row + 1}` === name)!,
    heads: (kind: 'col' | 'row') => [...doc().querySelectorAll<HTMLElement>(`#grid .h.${kind}`)],
    look: (element: Element) => frame!.contentWindow!.getComputedStyle(element),
    tabs: () => [...doc().querySelectorAll<HTMLElement>('#outline .tab .name')],
    refresh: () => frame!.contentWindow!.postMessage({ type: 'refresh' }, '*'),
  }
}

const SALES: Sheet = {
  id: 1, title: 'Sales', index: 0, rowCount: 12, columnCount: 6, frozenRowCount: 1,
  rows: { 1: { size: 30 }, 6: { hidden: true } },
  columns: { 2: { size: 64 }, 5: { hidden: true } },
  formats: [
    { bold: true, fillColor: '#d9ead3', fontFamily: 'Georgia', fontSize: 12, horizontalAlignment: 'CENTER' },
    { textColor: '#cc0000', italic: true, borders: { bottom: { style: 'SOLID_MEDIUM', color: '#0000ff' } } },
    { wrap: 'WRAP', verticalAlignment: 'TOP' },
    { bold: true, textColor: '#ff0000' },
  ],
  merges: ['C3:D4'],
  filter: 'A1:C9',
  charts: [{ title: 'Sales by region', anchor: 'D7', offsetX: 4, offsetY: 2, width: 180, height: 90 }],
  cells: {
    A1: { text: 'Region', format: 0 }, B1: { text: 'Total', format: 0 },
    A2: { text: 'EMEA', format: 1 }, B2: { text: '1,200', kind: 'number' },
    A3: { text: 'A long label that runs on over the empty cell beside it' },
    C3: { text: 'Merged', format: 2 },
    A5: { text: '<img src=x onerror="parent.hacked = true">' },
    B5: { text: 'Docs', link: 'https://example.com/docs' }, C5: { text: 'Script', link: 'javascript:parent.hacked = true' },
    C1: { text: 'Net of tax', format: 0, runs: [{ start: 4, format: 3 }, { start: 6 }] },
    A7: { text: 'TRUE', kind: 'boolean', holds: ['checkbox'] }, B7: { text: 'Open', holds: ['dropdown', 'note'] },
  },
}

it('draws a sheet as the session gives it: looks, sizes, merges, frozen and hidden lines', async () => {
  const { doc, reads, cell, heads, look } = await draw({ sheets: [SALES] })

  // A small sheet is read whole, from A1.
  expect(reads).toEqual(["'Sales'!A1:F12"])
  expect(heads('col').map(head => head.textContent)).toEqual(['A', 'B', 'C', 'D', 'F'])
  expect(heads('row').map(head => head.textContent)).toEqual(['1', '2', '3', '4', '5', '7', '8', '9', '10', '11', '12'])
  // A header says rows or columns before it are hidden.
  expect(heads('col')[4].title).toBe('Columns before this one are hidden')
  expect(heads('row')[5].classList.contains('jump')).toBe(true)

  const head = cell('A1')
  expect(look(head).backgroundColor).toBe('rgb(217, 234, 211)')
  expect(look(head).fontWeight).toBe('700')
  expect(look(head).fontFamily).toContain('Georgia')
  expect(look(head).fontSize).toBe('16px')
  expect(look(head).justifyContent).toBe('center')
  expect(Math.round(head.getBoundingClientRect().height)).toBe(30)
  expect(Math.round(cell('B2').getBoundingClientRect().width)).toBe(64)
  // The frozen row stays under the headers as the rest scrolls.
  expect(look(head).position).toBe('sticky')
  expect(head.classList.contains('fr-edge')).toBe(true)

  expect(look(cell('A2')).color).toBe('rgb(204, 0, 0)')
  expect(look(cell('A2')).borderBottom).toBe('2px solid rgb(0, 0, 255)')
  // A number stands at the right, as Google Sheets stands it.
  expect(look(cell('B2')).textAlign).toBe('right')

  // A merge is one cell over its rows and columns, and the cells it covers are not drawn.
  const merged = cell('C3')
  expect(Math.round(merged.getBoundingClientRect().width)).toBe(200)
  expect(Math.round(merged.getBoundingClientRect().height)).toBe(42)
  expect(cell('D4')).toBeUndefined()
  expect(look(merged).whiteSpace).toBe('pre-wrap')

  // Long text runs on over the empty cell beside it.
  expect(cell('A3').classList.contains('over')).toBe(true)
  expect(cell('A3').querySelector('span')!.getBoundingClientRect().width).toBeGreaterThan(150)

  // Text formatted in parts reads as one, each part looking as the cell does but where it says
  // otherwise: on a fill its color is kept as the spreadsheet has it.
  expect(cell('C1').textContent).toBe('Net of tax')
  const parts = [...cell('C1').querySelectorAll<HTMLElement>('.rich > span')]
  expect(parts.map(part => [part.textContent, getComputedStyle(part).fontWeight, getComputedStyle(part).color]))
    .toEqual([['of', '700', 'rgb(255, 0, 0)'], [' tax', '700', getComputedStyle(cell('C1')).color]])

  // What a cell holds is text, whatever it says.
  expect(cell('A5').textContent).toBe('<img src=x onerror="parent.hacked = true">')
  expect(doc.querySelector('#grid img')).toBeNull()
  // Only a web address is a link, opened in a new browser tab.
  const links = [...doc.querySelectorAll<HTMLAnchorElement>('#grid a')]
  expect(links.map(link => ['href', 'target', 'rel'].map(name => link.getAttribute(name))))
    .toEqual([['https://example.com/docs', '_blank', 'noopener noreferrer']])
  expect(cell('C5').textContent).toBe('Script')
  expect((window as { hacked?: boolean }).hacked).toBeUndefined()

  // What is not drawn yet has its place.
  expect(cell('A7').querySelector('.box.ticked')).not.toBeNull()
  expect([cell('A7').querySelector('.box')!.role, cell('A7').querySelector('.box')!.ariaLabel]).toEqual(['img', 'Checked'])
  expect(cell('B7').classList.contains('drop')).toBe(true)
  expect(cell('B7').classList.contains('note')).toBe(true)
  expect(cell('B1').classList.contains('sift')).toBe(true)
  const chart = doc.querySelector<HTMLElement>('.chart')!
  expect(chart.textContent).toBe('Chart: Sales by regionNot drawn in this preview')
  expect(Math.round(chart.getBoundingClientRect().width)).toBe(180)
  // The cells under it are still pointed at, as one with a change to show must be.
  const { left, top } = chart.getBoundingClientRect()
  expect(doc.elementFromPoint(left + 90, top + 45)!.matches('#grid .c')).toBe(true)
})

it('asks for the fonts its cells are set in, and draws without one it cannot have', async () => {
  const { fonts, cell, look } = await draw({ sheets: [{
    id: 1, title: 'Fonts', index: 0, rowCount: 3, columnCount: 2,
    formats: [{ bold: true, fontFamily: 'Poppins' }, { fontFamily: 'arial,sans,sans-serif' }, { fontFamily: 'Poppins', bold: true, fontSize: 14 }],
    cells: { A1: { text: 'Title', format: 0 }, A2: { text: 'Plain', format: 1 }, A3: { text: 'Large', format: 2 } },
  }] })

  // Arial is the browser's own, and a font is asked for once however many formats name it. A
  // weight that is not served falls back to the family's regular.
  await expect.poll(() => fonts).toEqual([['Poppins', 700, false], ['Poppins', 400, false]])
  expect(look(cell('A1')).fontFamily).toContain('Poppins')
})

const POPPINS: Sheet = {
  id: 1, title: 'Fonts', index: 0, rowCount: 1, columnCount: 1,
  formats: [{ fontFamily: 'Poppins' }], cells: { A1: { text: 'Title', format: 0 } },
}

it('leaves a font it could not have alone for a while, however often the sheet is read afresh', async () => {
  const later: (() => void)[] = []
  const { fonts, asked, refresh } = await draw({ sheets: [POPPINS], started: holding(60_000, later) })
  await expect.poll(() => fonts).toEqual([['Poppins', 400, false]])

  // No pending change sets a font, so a refresh has none the session would newly read.
  refresh()
  await expect.poll(() => asked).toHaveLength(2)
  await pause(200)
  expect(fonts).toHaveLength(1)

  for (const run of later.splice(0)) run()
  refresh()
  await expect.poll(() => fonts).toEqual([['Poppins', 400, false], ['Poppins', 400, false]])
})

it('gives up on a font whose read does not settle, as on one that could not be read', async () => {
  const late: (() => void)[] = []
  const { fonts } = await draw({
    sheets: [{ ...POPPINS, formats: [{ fontFamily: 'Poppins', bold: true }] }],
    font: new Promise(() => {}), started: holding(30_000, late),
  })
  await expect.poll(() => fonts).toEqual([['Poppins', 700, false]])

  // Its place among the fonts read is free again: the family's regular is asked for in its stead.
  for (const run of late.splice(0)) run()
  await expect.poll(() => fonts).toEqual([['Poppins', 700, false], ['Poppins', 400, false]])
})

it('ends the read of a font whose bytes stop coming, so that no more of it arrives', async () => {
  const late: (() => void)[] = []
  const ended: unknown[] = []
  // The first bytes come, and no more.
  const stalled = () => new ReadableStream<Uint8Array>({
    start: controller => controller.enqueue(new Uint8Array(8)), cancel: reason => void ended.push(reason),
  })
  const { fonts } = await draw({ sheets: [POPPINS], fontStream: stalled, started: holding(30_000, late) })
  await expect.poll(() => fonts).toEqual([['Poppins', 400, false]])
  await pause(100)
  expect(ended).toEqual([])

  for (const run of late.splice(0)) run()
  await expect.poll(() => ended).toHaveLength(1)
})

it('stops text that runs on at a cell that holds something and shows nothing, as a formula can', async () => {
  const label = 'A long label that runs on over the empty cell beside it'
  const { cell } = await draw({ sheets: [{
    id: 1, title: 'Notes', index: 0, rowCount: 2, columnCount: 2,
    cells: { A1: { text: label }, A2: { text: label }, B2: { text: '' } },
  }] })

  expect(['A1', 'A2'].map(name => cell(name).classList.contains('over'))).toEqual([true, false])
})

it('stops text that runs on where the frozen columns end, so what scrolls is not passed under it', async () => {
  const label = 'A long label that runs on over the empty cell beside it'
  const book: Book = {
    sheets: [{
      id: 1, title: 'Notes', index: 0, rowCount: 3, columnCount: 6, frozenColumnCount: 1, touched: true,
      cells: { A1: { text: label }, C1: { text: 'new', change: 2, entered: 'new' }, B2: { text: label } },
    }],
    pending: { Notes: {
      changes: [{ id: 2, type: 'updateSpreadsheet', changes: [{ op: 'writeCells', range: 'Notes!C1', values: [['new']] }] }],
      areas: [{ change: 2, op: 'writeCells', range: 'C1' }],
    } },
  }
  const { doc, cell } = await draw(book, 400)

  // Among the columns that scroll it runs on as ever.
  expect(['A1', 'B2'].map(name => cell(name).classList.contains('over'))).toEqual([false, true])
  // Scrolled a column on, the value a change enters lies where the empty cell did, with nothing over it.
  doc.getElementById('scroll')!.scrollTo(100, 0)
  const { left, right, top, bottom } = cell('C1').getBoundingClientRect()
  const there = doc.elementsFromPoint((left + right) / 2, (top + bottom) / 2)
  expect([there.includes(cell('C1')), there.some(found => cell('A1').contains(found))]).toEqual([true, false])
})

it('takes text of several lines to be as wide as its widest line', async () => {
  const { cell } = await draw({ sheets: [{
    id: 1, title: 'Notes', index: 0, rowCount: 2, columnCount: 2,
    cells: { A1: { text: 'January\nFebruary\nMarch' }, A2: { text: 'January, February and March' } },
  }] })

  // Each line fits its cell, so the gridline beside it stays.
  expect(['A1', 'A2'].map(name => cell(name).classList.contains('over'))).toEqual([false, true])
})

it('draws text turned on its side up its cell, with its alignments turned too', async () => {
  const { cell, look } = await draw({ sheets: [{
    id: 1, title: 'Months', index: 0, rowCount: 2, columnCount: 2,
    rows: { 1: { size: 60 } },
    formats: [{ rotation: 90 }, { rotation: -90, verticalAlignment: 'TOP' }],
    cells: { A1: { text: 'Jan', format: 0 }, B1: { text: 'Feb', format: 1 } },
  }] })

  const drawn = (name: string) => {
    const text = document.createRange()
    text.selectNodeContents(cell(name)!)
    return [text.getBoundingClientRect(), cell(name)!.getBoundingClientRect()]
  }
  // Read from the bottom up, it starts at the foot of its cell, where level text would sit.
  const [up, first] = drawn('A1')
  expect(look(cell('A1')).writingMode).toBe('sideways-lr')
  expect(up.height).toBeGreaterThan(up.width)
  expect(first.bottom - up.bottom).toBeLessThan(6)
  // Read from the top down, text set at the top of its cell starts there.
  const [down, second] = drawn('B1')
  expect(look(cell('B1')).writingMode).toBe('vertical-rl')
  expect(down.top - second.top).toBeLessThan(6)
})

it('leaves out the gridlines of a sheet that hides them', async () => {
  const { cell, look } = await draw({ sheets: [{ ...SALES, gridlinesHidden: true }] })

  expect(look(cell('B8')).borderRightWidth).toBe('0px')
  // A border the spreadsheet sets is still drawn.
  expect(look(cell('A2')).borderBottomWidth).toBe('2px')
})

it('opens on a sheet that was there before one a pending change adds, which is empty', async () => {
  const { doc } = await draw({
    saved: [small(1, 'Sales', 0)].map(info),
    sheets: [small(9, 'Plan', 0, { touched: true }), small(1, 'Sales', 1, { touched: true })],
  })

  expect(doc.querySelector('#strip b')!.textContent).toBe('Sales')
})

const CHANGED: Book = {
  sheets: [{
    id: 1, title: 'Sales', index: 0, rowCount: 12, columnCount: 6, touched: true,
    rows: { 4: { inserted: true } },
    formats: [{ fillColor: '#fff2cc', bold: true }],
    cells: {
      A1: { text: 'Region' },
      A2: { text: 'West', change: 4, entered: 'West', saved: 'EMEA' },
      B2: { pending: true, kind: 'number', change: 4, entered: 7, saved: '4' },
      C2: { pending: true, change: 4, entered: '=B2*2', saved: '8' },
      A3: { change: 4, entered: null, saved: 'APAC' },
      B3: { text: '5', kind: 'number', format: 0, formatted: true, holds: ['note'] },
      C3: { pending: true, kind: 'number', saved: '10', holds: ['note'] },
    },
  }],
  pending: { Sales: {
    changes: [
      { id: 4, type: 'updateSpreadsheet', changes: [
        { op: 'writeCells', range: 'Sales!A2:C2', values: [['West', 7, '=B2*2']] },
        { op: 'clearRange', range: 'Sales!A3' },
      ] },
      { id: 6, type: 'updateSpreadsheet', changes: [
        { op: 'formatCells', range: 'Sales!B3', format: { bold: true, fillColor: '#fff2cc' } },
        { op: 'insertRows', sheet: 'Sales', at: 4 },
        { op: 'deleteRows', sheet: 'Sales', at: 8, count: 2 },
      ] },
    ],
    areas: [
      { change: 4, op: 'writeCells', range: 'A2:C2' }, { change: 4, op: 'clearRange', range: 'A3' },
      { change: 6, op: 'formatCells', range: 'B3' }, { change: 6, op: 'insertRows', range: 'A4:F4' },
      { change: 6, op: 'deleteRows', range: 'A8:F8', count: 2 },
    ],
  } },
}

it('marks what the pending changes do: cells written, cleared and formatted, rows inserted and deleted', async () => {
  const { doc, cell, heads, look } = await draw(CHANGED)

  // What is entered shows as it will be, and a formula as its text until Google works it out.
  expect(['A2', 'B2', 'C2', 'A3'].map(name => [cell(name).textContent, cell(name).className.replace(/^c ?/, '')])).toEqual([
    ['West', 'new'], ['7', 'new num'], ['=B2*2', 'new formula'], ['APAC', 'cut'],
  ])
  expect(look(cell('A3')).textDecorationLine).toBe('line-through')
  // A cell the changes may alter, but do not write, shows what is saved.
  expect(cell('C3').textContent).toBe('10')
  expect(cell('C3').className).toBe('c num note may')
  // Formatting set by a change is drawn, and its cell marked.
  expect(look(cell('B3')).backgroundColor).toBe('rgb(255, 242, 204)')
  expect(cell('B3').classList.contains('styled')).toBe(true)
  // Each mark is in its corner, over the mark of the note the cell holds in the other.
  for (const name of ['C3', 'B3']) expect(look(cell(name)).backgroundImage.match(/linear-gradient\((135|225)deg/g)).toHaveLength(2)

  // An inserted row is a band across the sheet, and its header says so.
  expect(cell('C4').classList.contains('band')).toBe(true)
  expect(heads('row')[3].title).toBe('Inserted by a pending change')
  // The headers of the rows and columns the changes touch are lit.
  expect(heads('row').filter(head => head.classList.contains('hit')).map(head => head.textContent)).toEqual(['2', '3', '4'])
  expect(heads('col').filter(head => head.classList.contains('hit')).map(head => head.textContent)).toEqual(['A', 'B', 'C'])

  // Each area is ringed where it shows, and deleted rows are a line where they stood.
  const rings = [...doc.querySelectorAll<HTMLElement>('.ring')]
  expect(rings.map(ring => ring.className)).toEqual(['ring', 'ring cleared', 'ring', 'ring', 'ring gone'])
  const written = rings[0].getBoundingClientRect()
  expect(Math.round(written.left - cell('A2').getBoundingClientRect().left)).toBe(-1)
  expect(Math.round(written.width)).toBe(301)
  // Once the grid has settled from arriving.
  await expect.poll(() => Math.round(rings[4].getBoundingClientRect().top - cell('A8').getBoundingClientRect().top)).toBe(-1)
  expect(doc.querySelector('.tag')!.textContent).toBe('−2 rows')
})

it('counts deletes that meet on one line together, and steps through each', async () => {
  const book: Book = structuredClone(CHANGED)
  book.pending!.Sales.areas = [
    { change: 6, op: 'deleteRows', range: 'A8:F8', count: 2 }, { change: 7, op: 'deleteRows', range: 'A8:F8', count: 1 },
  ]
  const { doc } = await draw(book)

  expect([...doc.querySelectorAll('.tag')].map(tag => tag.textContent)).toEqual(['−3 rows'])
  expect(doc.querySelectorAll('.ring.gone')).toHaveLength(2)
  expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe('2 changed places')
})

// As the gatekeeper's own test of getPendingChanges() has it answer for one batch that merges and
// unmerges cells, resizes rows and a column and keeps more of both in view, and for a second that
// freezes the rows already frozen: it shows nowhere, and so has no area.
const LAID_OUT: Book = {
  saved: [{ id: 0, title: 'Sales', index: 0, rowCount: 20, columnCount: 6, frozenRowCount: 1 }],
  sheets: [{
    id: 0, title: 'Sales', index: 0, rowCount: 20, columnCount: 6, frozenRowCount: 5, frozenColumnCount: 2, touched: true,
    rows: { 3: { size: 40 }, 4: { size: 40 } },
    columns: { 2: { size: 150 } },
    merges: ['C2:D3'],
    cells: { C2: { text: 'Joined' }, A5: { text: 'Apart' } },
  }],
  pending: { Sales: {
    changes: [{ id: 3, type: 'updateSpreadsheet', changes: [
      { op: 'mergeCells', range: 'Sales!C2:D3', merge: 'ALL' },
      { op: 'unmergeCells', range: 'Sales!A5:B6' },
      { op: 'resizeRows', sheet: 'Sales', at: 3, count: 2, height: 40 },
      { op: 'resizeColumns', sheet: 'Sales', at: 'B', count: 1, width: 150 },
      { op: 'freeze', sheet: 'Sales', rows: 5, columns: 2 },
    ] }, { id: 4, type: 'updateSpreadsheet', changes: [{ op: 'freeze', sheet: 'Sales', rows: 5 }] }],
    areas: [
      { change: 3, op: 'mergeCells', range: 'C2:D3' },
      { change: 3, op: 'unmergeCells', range: 'A5:B6' },
      { change: 3, op: 'resizeRows', size: 40, range: 'A3:F4' },
      { change: 3, op: 'resizeColumns', size: 150, range: 'B1:B20' },
      { change: 3, op: 'freeze', frozen: { axis: 'rows', before: 1, after: 5 }, range: 'A2:F5' },
      { change: 3, op: 'freeze', frozen: { axis: 'columns', before: 0, after: 2 }, range: 'A1:B20' },
    ],
  } },
}

it('marks cells merged and unmerged, rows and columns resized, and the lines a freeze takes in', async () => {
  const { doc, cell, heads, look } = await draw(LAID_OUT)
  const named = (kind: 'col' | 'row', mark: string) =>
    heads(kind).filter(head => head.classList.contains(mark)).map(head => head.textContent)
  const rings = [...doc.querySelectorAll<HTMLElement>('.ring')]
  const [, across, , , down, frozen] = rings
  const ink = look(rings[0]).borderTopColor

  // Each area is a place the navigator stops at, and a change that shows nowhere is none. Merged
  // and unmerged cells are ringed as cells written are. The rings lie with the frozen lines they
  // are among: those among its rows, then those among its columns.
  expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe('6 changed places')
  expect(rings.map(ring => [ring.parentElement!.className, ring.className])).toEqual([
    ['held rows', 'ring'], ['held rows', 'ring sized across'], ['held rows', 'ring frozen'],
    ['held columns', 'ring'], ['held columns', 'ring sized down'], ['held columns', 'ring frozen'],
  ])

  // The merge is drawn as one cell, the cells unmerged apart, and each says which it is.
  expect(Math.round(cell('C2').getBoundingClientRect().width)).toBe(200)
  expect([cell('C2'), cell('A5'), cell('B6')].map(found => found.classList.contains('styled'))).toEqual([true, true, true])
  const peek = doc.getElementById('peek')!
  const said = (name: string) => {
    cell(name).dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    return [peek.querySelector('h3')!.textContent, ...[...peek.querySelectorAll('p')].map(line => line.textContent)]
  }
  expect(said('C2')).toEqual(['Pending change 1 of 2C2', 'Merged: a merged cell keeps what its first cell holds.'])
  // A cell that holds nothing has a card too, and is reached by the keyboard.
  expect(said('B6')).toEqual(['Pending change 1 of 2B6', 'Unmerged into separate cells.'])
  expect(cell('B6').hasAttribute('tabindex')).toBe(true)

  // Resized rows and columns are drawn at their new size, with their headers lit and a dashed
  // line where the last of them ends: across the sheet too.
  expect(Math.round(cell('A3').getBoundingClientRect().height)).toBe(40)
  expect(Math.round(cell('B1').getBoundingClientRect().width)).toBe(150)
  expect([named('row', 'hit'), named('row', 'sized'), named('col', 'sized')]).toEqual([['2', '3', '4', '5', '6'], ['4'], ['B']])
  expect([look(heads('row')[3]).borderBottomStyle, look(heads('col')[1]).borderRightStyle]).toEqual(['dashed', 'dashed'])
  expect([look(across).borderBottomStyle, look(across).borderTopWidth, look(down).borderRightStyle]).toEqual(['dashed', '0px', 'dashed'])
  expect(look(across).borderBottomColor).toBe(ink)

  // The lines a freeze brings into those kept in view are striped in their headers, and the line
  // that parts them from the rest is in the color of a change.
  expect([named('row', 'refrozen'), named('col', 'refrozen')]).toEqual([['2', '3', '4', '5'], ['A', 'B']])
  expect(look(heads('row')[1]).backgroundImage).toContain('repeating-linear-gradient')
  expect([look(heads('row')[4]).borderBottomColor, look(heads('col')[1]).borderRightColor, look(cell('B5')).borderBottomColor])
    .toEqual([ink, ink, ink])
  expect(look(frozen).borderTopWidth).toBe('0px')
  // A cell in a row kept in view and the last column kept in view has the columns' line alone.
  expect([look(cell('B1')).borderBottomWidth, look(cell('B1')).borderRightWidth]).toEqual(['1px', '3px'])

  // A header says each thing done to its line.
  expect(heads('row')[3].title).toBe(
    'Height set to 40 px by a pending change\nFrozen by a pending change: 5 rows frozen, 1 before')
  expect(heads('col')[1].title).toBe(
    'Width set to 150 px by a pending change\nFrozen by a pending change: 2 columns frozen, 0 before')
  expect(heads('col')[2].title).toBe('')
})

it('stripes the lines a freeze lets go of, and leaves the line that parts the sheet as it is where none moved', async () => {
  const book: Book = structuredClone(LAID_OUT)
  Object.assign(book.sheets[0], { frozenRowCount: 1, frozenColumnCount: undefined })
  book.saved![0].frozenRowCount = 3
  book.pending!.Sales.areas = [{ change: 3, op: 'freeze', frozen: { axis: 'rows', before: 3, after: 1 }, range: 'A2:F3' }]
  const { doc, heads, look } = await draw(book)

  expect(heads('row').filter(head => head.classList.contains('refrozen')).map(head => head.title)).toEqual(
    Array(2).fill('Unfrozen by a pending change: 1 row frozen, 3 before'))
  const grid = doc.getElementById('grid')!
  expect([grid.classList.contains('refrozen-rows'), grid.classList.contains('refrozen-columns')]).toEqual([true, false])
  // The corner's own lines: the one under it is the rows', and the one beside it the columns'.
  const corner = look(doc.querySelector('.h.corner')!)
  expect(corner.borderBottomColor).not.toBe(corner.borderRightColor)
})

/**
 * Whether a ring shows: some of its edge is in view with no cell over it, and none of it is under
 * a cell that stays in view as the ring does. Only a cell frozen a way the ring's are not may lie
 * over it, as the ring scrolls under that cell.
 */
function edgeOf(doc: Document, look: (element: Element) => CSSStyleDeclaration, ring: HTMLElement) {
  const depth = (element: Element) => Number(look(element).zIndex) || 0
  const layer = ring.parentElement!
  const { left, top, right, bottom } = ring.getBoundingClientRect()
  const edge = Array.from({ length: 12 }, (_point, n) => (n + .5) / 12).flatMap(part => {
    const [x, y] = [left + (right - left) * part, top + (bottom - top) * part]
    return [[x, top + 1], [x, bottom - 1], [left + 1, y], [right - 1, y]]
  })
  // A ring takes no pointer, so what is found under a point of it is the cell it lies over or under.
  const cells = edge.flatMap(([x, y]) => doc.elementFromPoint(x, y)?.closest('.c') ?? [])
  const over = cells.filter(cell => depth(cell) > Math.max(depth(layer), depth(ring)))
  const scrollsUnder = (cell: Element) => (cell.classList.contains('fr') && !layer.classList.contains('rows')) ||
    (cell.classList.contains('fc') && !layer.classList.contains('columns'))
  return ring.checkVisibility({ visibilityProperty: true }) && over.length < cells.length && over.every(scrollsUnder)
}

it('shows each place the navigator stops at, among the lines a sheet keeps in view and however it is scrolled', async () => {
  // In a frame smaller than the sheet, which then scrolls both ways under its frozen lines, and
  // large enough to keep those in view.
  const { doc, cell, look } = await draw(LAID_OUT, 600, 400)
  const scroll = doc.getElementById('scroll')!
  const next = doc.querySelector<HTMLElement>('#nav button[aria-label="Next change"]')!
  const shows = (ring: HTMLElement) => edgeOf(doc, look, ring)
  // The headers are over every cell and every ring, which scroll under them.
  const depths = (selector: string) => [...doc.querySelectorAll(selector)].map(element => Number(look(element).zIndex) || 0)
  expect(Math.min(...depths('#grid .h'))).toBeGreaterThan(Math.max(...depths('#grid .c, #marks > div')))
  scroll.scrollTo(120, 90)

  // The first cell of each area, which its ring starts on wherever the sheet is scrolled to: but
  // the way an area runs the sheet's whole length, where the sheet stays as its reader left it.
  const stops: [first: string, kept?: 'scrollLeft' | 'scrollTop'][] =
    [['C2'], ['A5'], ['A3', 'scrollLeft'], ['B1', 'scrollTop'], ['A2', 'scrollLeft'], ['A1', 'scrollTop']]
  for (const [first, kept] of stops) {
    const place = kept && scroll[kept]
    next.click()
    const ring = doc.querySelector<HTMLElement>('.ring.here')!
    await expect.poll(() => shows(ring), { message: `the ring that starts on ${first}` }).toBe(true)
    // Once the grid has settled from arriving, and the sheet from scrolling.
    await expect.poll(() => {
      const [at, on] = [ring.getBoundingClientRect(), cell(first).getBoundingClientRect()]
      return [first, kept === 'scrollLeft' || Math.round(at.left - on.left), kept === 'scrollTop' || Math.round(at.top - on.top)]
    }).toEqual([first, kept === 'scrollLeft' || -1, kept === 'scrollTop' || -1])
    expect([first, kept && scroll[kept]]).toEqual([first, place])
  }
  // Stepping to a ring among frozen rows scrolls the sheet across only, and among frozen columns down only.
  scroll.scrollTo({ left: 120, top: 90, behavior: 'instant' })
  next.click()
  await expect.poll(() => scroll.scrollLeft).toBe(0)
  expect(scroll.scrollTop).toBe(90)
})

it('rings a cell written in a row the sheet keeps in view, and keeps the ring on it as the rest scrolls', async () => {
  // A title too long for its cell, which runs on over the empty ones beside it and over what scrolls.
  const title = { text: 'A title that runs on over the cells beside it', change: 2, entered: 'A title that runs on over the cells beside it' }
  const book: Book = {
    sheets: [{ id: 1, title: 'Sales', index: 0, rowCount: 60, columnCount: 6, frozenRowCount: 1, touched: true, cells: { A1: title, A2: { text: 'EMEA' } } }],
    pending: { Sales: {
      changes: [{ id: 2, type: 'updateSpreadsheet', changes: [{ op: 'writeCells', range: 'Sales!A1', values: [[title.text]] }] }],
      areas: [{ change: 2, op: 'writeCells', range: 'A1' }],
    } },
  }
  const { doc, cell, look } = await draw(book)
  const ring = doc.querySelector<HTMLElement>('.ring')!
  const apart = () => Math.round(ring.getBoundingClientRect().top - cell('A1').getBoundingClientRect().top)

  expect(cell('A1').classList.contains('over')).toBe(true)
  expect(edgeOf(doc, look, ring)).toBe(true)
  // Once the grid has settled from arriving.
  await expect.poll(apart).toBe(-1)
  doc.getElementById('scroll')!.scrollTo(0, 400)
  await expect.poll(() => cell('A30').getBoundingClientRect().top).toBeLessThan(300)
  expect(apart()).toBe(-1)
  expect(edgeOf(doc, look, ring)).toBe(true)
})

it('keeps the count of rows deleted among those kept in view on their line as the rest scrolls', async () => {
  const book: Book = { sheets: [{ ...SALES, rowCount: 60, frozenRowCount: 3, touched: true }], pending: { Sales: {
    changes: [{ id: 2, type: 'updateSpreadsheet', changes: [{ op: 'deleteRows', sheet: 'Sales', at: 2, count: 2 }] }],
    areas: [{ change: 2, op: 'deleteRows', range: 'A2:F2', count: 2 }],
  } } }
  const { doc, cell } = await draw(book)
  const [ring, tag] = [doc.querySelector<HTMLElement>('.ring.gone')!, doc.querySelector<HTMLElement>('.tag')!]
  const apart = () => [ring, tag].map(mark => Math.round(mark.getBoundingClientRect().top - cell('A2').getBoundingClientRect().top))

  // Once the sheet has settled from arriving: while it arrives, every mark lies over all of it.
  await expect.poll(() => doc.querySelector('.arriving')).toBeNull()
  expect(apart()).toEqual([-1, -1])
  doc.getElementById('scroll')!.scrollTo(0, 400)
  await expect.poll(() => cell('A30').getBoundingClientRect().top).toBeLessThan(300)
  expect(apart()).toEqual([-1, -1])
  // The count is over the header of the frozen row it stands on, where it is read.
  const pill = tag.firstElementChild!.getBoundingClientRect()
  expect(doc.elementsFromPoint(pill.left + 2, pill.top + pill.height / 2).slice(0, 2).map(node => node.className)).toEqual(['', 'h row fr'])
  expect(doc.elementFromPoint(pill.left + 2, pill.top + pill.height / 2)).toBe(tag.firstElementChild)
})

it('keeps the count of columns deleted among those kept in view over their headers too', async () => {
  const book: Book = { sheets: [{ ...SALES, rowCount: 60, columnCount: 40, frozenColumnCount: 3, columns: {}, touched: true }], pending: { Sales: {
    changes: [{ id: 2, type: 'updateSpreadsheet', changes: [{ op: 'deleteColumns', sheet: 'Sales', at: 2, count: 2 }] }],
    areas: [{ change: 2, op: 'deleteColumns', range: 'B1:B60', count: 2 }],
  } } }
  const { doc, cell } = await draw(book)
  const tag = doc.querySelector<HTMLElement>('.tag.down')!

  await expect.poll(() => doc.querySelector('.arriving')).toBeNull()
  doc.getElementById('scroll')!.scrollTo(600, 0)
  await expect.poll(() => cell('H2').getBoundingClientRect().left).toBeLessThan(400)
  expect(Math.round(tag.getBoundingClientRect().left - cell('B2').getBoundingClientRect().left)).toBe(-1)
  const pill = tag.firstElementChild!.getBoundingClientRect()
  expect(doc.elementsFromPoint(pill.left + pill.width / 2 + 3, pill.top + 2).slice(0, 2).map(node => node.className)).toEqual(['', 'h col fc'])
})

it('keeps the sheet drawn, with its own changes and places to stop at, when a refresh cannot read its window', async () => {
  const book: Book = structuredClone(CHANGED)
  const { doc, cell, refresh } = await draw(book)
  const nav = doc.getElementById('nav')!
  const peek = doc.getElementById('peek')!

  // Another change is queued, and the read of the sheet with it fails.
  book.pending!.Sales.changes = [{ id: 1, type: 'updateSpreadsheet', changes: [] }, ...book.pending!.Sales.changes!]
  book.pending!.Sales.areas = [{ change: 1, op: 'writeCells', range: 'E9' }, ...book.pending!.Sales.areas!]
  book.failDrawing = () => 'Google Sheets did not answer.'
  refresh()
  await expect.poll(() => doc.getElementById('missed')!.hidden).toBe(false)

  // The navigator still steps through the rings drawn, and a cell's card counts the changes drawn.
  expect(nav.getAttribute('aria-label')).toBe('5 changed places')
  nav.querySelector<HTMLElement>('button:last-child')!.click()
  const here = doc.querySelector<HTMLElement>('.ring.here')!
  expect([here.isConnected, Math.round(here.getBoundingClientRect().left - cell('A2').getBoundingClientRect().left)]).toEqual([true, -1])
  cell('A2').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect(peek.querySelector('h3')!.textContent).toBe('Pending change 1 of 2A2')

  book.failDrawing = undefined
  doc.querySelector<HTMLElement>('#missed button')!.click()
  await expect.poll(() => nav.getAttribute('aria-label')).toBe('6 changed places')
  cell('A2').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect(peek.querySelector('h3')!.textContent).toBe('Pending change 2 of 3A2')
})

it('is a grid to a reader, whose changed cells are one stop for Tab and reached from it by the arrow keys', async () => {
  const book = structuredClone(CHANGED)
  const { doc, cell, heads, refresh } = await draw(book)
  const grid = doc.getElementById('grid')!
  const press = (key: string) => doc.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

  expect([grid.getAttribute('role'), grid.getAttribute('aria-rowcount'), grid.getAttribute('aria-colcount')]).toEqual(['grid', '13', '7'])
  expect([...grid.children].map(child => child.getAttribute('role'))).toEqual(Array.from({ length: 13 }, () => 'row'))
  expect(cell('B2').parentElement!.getAttribute('aria-rowindex')).toBe('3')
  expect([cell('B2').getAttribute('role'), cell('B2').getAttribute('aria-colindex')]).toEqual(['gridcell', '3'])
  expect([heads('col')[0].getAttribute('role'), heads('row')[0].getAttribute('role')]).toEqual(['columnheader', 'rowheader'])
  // The rows' own elements take no part in the layout.
  expect(Math.round(cell('B2').getBoundingClientRect().left - cell('A2').getBoundingClientRect().left)).toBe(100)

  const stops = () => [...grid.querySelectorAll<HTMLElement>('.c[tabindex]')].map(node => node.tabIndex)
  expect(stops()).toEqual([0, -1, -1, -1, -1, -1])
  cell('A2').focus()
  press('ArrowRight')
  expect(doc.activeElement).toBe(cell('B2'))
  press('ArrowDown')
  expect(doc.activeElement).toBe(cell('B3'))
  press('Home')
  expect(doc.activeElement).toBe(cell('A2'))
  // A cell the changes may alter without writing it is a stop too: its card says so.
  press('End')
  expect([doc.activeElement, doc.querySelector('#peek h3')!.firstChild!.textContent]).toEqual([cell('C3'), 'May change'])
  press('ArrowLeft')
  expect(doc.activeElement).toBe(cell('B3'))
  // Tab comes back to the cell the keyboard left.
  expect(stops()).toEqual([-1, -1, -1, -1, 0, -1])
  expect(cell('B3').getAttribute('aria-describedby')).toBe('peek')
  // Its card stays open on it when the sheet is drawn again under the keyboard.
  const [peek, drawn] = [doc.getElementById('peek')!, cell('B3')]
  refresh()
  await expect.poll(() => cell('B3')).not.toBe(drawn)
  expect([doc.activeElement, peek.hidden]).toEqual([cell('B3'), false])

  // A cell no change touches any longer leaves the stop, and the keyboard, to the first one does.
  book.sheets[0].cells!.B3 = { text: '5', kind: 'number' }
  refresh()
  await expect.poll(stops).toEqual([0, -1, -1, -1, -1])
  expect(doc.activeElement).toBe(cell('A2'))
})

it('draws a tick box however narrow its column, and a formula written to one as its text', async () => {
  const { cell } = await draw({ sheets: [{
    id: 1, title: 'Tasks', index: 0, rowCount: 4, columnCount: 3, columns: { 1: { size: 24 } },
    cells: {
      A1: { text: 'TRUE', kind: 'boolean', holds: ['checkbox'] },
      A2: { pending: true, change: 4, entered: '=TRUE()', saved: 'FALSE', holds: ['checkbox'] },
      A3: { text: '#DIV/0!', kind: 'error', holds: ['checkbox'] },
    },
  }] })

  expect([cell('A1').querySelector('.box')?.ariaLabel, cell('A1').textContent]).toEqual(['Checked', ''])
  // Only Google Sheets can say whether the formula ticks the box.
  expect([cell('A2').querySelector('.box'), cell('A2').textContent]).toEqual([null, '=TRUE()'])
  // A formula that fails ticks nothing, and Google Sheets shows its error there.
  expect([cell('A3').querySelector('.box'), cell('A3').textContent]).toEqual([null, '#DIV/0!'])
})

it('steps through the changes, and says what one did to the cell pointed at or picked', async () => {
  const { doc, cell } = await draw(CHANGED)
  const nav = doc.getElementById('nav')!
  expect(nav.getAttribute('aria-label')).toBe('5 changed places')

  nav.querySelector<HTMLElement>('button:last-child')!.click()
  expect(doc.querySelector('.ring.here')).toBe(doc.querySelector('.ring'))

  const peek = doc.getElementById('peek')!
  expect(peek.hidden).toBe(true)
  cell('C2').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect(peek.hidden).toBe(false)
  expect(peek.querySelector('h3')!.textContent).toBe('Pending change 1 of 2C2')
  expect([...peek.querySelectorAll('.swap > span')].map(part => [part.className, part.textContent])).toEqual([
    ['was', '8'], ['to', '→'], ['now', '=B2*2'],
  ])
  cell('A3').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect([...peek.querySelectorAll('.swap > span')].map(part => part.textContent)).toEqual(['APAC', '→', 'empty'])
  // A cell whose formatting a change sets names what was set, and is reached by keyboard too.
  cell('B3').focus()
  expect(peek.querySelector('h3')!.textContent).toBe('Pending change 2 of 2B3')
  expect(peek.querySelector('p')!.textContent).toBe('Formatting set: bold, fill color')
  // Its card stays with it while the keyboard is on it, as when a move to it scrolls the grid.
  const scrolled = () => doc.getElementById('scroll')!.dispatchEvent(new Event('scroll'))
  scrolled()
  expect([peek.hidden, peek.querySelector('h3')!.textContent]).toEqual([false, 'Pending change 2 of 2B3'])
  cell('B3').blur()
  cell('A1').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect(peek.hidden).toBe(true)
  // One the pointer opened is closed by a scroll.
  cell('C2').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect(peek.hidden).toBe(false)
  scrolled()
  expect(peek.hidden).toBe(true)
  // The pointer may go from the cell onto its card, which stays until the pointer leaves it.
  cell('C2').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  cell('C2').closest('[role="grid"]')!.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: peek }))
  expect([peek.hidden, doc.defaultView!.getComputedStyle(peek).pointerEvents]).toEqual([false, 'auto'])
  peek.dispatchEvent(new PointerEvent('pointerleave'))
  expect(peek.hidden).toBe(true)
  // Escape puts away the card of the cell the keyboard is on, and leaves the keyboard there.
  cell('B3').focus()
  expect(peek.hidden).toBe(false)
  cell('B3').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect([peek.hidden, doc.activeElement]).toEqual([true, cell('B3')])
  cell('B3').blur()

  // The cell picked is named above the grid with what it will hold.
  cell('C2').click()
  expect(doc.querySelector('#strip .at')!.textContent).toBe('C2')
  expect(doc.querySelector('#strip .fx')!.textContent).toBe('=B2*2')
  expect(cell('C2').classList.contains('picked')).toBe(true)
})

it('names, of a batch that formats several ranges, what it set on the cell pointed at', async () => {
  const { doc, cell } = await draw({
    sheets: [{
      id: 1, title: 'Sales', index: 0, rowCount: 4, columnCount: 3, touched: true,
      formats: [{ bold: true }, { italic: true }],
      cells: {
        A1: { text: 'Region', format: 0, formatted: true }, B2: { text: '5', format: 1, formatted: true },
        C4: { text: 'Moved', format: 1, formatted: true },
      },
    }],
    pending: { Sales: {
      changes: [{ id: 3, type: 'updateSpreadsheet', changes: [
        { op: 'formatCells', range: "'Sales'!A1:C1", format: { bold: true } },
        { op: 'formatCells', range: 'Sales!B2', format: { italic: true } },
      ] }],
      areas: ['A1:C1', 'B2', 'C4'].map(range => ({ change: 3, op: 'formatCells', range })),
    } },
  })
  const set = (name: string) => {
    cell(name).focus()
    return doc.querySelector('#peek p')!.textContent
  }

  expect(set('A1')).toBe('Formatting set: bold')
  expect(set('B2')).toBe('Formatting set: italic')
  // A cell that later changes have moved out of every range the batch named is told all it set.
  expect(set('C4')).toBe('Formatting set: bold, italic')
})

const small = (id: number, title: string, index: number, more: Partial<Sheet> = {}): Sheet =>
  ({ id, title, index, rowCount: 4, columnCount: 3, cells: { A1: { text: `${title} A1` } }, ...more })

it('lets a long saved value be scrolled in the card of the change that replaces it', async () => {
  const saved = Array.from({ length: 8 }, (_line, n) => `line ${n + 1}`).join('\n')
  const { doc, cell, look } = await draw({
    sheets: [small(1, 'Notes', 0, { touched: true, cells: { A1: { text: 'short', change: 2, entered: 'short', saved } } })],
    pending: { Notes: {
      changes: [{ id: 2, type: 'updateSpreadsheet', changes: [{ op: 'writeCells', range: 'Notes!A1', values: [['short']] }] }],
      areas: [{ change: 2, op: 'writeCells', range: 'A1' }],
    } },
  })

  cell('A1').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  const was = doc.querySelector<HTMLElement>('#peek .was')!
  expect([was.textContent, look(was).overflowY, was.scrollHeight > was.clientHeight]).toEqual([saved, 'auto', true])
})

it('shows the fill and the color a change gives a cell it also writes, under the corner that marks it', async () => {
  const format = { fillColor: '#000080', textColor: '#ffffff' }
  const { cell, look } = await draw({
    sheets: [small(1, 'Sales', 0, { touched: true, formats: [format], cells: {
      A1: { text: 'Region', change: 2, entered: 'Region', format: 0, formatted: true }, B1: { format: 0, formatted: true },
      A2: { text: 'West', change: 2, entered: 'West' },
    } })],
    pending: { Sales: {
      changes: [{ id: 2, type: 'updateSpreadsheet', changes: [
        { op: 'writeCells', range: 'Sales!A1:A2', values: [['Region'], ['West']] }, { op: 'formatCells', range: 'Sales!A1:B1', format },
      ] }],
      areas: [{ change: 2, op: 'writeCells', range: 'A1:A2' }, { change: 2, op: 'formatCells', range: 'A1:B1' }],
    } },
  })
  const colors = (name: string) => [look(cell(name)).backgroundColor, look(cell(name)).color]
  const set = ['rgb(0, 0, 128)', 'rgb(255, 255, 255)']

  // Written or not, a cell the change formats looks as the change makes it.
  expect([colors('A1'), colors('B1')]).toEqual([set, set])
  for (const name of ['A1', 'B1']) expect(look(cell(name)).backgroundImage).toContain('linear-gradient(135deg')
  // The one it writes is underlined, so that what it holds is not taken for saved.
  expect(['A1', 'B1'].map(name => look(cell(name)).backgroundImage.includes('linear-gradient(0deg'))).toEqual([true, false])
  // One it only writes is tinted.
  expect([cell('A2').className, colors('A2')[0] === colors('A1')[0]]).toEqual(['c new', false])
})

it('lists the sheets as tabs, marking the ones added, renamed, moved and deleted, and opens one', async () => {
  const { doc, reads, cell, tabs } = await draw({
    saved: [small(1, 'Sales', 0), small(2, 'Costs', 1), small(3, 'Old', 2), small(4, 'Notes', 3)].map(info),
    sheets: [small(4, 'Notes', 0), small(1, 'Sales', 1), small(2, 'Spend', 2, { touched: true }), small(9, 'Plan', 3, { touched: true })],
  }, 1100)

  expect(tabs().map(tab => tab.title)).toEqual([
    'Notes (moved)', 'Sales', 'Spend (renamed from “Costs”; has pending edits)',
    'Old (deleted by a pending change)', 'Plan (new, not yet added)',
  ])
  // The dot is green on a sheet added, red on one deleted, and purple on one otherwise changed.
  expect(tabs().map(tab => tab.dataset.touched)).toEqual([undefined, undefined, 'changed', 'removed', 'added'])
  const dots = tabs().map(tab => getComputedStyle(tab, '::after').backgroundColor)
  expect(new Set(dots.slice(2)).size).toBe(3)
  // It opens on the first sheet the changes touch.
  expect(doc.querySelector('#strip b')!.textContent).toBe('Spend')
  expect(tabs()[3].getAttribute('aria-disabled')).toBe('true')

  tabs()[4].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Plan A1')
  expect(reads).toEqual(["'Spend'!A1:C4", "'Plan'!A1:C4"])
  expect(tabs().map(tab => tab.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false', 'true'])
})

it('lists the sheets the changes touch first, under a heading of their own, when there are many', async () => {
  const sheets = Array.from({ length: 10 }, (_, n) => small(n + 1, `S${n + 1}`, n, n === 4 || n === 8 ? { touched: true } : {}))
  const { doc, tabs } = await draw({ sheets }, 1100)

  expect([...doc.querySelectorAll('#outline h3')].map(heading => heading.textContent)).toEqual(['2 changed', 'Unchanged'])
  expect(tabs().map(tab => tab.title.split(' ')[0])).toEqual(['S5', 'S9', 'S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S8', 'S10'])
  expect(tabs().slice(0, 3).map(tab => getComputedStyle(tab, '::after').content)).toEqual(['"Edited"', '"Edited"', 'none'])
})

it('opens on a sheet of cells, not a chart that comes first, and opens no chart', async () => {
  const chart = { id: 7, title: 'Chart', index: 0, rowCount: 0, columnCount: 0, touched: true as const }
  const { doc, reads, tabs } = await draw({ sheets: [chart, small(1, 'Sales', 1)] }, 1100)

  expect(doc.querySelector('#strip b')!.textContent).toBe('Sales')
  expect(tabs()[0].title).toBe('Chart (has pending edits; a chart, not drawn in this preview)')
  expect(tabs()[0].getAttribute('aria-disabled')).toBe('true')

  tabs()[0].click()
  await pause(50)
  expect(reads).toEqual(["'Sales'!A1:C4"])
})

it('draws a spreadsheet that is a chart alone as a sheet with no cells, and asks for none', async () => {
  const { doc, reads } = await draw({ sheets: [{ id: 7, title: 'Trend', index: 0, rowCount: 0, columnCount: 0 }] })

  expect(doc.getElementById('error')).toBeNull()
  expect([...doc.querySelectorAll('#strip b, #strip .size')].map(part => part.textContent)).toEqual(['Trend', 'Chart'])
  expect(reads).toEqual([])
})

it('lists the sheets beside one whose cells could not be read, for another to be opened', async () => {
  const book: Book = {
    sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1)],
    failDrawing: range => range.startsWith("'Sales'") ? 'Google Sheets did not answer.' : undefined,
  }
  const { doc, cell, tabs } = await draw(book, 1100)
  expect(doc.getElementById('error')!.textContent).toContain('Google Sheets did not answer.')

  tabs()[1].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Costs A1')
  expect(doc.getElementById('error')).toBeNull()
})

it('keeps the keyboard on the name of a sheet as it is opened', async () => {
  const { doc, cell, tabs } = await draw({ sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1)] }, 1100)

  tabs()[1].focus()
  tabs()[1].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Costs A1')

  expect(doc.activeElement).toBe(tabs()[1])
})

it('keeps the keyboard on the link in a cell as the sheet is drawn again', async () => {
  const { doc, cell, refresh } = await draw({ sheets: [{
    id: 1, title: 'Links', index: 0, rowCount: 3, columnCount: 2, cells: { A1: { text: 'Docs', link: 'https://example.com/docs' } },
  }] })
  const link = () => cell('A1')?.querySelector('a')
  const first = link()!
  first.focus()

  refresh()
  await expect.poll(() => !!link() && link() !== first).toBe(true)
  expect(doc.activeElement).toBe(link())
})

it('hands the keyboard to what opens the outline when picking a sheet closes it', async () => {
  const { doc, cell, tabs } = await draw({ sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1)] }, 670)
  const toggle = doc.getElementById('outline-toggle')!

  toggle.click()
  tabs()[1].focus()
  tabs()[1].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Costs A1')

  expect(doc.getElementById('outline')!.hidden).toBe(true)
  expect(doc.activeElement).toBe(toggle)
})

/**
 * The rows a window asks for, and how many cells it draws with the one row, and the `frozen`
 * columns, the sheet keeps in view.
 */
function windowOf(range: string, frozen = 0) {
  const { r0, r1, c0, c1 } = boundsOf(range)
  return { r0, r1, cells: (r1 - r0 + 2) * (c1 - c0 + 1 + Math.min(frozen, c0 - 1)) }
}

/** A sheet too large to draw whole, with a row kept in view and one change at B3000. */
function bigBook(more: Partial<Sheet> = {}): Book {
  const cells = Object.fromEntries(Array.from({ length: 5000 }, (_row, n) => [`A${n + 1}`, { text: `row ${n + 1}` }]))
  return {
    sheets: [{
      id: 1, title: 'Big', index: 0, rowCount: 5000, columnCount: 60, frozenRowCount: 1, touched: true, ...more,
      cells: { ...cells, B3000: { text: 'new', change: 2, entered: 'new' }, ...more.cells },
    }],
    pending: { Big: {
      changes: [{ id: 2, type: 'updateSpreadsheet', changes: [{ op: 'writeCells', range: 'Big!B3000', values: [['new']] }] }],
      areas: [{ change: 2, op: 'writeCells', range: 'B3000' }],
    } },
  }
}

it('draws a sheet in its own looks, whatever the sheet shown before it had at the same places among its formats', async () => {
  const loud = { fillColor: '#b6d7a8', bold: true, italic: true, underline: true }
  const cells = { A1: { text: 'first', format: 0 }, B1: { text: 'second', format: 1 } }
  const { cell, look, tabs } = await draw({ sheets: [
    small(1, 'Loud', 0, { formats: [loud, loud], cells }),
    small(2, 'Plain', 1, { formats: [{ fillColor: '#ffffff' }, { fontSize: 10 }], cells }),
  ] }, 1100)
  const looks = (name: string) => {
    const { backgroundColor, fontWeight, fontStyle, textDecorationLine } = look(cell(name))
    return [backgroundColor, fontWeight, fontStyle, textDecorationLine]
  }
  expect(looks('A1')).toEqual(['rgb(182, 215, 168)', '700', 'italic', 'underline'])

  tabs()[1].click()
  await expect.poll(() => frame!.contentDocument!.querySelector('#strip b')!.textContent).toBe('Plain')
  await expect.poll(() => looks('A1')).toEqual(['rgb(255, 255, 255)', '400', 'normal', 'none'])
  expect(looks('B1')).toEqual(['rgb(255, 255, 255)', '400', 'normal', 'none'])
})

it('reads a large sheet a window at a time: first around its changes, then where it is scrolled to', async () => {
  const { doc, reads, cell } = await draw(bigBook())

  // The first window holds the change, not the top of the sheet, and the frozen row comes with it.
  expect(reads).toHaveLength(1)
  expect(windowOf(reads[0]).r0).toBeLessThanOrEqual(3000)
  expect(windowOf(reads[0]).r1).toBeGreaterThanOrEqual(3000)
  expect(windowOf(reads[0]).r0).toBeGreaterThan(1)
  expect(cell('B3000').classList.contains('new')).toBe(true)
  expect(cell('A1').textContent).toBe('row 1')
  const scroll = doc.getElementById('scroll')!
  const top = () => cell('B3000').getBoundingClientRect().top
  expect(top()).toBeGreaterThan(0)
  expect(top()).toBeLessThan(600)
  // The whole sheet can be scrolled, though only a window of it is drawn.
  expect(scroll.scrollHeight).toBeGreaterThan(5000 * 21)

  scroll.scrollTo(0, 100 * 21)
  await expect.poll(() => cell('A101')?.textContent, { timeout: 10_000 }).toBe('row 101')
  // What was scrolled to is where it was as its window arrives: at the top, under the headers.
  const offset = () => Math.round(cell('A101').getBoundingClientRect().top - scroll.getBoundingClientRect().top)
  await expect.poll(offset).toBe(24)
  // A window that arrives later takes its place without moving in.
  scroll.scrollTo(0, 400 * 21)
  await expect.poll(() => cell('A401')?.textContent, { timeout: 10_000 }).toBe('row 401')
  expect(Math.round(cell('A401').getBoundingClientRect().top - scroll.getBoundingClientRect().top)).toBe(24)
  expect(reads.length).toBeGreaterThan(1)
  for (const range of reads) expect(windowOf(range).cells).toBeLessThanOrEqual(10_000)
})

const pause = (time: number) => new Promise(resolve => setTimeout(resolve, time))

it('draws the window in view again in a font that arrives after it was scrolled to', async () => {
  let arrive!: (bytes: ArrayBuffer) => void
  const { doc, cell } = await draw({ ...bigBook({ formats: [{ fontFamily: 'Poppins' }] }), font: new Promise(resolve => { arrive = resolve }) })
  doc.getElementById('scroll')!.scrollTo(0, 100 * 21)
  await expect.poll(() => cell('A101')?.textContent, { timeout: 10_000 }).toBe('row 101')
  const drawn = cell('A101')

  arrive(await (await fetch(FONT_URL)).arrayBuffer())

  await expect.poll(() => cell('A101') !== drawn).toBe(true)
})

it('opens on a change clear of the rows a sheet keeps in view', async () => {
  const { cell } = await draw(bigBook({ frozenRowCount: 6 }))
  expect(cell('B3000').getBoundingClientRect().top).toBeGreaterThanOrEqual(cell('A6').getBoundingClientRect().bottom)
})

it('keeps what is drawn when a read fails as the sheet is scrolled, says so, and does not ask again until asked', async () => {
  const book = bigBook()
  const { doc, reads, cell } = await draw(book)
  const scroll = doc.getElementById('scroll')!
  const missed = () => doc.getElementById('missed')!

  book.failDrawing = () => 'Google Sheets did not answer.'
  scroll.scrollTo(0, 100 * 21)
  await expect.poll(() => missed().hidden).toBe(false)
  expect(missed().textContent).toBe('More of this sheet could not be readTry again')
  // The sheet read before is still there, and nothing took its place.
  expect(doc.getElementById('error')).toBeNull()
  expect(doc.getElementById('page')!.hidden).toBe(false)
  expect(cell('B3000').textContent).toBe('new')
  // One read failed. It is not asked again by itself, nor by scrolling on at once.
  expect(reads).toHaveLength(2)
  await pause(400)
  scroll.scrollTo(0, 110 * 21)
  await pause(400)
  expect(reads).toHaveLength(2)

  book.failDrawing = undefined
  missed().querySelector('button')!.click()
  await expect.poll(() => cell('A111')?.textContent, { timeout: 10_000 }).toBe('row 111')
  expect(missed().hidden).toBe(true)
})

it('reads nothing on while a refresh is putting the changes in place', async () => {
  const book = bigBook()
  const { doc, reads, asked, cell, refresh } = await draw(book)
  const { promise, resolve: answer } = Promise.withResolvers<void>()
  book.wait = promise

  refresh()
  await expect.poll(() => asked.length).toBe(2)
  doc.getElementById('scroll')!.scrollTo(0, 100 * 21)
  await pause(300)
  // The scroll is followed by the refresh itself, once what it read is in place.
  expect(reads).toHaveLength(1)
  answer()
  await expect.poll(() => cell('A101')?.textContent, { timeout: 10_000 }).toBe('row 101')
})

it('asks for a smaller window when one is refused as too large', async () => {
  const book = bigBook()
  book.failDrawing = range => windowOf(range).cells > 3000
    ? 'The drawing of this range is too large to read at once. Request fewer cells.' : undefined
  const { doc, reads, cell } = await draw(book)

  // The first window was halved until it fit, and still holds the change it opens on.
  expect(reads.map(range => windowOf(range).cells > 3000)).toEqual([true, true, false])
  expect(cell('B3000').textContent).toBe('new')
  expect(doc.getElementById('error')).toBeNull()
  // Scrolling reads on in windows of the size that fit.
  doc.getElementById('scroll')!.scrollTo(0, 100 * 21)
  await expect.poll(() => cell('A101')?.textContent, { timeout: 10_000 }).toBe('row 101')
  expect(reads.slice(3).every(range => windowOf(range).cells <= 3000)).toBe(true)
})

it('starts a window too small for the view where the view starts', async () => {
  const book = bigBook()
  // As the session refuses more cells than it draws, were that fewer.
  book.failDrawing = range => windowOf(range).cells > 400
    ? "readDrawing may draw at most 400 cells, those of the sheet's frozen rows and columns included." : undefined
  // In a frame that shows more columns than such a window holds.
  const { doc, reads, cell } = await draw(book, 1600)

  const scroll = doc.getElementById('scroll')!
  scroll.scrollTo(500, 100 * 21)
  // Every column in view has its room, from the first: F. The rows start at the first in view
  // under the frozen one, 102, and are as many as that leaves room for.
  await expect.poll(() => cell('F102')?.getBoundingClientRect().left, { timeout: 10_000 }).toBe(scroll.getBoundingClientRect().left + 46)
  // Once the sheet has settled from arriving.
  await expect.poll(() => Math.round(cell('F102').getBoundingClientRect().top - scroll.getBoundingClientRect().top)).toBe(24 + 21)
  const { r0, r1, c0, c1 } = boundsOf(reads.at(-1)!)
  expect([r0, c0, c1, (r1 - r0 + 2) * (c1 - c0 + 1) <= 400]).toEqual([102, 6, 21, true])
  expect([cell('A102'), cell('F101')]).toEqual([undefined, undefined])
})

/** Rows 2 to `last` hidden, as a filter leaves them. */
const filtered = (last: number): Record<number, Line> => Object.fromEntries(Array.from({ length: last - 1 }, (_row, n) => [n + 2, { hidden: true as const }]))

it('reads past the rows a filter hides under a frozen first row, in a few reads, to those that show', async () => {
  // More of them than one read holds beside the columns in view.
  const { reads, cell, doc } = await draw({ sheets: [{ ...bigBook().sheets[0], touched: undefined, rows: filtered(2500) }] })
  const scroll = () => doc.getElementById('scroll')!.getBoundingClientRect()

  await expect.poll(() => cell('A2501')?.textContent, { timeout: 10_000 }).toBe('row 2501')
  // The first row that shows is under the frozen one, once the page has settled from arriving,
  // and every column in view is drawn.
  await expect.poll(() => Math.round(cell('A2501').getBoundingClientRect().top - scroll().top)).toBe(24 + 21)
  expect(cell('I2501').getBoundingClientRect().right).toBeGreaterThan(scroll().right)
  expect(reads.length).toBeLessThanOrEqual(5)
  for (const range of reads) expect(windowOf(range).cells).toBeLessThanOrEqual(10_000)
  // And nothing more is read of a view that stays where it is.
  const made = reads.length
  await pause(300)
  expect(reads).toHaveLength(made)
})

it('stops reading on of rows that all turn out hidden, and reads on when the sheet is scrolled', async () => {
  const { reads, cell, doc } = await draw({ sheets: [{ ...bigBook().sheets[0], touched: undefined, rows: filtered(4990) }] })

  // One read to open and four on end, each of all the rows there is room for.
  await expect.poll(() => reads.length, { timeout: 10_000 }).toBe(5)
  await pause(300)
  expect([reads.length, cell('A4991')]).toEqual([5, undefined])
  // The view is left with no cell drawn, and says how to have it read on.
  const more = doc.getElementById('more')!
  expect([more.textContent, more.getAttribute('role')]).toEqual(['Not read this far yet. Scroll to read on.', 'status'])
  const [said, view] = [more.getBoundingClientRect(), doc.getElementById('scroll')!.getBoundingClientRect()]
  expect(said.top > view.top && said.bottom < view.bottom && said.left > view.left && said.right < view.right).toBe(true)
  doc.getElementById('scroll')!.scrollBy(0, 1)
  await expect.poll(() => cell('A4991')?.textContent, { timeout: 10_000 }).toBe('row 4991')
  expect(more.textContent).toBe('')
})

/** Whether a session with room for 1,500 cells refuses the window `range` names. */
const refused = (range: string) => windowOf(range).cells > 1500

it('asks for no more than a refusal left room for until the sheet is scrolled, and then for twice that', async () => {
  const sheet = { ...bigBook().sheets[0], touched: undefined, rows: filtered(4990) }
  const { reads, doc } = await draw({ sheets: [sheet], failDrawing: range => refused(range)
    ? 'The drawing of this range is too large to read at once. Request fewer cells.' : undefined })

  // Two windows refused to open, then one that fits, and four on end of that size.
  await expect.poll(() => reads.length, { timeout: 10_000 }).toBe(7)
  await pause(300)
  expect(reads.map(refused)).toEqual([true, true, false, false, false, false, false])
  doc.getElementById('scroll')!.scrollBy(0, 1)
  await expect.poll(() => reads.length, { timeout: 10_000 }).toBeGreaterThan(8)
  await pause(300)
  expect(reads.slice(7).map(refused)).toEqual([true, false, false, false, false])
  // A view resized is one its reader has moved, as much as one scrolled.
  frame!.style.height = '500px'
  await expect.poll(() => reads.length, { timeout: 10_000 }).toBeGreaterThan(12)
})

it('asks once for a window refused as too large, however the sheet is scrolled after', async () => {
  const sheet = { ...bigBook().sheets[0], touched: undefined }
  const { reads, doc } = await draw({ sheets: [sheet], failDrawing: range => refused(range)
    ? 'The drawing of this range is too large to read at once. Request fewer cells.' : undefined })
  // Each view is offered twice the room that fits and refused it: more views than windows are
  // kept, and back over them.
  const scroll = doc.getElementById('scroll')!
  const tops = Array.from({ length: 7 }, (_view, n) => n * 400 * 21)
  for (const top of [...tops, ...tops.toReversed(), ...tops]) {
    scroll.scrollTo(0, top)
    // Until nothing more is asked for.
    for (let asked = -1; asked !== reads.length;) {
      asked = reads.length
      await pause(250)
    }
  }
  const turned = reads.filter(refused)
  expect(turned.length).toBeGreaterThan(6)
  expect(new Set(turned).size).toBe(turned.length)
})

it('reads where the sheet was scrolled to while its windows were read, however many of them on end', async () => {
  const book = bigBook()
  // A reader who drags the sheet on by four hundred rows as each of eight windows is asked for.
  let drags = -1
  book.failDrawing = () => {
    if (drags >= 0 && drags < 8) frame!.contentDocument!.getElementById('scroll')!.scrollTo(0, ++drags * 400 * 21)
    return undefined
  }
  const { doc, cell } = await draw(book)
  await expect.poll(() => cell('B3000')?.textContent).toBe('new')

  drags = 0
  doc.getElementById('scroll')!.scrollTo(0, 0)
  await expect.poll(() => drags, { timeout: 10_000 }).toBe(8)
  // Where the drag ended is read, though more windows than are read on end of one view came before it.
  await expect.poll(() => cell('A3202')?.textContent, { timeout: 10_000 }).toBe('row 3202')
  expect(doc.getElementById('scroll')!.scrollTop).toBe(8 * 400 * 21)
  expect(doc.getElementById('more')!.textContent).toBe('')
})

// Steps to the change after the one the sheet opened on, and says where its ring comes to rest:
// how far it is from its cell, and whether it is in view.
async function stepTo(book: Book, name: string) {
  const { doc, reads, cell } = await draw(book)
  const scroll = doc.getElementById('scroll')!
  await expect.poll(() => cell('B200')?.textContent).toBe('first')
  // The step is a smooth one, as it is where motion is not reduced.
  expect(frame!.contentWindow!.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false)
  const next = doc.querySelector<HTMLElement>('#nav button[aria-label="Next change"]')!
  next.click()
  next.click()
  await expect.poll(() => cell(name)?.textContent, { timeout: 10_000 }).toBe('new')
  const ring = doc.querySelector<HTMLElement>('.ring.here')!
  await expect.poll(() => {
    const [at, on, view] = [ring, cell(name), scroll].map(element => element.getBoundingClientRect())
    return [Math.round(at.left - on.left), Math.round(at.top - on.top), at.top > view.top + 24 && at.bottom < view.bottom]
  }, { timeout: 10_000 }).toEqual([-1, -1, true])
  return reads
}

/** The big sheet with changes at B200, where it opens, at `to` and at B3000. */
const stepping = (to: string) => {
  const book = bigBook({ cells: { B200: { text: 'first', change: 2, entered: 'first' }, [to]: { text: 'new', change: 2, entered: 'new' } } })
  const ranges = [...new Set(['B200', to, 'B3000'])]
  book.pending!.Big = {
    changes: [{ id: 2, type: 'updateSpreadsheet', changes: ranges.map(range => ({ op: 'writeCells', range: `Big!${range}`, values: [[range === 'B200' ? 'first' : 'new']] })) }],
    areas: ranges.map(range => ({ change: 2, op: 'writeCells', range })),
  }
  return book
}

it('steps smoothly to a change at the edge of what is drawn, through the window read on its way', async () => {
  // Rows 128 to 297 are drawn around the first change: the view reaches their end before the step does.
  const reads = await stepTo(stepping('B296'), 'B296')
  expect(reads.map(range => windowOf(range).r1)).toEqual([297, expect.any(Number)])
})

it('keeps the row it is at as it steps to a change that runs the whole length of the sheet', async () => {
  // A column inserted between the changes at B200, where the sheet opens, and at B3000.
  const book = stepping('B200')
  book.sheets[0].columns = { 4: { inserted: true } }
  const { changes, areas } = book.pending!.Big as { changes: { changes: object[] }[], areas: object[] }
  changes[0].changes.splice(1, 0, { op: 'insertColumns', sheet: 'Big', at: 4 })
  areas.splice(1, 0, { change: 2, op: 'insertColumns', range: 'D1:D5000' })
  const { doc, reads, cell } = await draw(book)
  const scroll = doc.getElementById('scroll')!
  await expect.poll(() => cell('B200')?.textContent).toBe('new')
  await pause(300)
  const before = [scroll.scrollTop, scroll.scrollLeft, reads.length]

  const next = doc.querySelector<HTMLElement>('#nav button[aria-label="Next change"]')!
  next.click()
  next.click()
  // The column is in view where the reader is: nothing scrolls, and no window is read.
  await expect.poll(() => doc.querySelector('.ring.here')!.getBoundingClientRect().height).toBeGreaterThan(scroll.clientHeight)
  await pause(600)
  expect([scroll.scrollTop, scroll.scrollLeft, reads.length]).toEqual(before)
})

it('stays on its sheet, under the title it has now, when a window read by its title turns out to be of another sheet', async () => {
  const book: Book = { sheets: ['Big', 'Costs'].map((title, n) =>
    small(n + 1, title, n, { rowCount: 5000, columnCount: 60, cells: { A2000: { text: `of ${title}` } } })) }
  const { doc, cell, tabs, reads } = await draw(book)
  expect(tabs().map(tab => tab.textContent)).toEqual(['Big5000 × 60', 'Costs5000 × 60'])

  // A collaborator gives the sheet another title, and its title to the other, before more of it is read.
  book.sheets[0].title = 'Old'
  book.sheets[1].title = 'Big'
  doc.getElementById('scroll')!.scrollTo(0, 2000 * 21)
  await expect.poll(() => tabs().map(tab => [tab.textContent, tab.getAttribute('aria-pressed')]))
    .toEqual([['Old5000 × 60', 'true'], ['Big5000 × 60', 'false']])
  // The window of the other sheet was not drawn: the sheet's own is, read by its new title.
  await expect.poll(() => cell('A2000')?.textContent).toBe('of Big')
  expect(reads.map(range => range.split('!')[0])).toEqual(["'Big'", "'Big'", "'Old'"])
})

it('steps at once to a change far from what is drawn, and ends on it whatever sizes the rows there turn out', async () => {
  // The rows around it are three times the height they are taken for until they are read.
  const book = stepping('B3000')
  book.sheets[0].rows = Object.fromEntries(Array.from({ length: 200 }, (_row, n) => [n + 2900, { size: 63 }]))
  const reads = await stepTo(book, 'B3000')
  // No window was read on the way.
  expect(reads.every((range, n) => n === 0 || windowOf(range).r1 > 2990)).toBe(true)
})

it('draws a merge, and a chart, that start outside the window drawn', async () => {
  const { reads, cell, doc } = await draw(bigBook({
    merges: ['C2000:D3005'],
    cells: { C2000: { text: 'Tall merge' } },
    charts: [{ title: 'Trend', anchor: 'B2800', offsetX: 0, offsetY: 0, width: 300, height: 6000 }],
  }))

  expect(windowOf(reads[0]).r0).toBeGreaterThan(2800)
  // The merge shows what its first cell holds, and is named by it.
  const merged = cell('C2000')
  expect(merged.textContent).toBe('Tall merge')
  expect(Math.round(merged.getBoundingClientRect().width)).toBe(200)
  expect(merged.getBoundingClientRect().bottom).toBeGreaterThan(cell('B3000').getBoundingClientRect().top)
  // The chart's place reaches into the window from the cell it is anchored in, above it.
  const chart = doc.querySelector('.chart')!.getBoundingClientRect()
  expect(chart.top).toBeLessThan(cell('B3000').getBoundingClientRect().top)
  expect(chart.bottom).toBeGreaterThan(cell('B3000').getBoundingClientRect().bottom)
})

it('leaves room in each window for the columns a sheet keeps in view', async () => {
  // Thirty narrow ones, which the view has room to keep.
  const narrow = Object.fromEntries(Array.from({ length: 30 }, (_column, n) => [n + 1, { size: 12 }]))
  const { doc, reads, without, cell, look } = await draw(bigBook({ frozenColumnCount: 30, columns: narrow }))
  const scroll = doc.getElementById('scroll')!

  scroll.scrollTo(40 * 100, 100 * 21)
  await expect.poll(() => cell('A101')?.textContent, { timeout: 10_000 }).toBe('row 101')
  expect(look(cell('A101')).position).toBe('sticky')
  expect(windowOf(reads.at(-1)!, 30).cells).toBeGreaterThan(windowOf(reads.at(-1)!).cells)
  for (const range of reads) expect(windowOf(range, 30).cells).toBeLessThanOrEqual(10_000)
  expect(without.flat()).toEqual([])
  expect(doc.getElementById('limit')!.hidden).toBe(true)
})

it('draws more frozen rows than there is room for as rows that scroll, says so, and still draws a change past them', async () => {
  // Ten frozen columns too, narrow enough to keep in view, as the first window shows.
  const narrow = Object.fromEntries(Array.from({ length: 10 }, (_column, n) => [n + 1, { size: 30 }]))
  const { doc, reads, without, cell, look } = await draw(bigBook({ frozenRowCount: 2000, frozenColumnCount: 10, columns: narrow }))
  const scroll = doc.getElementById('scroll')!.getBoundingClientRect()

  expect(doc.getElementById('error')).toBeNull()
  await expect.poll(() => doc.getElementById('limit')!.textContent).toBe(
    'This sheet freezes 2,000 rows. There is no room to keep them in view here, so they scroll with the rest.')
  expect(look(doc.getElementById('limit')!).display).toBe('block')
  // It opens on its change, read without the frozen rows, which the session would refuse as too many.
  expect(windowOf(reads[0]).r0).toBeGreaterThan(2000)
  expect(without[0]).toEqual(['rows'])
  expect(cell('B3000').classList.contains('new')).toBe(true)
  const [ring, written] = [doc.querySelector<HTMLElement>('.ring')!, cell('B3000')].map(mark => mark.getBoundingClientRect())
  await expect.poll(() => Math.round(doc.querySelector('.ring')!.getBoundingClientRect().top - cell('B3000').getBoundingClientRect().top)).toBe(-1)
  expect(ring.top).toBeGreaterThan(scroll.top)
  expect(written.bottom).toBeLessThan(scroll.bottom)
  // The frozen columns stay in view beside it.
  expect([look(cell('A3000')).position, look(cell('K3000')).position, look(cell('A3000')).left]).toEqual(['sticky', 'static', '46px'])
  // Scrolled back to, the first rows are drawn among the rest, and scroll.
  doc.getElementById('scroll')!.scrollTo(0, 0)
  await expect.poll(() => cell('A1')?.getBoundingClientRect().top, { timeout: 10_000 }).toBeGreaterThan(scroll.top)
  expect([look(cell('A1')).position, look(cell('A1')).top]).toEqual(['sticky', 'auto'])
  expect(without.at(-1)).toEqual([])
})

it('lets frozen columns that leave the view no room scroll, and keeps them in view once it is wide enough', async () => {
  const sheet = { ...SALES, columnCount: 12, frozenColumnCount: 4, columns: {} }
  const { doc, reads, cell, look } = await draw({ sheets: [sheet] }, 500)
  const limit = doc.getElementById('limit')!

  // Four columns of a hundred pixels are more than half of what the frame shows past the headers.
  expect(limit.textContent).toBe('This sheet freezes 4 columns. There is no room to keep them in view here, so they scroll with the rest.')
  expect([look(cell('A2')).position, look(cell('A1')).position]).toEqual(['static', 'sticky'])
  doc.getElementById('scroll')!.scrollTo(300, 0)
  await expect.poll(() => cell('A2').getBoundingClientRect().right).toBeLessThan(0)

  frame!.style.width = '1000px'
  await expect.poll(() => look(cell('A2')).position).toBe('sticky')
  expect(limit.hidden).toBe(true)
  expect(cell('A2').getBoundingClientRect().left - doc.getElementById('scroll')!.getBoundingClientRect().left).toBe(46)
  // What was read is drawn again: nothing is asked of the session.
  expect(reads).toHaveLength(1)
})

it('keeps frozen columns in view once the outline that opened beside the sheet closes and leaves them the room', async () => {
  const sheet = { ...SALES, columnCount: 12, frozenColumnCount: 4, columns: {} }
  const { doc, cell, look } = await draw({ sheets: [sheet, small(2, 'Costs', 1)] }, 1100)
  const limit = doc.getElementById('limit')!
  const toggle = doc.getElementById('outline-toggle')!

  // The outline is open in a frame this wide, and takes the room four columns of a hundred pixels need.
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  await expect.poll(() => limit.hidden).toBe(false)
  expect(look(cell('A2')).position).toBe('static')
  // Closing it resizes the view, though not the frame.
  toggle.click()
  await expect.poll(() => look(cell('A2')).position).toBe('sticky')
  expect(limit.hidden).toBe(true)
  toggle.click()
  await expect.poll(() => limit.hidden).toBe(false)
})

it('goes by the room there is with nothing said over the sheet, so that saying it lets them go does not keep frozen rows let go', async () => {
  // Eleven frozen rows of 21 pixels: kept in view where 462 pixels show past the headers.
  const sheet = { ...bigBook().sheets[0], touched: undefined, frozenRowCount: 11 }
  const { doc, cell, look } = await draw({ sheets: [sheet] }, 900, 400)
  const [limit, scroll] = [doc.getElementById('limit')!, doc.getElementById('scroll')!]
  await expect.poll(() => limit.hidden).toBe(false)
  expect(limit.offsetHeight).toBeGreaterThan(20)

  // Made tall enough for them by less than what is said takes of it.
  frame!.style.height = `${400 + 24 + 462 + 8 - scroll.clientHeight - limit.offsetHeight}px`
  await expect.poll(() => limit.hidden).toBe(true)
  expect(scroll.clientHeight - 24).toBeGreaterThanOrEqual(462)
  expect(look(cell('A2')).position).toBe('sticky')
})

it('keeps frozen columns it took for wider than they are, once it has read their widths', async () => {
  // Three of 40 pixels in a narrow frame, where three of the usual hundred would leave the view no room.
  const narrow = { 1: { size: 40 }, 2: { size: 40 }, 3: { size: 40 } }
  const book = bigBook({ frozenColumnCount: 3, columns: narrow, cells: { AX3000: { text: 'far', change: 2, entered: 'far' } } })
  book.pending!.Big.areas = [{ change: 2, op: 'writeCells', range: 'AX3000' }]
  const { doc, reads, without, cell, look } = await draw(book, 450)

  // It opens on its change, far to the right, with the frozen columns beside it.
  expect(cell('AX3000').textContent).toBe('far')
  expect([look(cell('A3000')).position, look(cell('C3000')).position]).toEqual(['sticky', 'sticky'])
  expect(cell('C3000').getBoundingClientRect().right).toBeLessThanOrEqual(cell('AX3000').getBoundingClientRect().left)
  await pause(300)
  expect([doc.getElementById('limit')!.hidden, without.flat(), reads.length]).toEqual([true, [], 1])
})

it('asks for a window past frozen columns it has let go of without them, and draws it without them', async () => {
  // Four of a hundred pixels, in a frame that shows 454 past the row headers.
  const book = bigBook({ frozenColumnCount: 4 })
  const { doc, reads, without, cell, look } = await draw(book, 500)
  const limit = doc.getElementById('limit')!

  // The first window comes with them, which is how their widths are read: the next is theirs to scroll.
  await expect.poll(() => limit.textContent).toBe('This sheet freezes 4 columns. There is no room to keep them in view here, so they scroll with the rest.')
  expect(without).toEqual([[], []])
  expect([look(cell('A3000')).position, look(cell('A1')).position]).toEqual(['static', 'sticky'])
  doc.getElementById('scroll')!.scrollTo(30 * 100, 2990 * 21)
  await expect.poll(() => cell('AE3000')?.getBoundingClientRect().left, { timeout: 10_000 }).toBe(doc.getElementById('scroll')!.getBoundingClientRect().left + 46)
  // Asked of the session: columns past the first, without the frozen ones, and with the frozen row.
  expect(without.at(-1)).toEqual(['columns'])
  expect(boundsOf(reads.at(-1)!).c0).toBeGreaterThan(4)
  // Drawn: no frozen column, the frozen row over the window's own columns, and the note still said.
  expect([cell('A3000'), cell('D1'), cell('AE1').textContent, look(cell('AE1')).position, look(cell('AE3000')).position])
    .toEqual([undefined, undefined, '', 'sticky', 'static'])
  expect(limit.hidden).toBe(false)
})

it('says that a freeze it has no room for waits to be applied, where a pending change makes it', async () => {
  const sheet = { ...SALES, columnCount: 12, frozenColumnCount: 4, columns: {}, touched: true as const }
  const { doc } = await draw({ sheets: [sheet], saved: [info({ ...sheet, frozenColumnCount: undefined })], pending: { Sales: {
    changes: [{ id: 3, type: 'updateSpreadsheet', changes: [{ op: 'freeze', sheet: 'Sales', columns: 4 }] }],
    areas: [{ change: 3, op: 'freeze', frozen: { axis: 'columns', before: 0, after: 4 }, range: 'A1:D12' }],
  } } }, 500)

  expect(doc.getElementById('limit')!.textContent).toBe(
    'With its pending changes, this sheet freezes 4 columns. There is no room to keep them in view here, so they scroll with the rest.')
})

it('says nothing of the frozen lines of a sheet whose windows hold them', async () => {
  const { doc } = await draw(bigBook({ frozenRowCount: 6 }))
  expect(doc.getElementById('limit')!.hidden).toBe(true)
})

it('draws again on a refresh, and says how many changes no longer fit', async () => {
  const book: Book = structuredClone(CHANGED)
  const { doc, cell, refresh } = await draw(book)
  expect(doc.getElementById('stale')!.hidden).toBe(true)

  book.sheets[0].cells!.A1 = { text: 'Area', change: 8, entered: 'Area', saved: 'Region' }
  book.pending!.Sales.changes = [...book.pending!.Sales.changes!, { id: 8, type: 'updateSpreadsheet', changes: [] },
    { id: 9, stale: true, type: 'updateSpreadsheet', changes: [] }]
  book.pending!.Sales.areas = [...book.pending!.Sales.areas!, { change: 8, op: 'writeCells', range: 'A1' }]
  refresh()

  await expect.poll(() => cell('A1').textContent).toBe('Area')
  expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe('6 changed places')
  expect(doc.getElementById('stale')!.title).toBe('1 change no longer fits this spreadsheet and is not shown.')
})

it('keeps saying a refresh failed as more of the sheet is read on, or cannot be', async () => {
  const book = bigBook()
  const { doc, reads, cell, refresh } = await draw(book)
  await expect.poll(() => cell('B3000')?.textContent).toBe('new')
  book.failChanges = () => 'Google Sheets did not answer.'
  refresh()
  const missed = doc.getElementById('missed')!
  const scroll = doc.getElementById('scroll')!
  const said = () => [missed.hidden, missed.textContent]
  await expect.poll(() => missed.hidden).toBe(false)

  // A read on that fails says nothing over it.
  book.failDrawing = () => 'Google Sheets did not answer.'
  const before = reads.length
  scroll.scrollTo(0, 100 * 21)
  await expect.poll(() => reads.length).toBeGreaterThan(before)
  await pause(300)
  expect(said()).toEqual([false, 'This sheet could not be updatedTry again'])

  // What is then read on is drawn with the changes listed before: the offer to try again stays.
  book.failDrawing = undefined
  await pause(1100)
  scroll.scrollTo(0, 200 * 21)
  await expect.poll(() => cell('A201')?.textContent, { timeout: 10_000 }).toBe('row 201')
  await pause(300)
  expect(said()).toEqual([false, 'This sheet could not be updatedTry again'])
})

it('says why a spreadsheet could not be read, and reads it again when asked', async () => {
  const book: Book = { sheets: [SALES], fail: 'Google Sheets did not answer.' }
  const { doc, cell } = await draw(book)

  const error = doc.getElementById('error')!
  expect(error.textContent).toBe('This spreadsheet could not be loadedGoogle Sheets did not answer.Try again')
  book.fail = undefined
  error.querySelector('button')!.click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Region')
  expect(doc.getElementById('error')).toBeNull()
})

it('stays on the sheet shown when its changes cannot be read, and leaves it only once it is gone', async () => {
  const book: Book = {
    sheets: [small(1, 'Sales', 0, { touched: true }), small(2, 'Costs', 1), small(9, 'Plan', 2, { touched: true })],
  }
  const { doc, asked, cell, tabs, refresh } = await draw(book, 1100)
  const title = () => doc.querySelector('#strip b')!.textContent
  tabs()[1].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Costs A1')

  // A read that fails while the sheet is still there is said, and no other sheet's changes are shown.
  book.failChanges = () => 'Google Sheets did not answer.'
  asked.length = 0
  refresh()
  await expect.poll(() => doc.getElementById('missed')?.hidden).toBe(false)
  expect(doc.getElementById('missed')!.textContent).toBe('This sheet could not be updatedTry again')
  expect(asked).toEqual(['Costs'])
  expect([title(), cell('A1').textContent]).toEqual(['Costs', 'Costs A1'])
  expect(doc.getElementById('error')).toBeNull()

  book.failChanges = undefined
  doc.querySelector<HTMLElement>('#missed button')!.click()
  await expect.poll(() => doc.getElementById('missed')!.hidden).toBe(true)
  expect(title()).toBe('Costs')

  // Renamed, it is followed to its new title.
  book.sheets[1] = small(2, 'Spend', 1)
  refresh()
  await expect.poll(title).toBe('Spend')
  expect(cell('A1').textContent).toBe('Spend A1')

  // Gone, it is left for the first sheet the changes touch, drawn as that sheet is.
  book.sheets.splice(1, 1)
  refresh()
  await expect.poll(title).toBe('Sales')
  await expect.poll(() => cell('A1')?.textContent).toBe('Sales A1')
  expect(tabs().map(tab => tab.getAttribute('aria-pressed'))).toContain('true')
})

it('stays on the sheet shown when a pending change renames it, and when another is given its title', async () => {
  const book: Book = { sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1), small(9, 'Plan', 2)] }
  const { doc, asked, cell, tabs, refresh } = await draw(book, 1100)
  const title = () => doc.querySelector('#strip b')!.textContent
  tabs()[1].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Costs A1')

  // Google still has it as Costs, so that title is still answered for.
  book.saved = book.sheets.map(info)
  book.sheets[1] = small(2, 'Spend', 1, { touched: true })
  asked.length = 0
  refresh()
  await expect.poll(title).toBe('Spend')
  expect(asked).toEqual(['Costs', 'Spend'])
  expect(cell('A1').textContent).toBe('Spend A1')
  // The title is the one the change gives it, and is marked as what a change writes is.
  const name = doc.querySelector<HTMLElement>('#strip b')!
  expect([name.className, name.title]).toEqual(['new', 'Renamed from “Costs” by a pending change'])

  book.sheets[1] = small(2, 'Archive', 1, { touched: true })
  book.sheets.push(small(10, 'Spend', 3, { touched: true }))
  refresh()
  await expect.poll(title).toBe('Archive')
  expect(tabs().map(tab => tab.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false'])
})

it('keeps the grid under the outline and clear of the buttons in a narrow pane', async () => {
  const { doc, look } = await draw({ ...CHANGED, sheets: [...CHANGED.sheets, { id: 2, title: 'Other', index: 1, rowCount: 3, columnCount: 3 }] }, 380)
  const strip = doc.getElementById('strip')!
  const nav = doc.getElementById('nav')!

  // The sheet's name ends before the navigator starts.
  expect(strip.querySelector('b')!.getBoundingClientRect().right).toBeLessThanOrEqual(nav.getBoundingClientRect().left)
  expect(look(strip.querySelector('.size')!).display).toBe('none')
  // The last rows scroll clear of the Workshop's card for a change waiting, which lies across the foot.
  expect(doc.defaultView!.getComputedStyle(doc.getElementById('scroll')!, '::after').height).toBe('120px')
  expect(look(doc.getElementById('missed')!).bottom).toBe('134px')
  // Nothing of the grid shows through the outline laid over it.
  doc.getElementById('outline-toggle')!.click()
  const outline = doc.getElementById('outline')!
  expect(outline.hidden).toBe(false)
  const { left, top } = outline.querySelector('.tab')!.getBoundingClientRect()
  // Once it has unfolded from its button.
  await expect.poll(() => outline.contains(doc.elementFromPoint(left + 20, top + 10))).toBe(true)
  expect(outline.contains(doc.elementFromPoint(100, 300))).toBe(true)
})

it('tells its host a sheet by the title Google has saved for it, and of no sheet that only a change adds', async () => {
  // A change renames the second sheet, and another adds a third.
  const book: Book = {
    saved: [small(1, 'Sales', 0), small(2, 'Costs', 1)].map(info),
    sheets: [small(1, 'Sales', 0), small(2, 'Expenses', 1, { touched: true }), small(9, 'Plan', 2, { touched: true })],
  }
  const { doc, said, go } = await draw(book, 1100, 600, '2')
  const title = () => doc.querySelector('#strip b')!.textContent

  expect([title(), said]).toEqual(['Expenses', [{ anchor: '2', label: 'Costs' }]])
  expect(await go('9')).toBe(true)
  expect([title(), said.at(-1)]).toEqual(['Plan', null])
})

it('tells its host the sheet shown, opens on the one its host names, and on its own choice when that is gone', async () => {
  const book: Book = { sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1), small(9, 'Plan', 2, { touched: true })] }
  const { doc, asked, said, go, cell, tabs } = await draw(book, 1100, 600, '2')
  const title = () => doc.querySelector('#strip b')!.textContent

  // The sheet its host names is the first read, not the one the changes touch.
  expect([title(), asked]).toEqual(['Costs', ['Costs']])
  expect(said).toEqual([{ anchor: '2', label: 'Costs' }])

  expect(await go('1')).toBe(true)
  expect([title(), cell('A1').textContent]).toEqual(['Sales', 'Sales A1'])
  expect(said.at(-1)).toEqual({ anchor: '1', label: 'Sales' })
  // The reader's own move is told too.
  tabs()[2].click()
  await expect.poll(() => said.at(-1)).toEqual({ anchor: '9', label: 'Plan' })
  // A sheet that is not there leaves the reader where they are.
  expect(await go('77')).toBe(false)
  expect(title()).toBe('Plan')
  frame!.remove()

  // Sent to a sheet that is gone, it opens where it would have: on the first the changes touch.
  const anew = await draw(book, 1100, 600, '77')
  expect(anew.doc.querySelector('#strip b')!.textContent).toBe('Plan')
  expect(anew.said).toEqual([{ anchor: '9', label: 'Plan' }])
  frame!.remove()

  // Sent to a sheet whose title another takes while it is read, it opens on the sheet of that ID.
  const swapped: Book = {
    sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1)],
    // Renamed once they are listed, as its changes are first read.
    failChanges: () => void Object.assign(swapped, { failChanges: undefined, sheets: [small(1, 'Costs', 0), small(2, 'Expenses', 1)] }),
  }
  const renamed = await draw(swapped, 1100, 600, '2')
  expect([renamed.doc.querySelector('#strip b')!.textContent, renamed.asked]).toEqual(['Expenses', ['Costs', 'Expenses']])
  expect(renamed.said).toEqual([{ anchor: '2', label: 'Expenses' }])
  frame!.remove()

  // Sent to a sheet that could not be read, it opens on that sheet when asked to read again.
  const failing: Book = { ...book, fail: 'Google Sheets did not answer.' }
  const retried = await draw(failing, 1100, 600, '2')
  failing.fail = undefined
  retried.doc.querySelector<HTMLElement>('#error button')!.click()
  await expect.poll(() => retried.doc.querySelector('#strip b')?.textContent).toBe('Costs')
})
