// The Google Sheets preview client, run in a same-origin frame with a scripted session so its
// drawing can be read. ConnectionPreviewPane's test runs a preview in the real sandbox, where it
// cannot.

import { afterEach, expect, it } from 'vitest'
import FONT_URL from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'
import { prepareUiPage } from '@gadgets/workshop-shared/ui-page'
import { SHEETS_PREVIEW_BUNDLE } from './sheetsPreviewBundle'

type Cell = Record<string, unknown>
type Line = { size?: number, hidden?: true, inserted?: true }
type Info = { id: number, title: string, index: number, rowCount: number, columnCount: number, hidden?: true, touched?: true }
type Sheet = Info & {
  frozenRowCount?: number
  frozenColumnCount?: number
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
}

const letters = (column: number): string =>
  column <= 26 ? String.fromCharCode(64 + column) : letters(Math.floor((column - 1) / 26)) + letters((column - 1) % 26 + 1)
const columnOf = (name: string) => [...name].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
/** The first and last row and column, from 1, of a range as the client asks for it, such as `'Sales'!A1:F12`. */
function boundsOf(range: string) {
  const [, c0, r0, c1, r1] = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)!
  return { r0: Number(r0), r1: Number(r1), c0: columnOf(c0), c1: columnOf(c1) }
}
const info = ({ id, title, index, rowCount, columnCount, hidden, touched }: Sheet): Info =>
  ({ id, title, index, rowCount, columnCount, ...(hidden ? { hidden } : {}), ...(touched ? { touched } : {}) })
/** A sheet as getPendingChanges() lists it after the changes: with the lines it keeps in view. */
const pendingInfo = (sheet: Sheet) => ({
  ...info(sheet),
  ...(sheet.frozenRowCount ? { frozenRowCount: sheet.frozenRowCount } : {}),
  ...(sheet.frozenColumnCount ? { frozenColumnCount: sheet.frozenColumnCount } : {}),
})

/** Lines `from` to `to` with the frozen ones before them, each `size` unless `held` says otherwise. */
const lines = (from: number, to: number, frozen: number, held: Record<number, Line> = {}, size: number) => [
  ...Array.from({ length: Math.min(frozen, from - 1) }, (_line, n) => n + 1),
  ...Array.from({ length: to - from + 1 }, (_line, n) => from + n),
].map(number => ({ number, size, ...held[number] }))

/** A window of `sheet` as readDrawing() returns it: its frozen lines, then the range's own. */
function drawingOf(sheet: Sheet, range: string) {
  const { r0, r1, c0, c1 } = boundsOf(range)
  const rows = lines(r0, r1, sheet.frozenRowCount ?? 0, sheet.rows, 21)
  const columns = lines(c0, c1, sheet.frozenColumnCount ?? 0, sheet.columns, 100)
  const { frozenRowCount, frozenColumnCount, gridlinesHidden, filter, charts } = sheet
  // The first cell of a merge comes apart when the window leaves it out.
  const drawn = new Set(rows.flatMap(row => columns.map(column => `${letters(column.number)}${row.number}`)))
  const anchors = Object.fromEntries((sheet.merges ?? []).map(merge => merge.split(':')[0])
    .filter(name => !drawn.has(name) && sheet.cells?.[name]).map(name => [name, sheet.cells![name]]))
  return {
    range,
    sheet: { ...info(sheet), frozenRowCount, frozenColumnCount, gridlinesHidden },
    rows,
    columns,
    cells: rows.map(row => columns.map(column => sheet.cells?.[`${letters(column.number)}${row.number}`] ?? null)),
    formats: sheet.formats ?? [],
    merges: sheet.merges ?? [],
    ...(Object.keys(anchors).length > 0 ? { anchors } : {}),
    filter,
    charts,
  }
}

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

/** Draws `book` in a frame `width` wide and resolves once its first sheet has cells. */
async function draw(book: Book, width = 900) {
  const reads: string[] = []
  const asked: string[] = []
  const fonts: [string, number, boolean][] = []
  const gadget = {
    // No font is served unless the book has one: the cells are drawn in what the browser has.
    readFont: async (...font: [string, number, boolean]) => {
      fonts.push(font)
      if (!book.font) throw new Error('readFont: Google Fonts does not serve this font.')
      return new Blob([await book.font]).stream()
    },
    getSpreadsheet: async () => ({ id: 'book', title: 'Book', sheets: book.sheets.map(info) }),
    getPendingChanges: async (title: string) => {
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
    readDrawing: async (range: string) => {
      reads.push(range)
      const failure = book.failDrawing?.(range)
      if (failure) throw new Error(failure)
      return drawingOf(book.sheets.find(sheet => range.startsWith(`'${sheet.title}'!`))!, range)
    },
  }
  Object.assign(window, { sheetsPreviewGadget: gadget })
  frame = document.body.appendChild(document.createElement('iframe'))
  Object.assign(frame.style, { width: `${width}px`, height: '600px' })
  // Started as the gadget UI frame starts it: main(gadget) on the module's default export.
  const { entryUrl, importMap } = prepareUiPage(SHEETS_PREVIEW_BUNDLE, '')
  frame.srcdoc = `<body><script type="importmap">${importMap}</script><script type="module">
    import client from ${JSON.stringify(entryUrl)}
    client.main(parent.sheetsPreviewGadget)
  </script>`
  const doc = () => frame!.contentDocument!
  await expect.poll(() => doc()?.querySelector('#error, #grid .c') !== null, { timeout: 10_000 }).toBe(true)
  const cells = () => [...doc().querySelectorAll<HTMLElement & { at: { row: number, column: number } }>('#grid .c')]
  return {
    doc: doc(),
    reads,
    /** The sheets whose pending changes were asked for, in order. */
    asked,
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
  expect(head.classList.contains('edge')).toBe(true)

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
  expect(cell('B7').classList.contains('drop')).toBe(true)
  expect(cell('B7').classList.contains('note')).toBe(true)
  expect(cell('B1').classList.contains('sift')).toBe(true)
  const chart = doc.querySelector<HTMLElement>('.chart')!
  expect(chart.textContent).toBe('Chart: Sales by regionNot drawn in this preview')
  expect(Math.round(chart.getBoundingClientRect().width)).toBe(180)
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
      B3: { text: '5', kind: 'number', format: 0, formatted: true },
      C3: { pending: true, kind: 'number', saved: '10' },
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
  expect(cell('C3').className).toBe('c num')
  // Formatting set by a change is drawn, and its cell marked.
  expect(look(cell('B3')).backgroundColor).toBe('rgb(255, 242, 204)')
  expect(cell('B3').classList.contains('styled')).toBe(true)

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

it('is a grid to a reader, whose changed cells are one stop for Tab and reached from it by the arrow keys', async () => {
  const { doc, cell, heads } = await draw(CHANGED)
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
  expect(stops()).toEqual([0, -1, -1, -1, -1])
  cell('A2').focus()
  press('ArrowRight')
  expect(doc.activeElement).toBe(cell('B2'))
  press('ArrowDown')
  expect(doc.activeElement).toBe(cell('B3'))
  press('Home')
  expect(doc.activeElement).toBe(cell('A2'))
  press('End')
  expect(doc.activeElement).toBe(cell('B3'))
  // Tab comes back to the cell the keyboard left.
  expect(stops()).toEqual([-1, -1, -1, -1, 0])
  expect(cell('B3').getAttribute('aria-describedby')).toBe('peek')
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
  cell('A1').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  expect(peek.hidden).toBe(true)

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

it('keeps the keyboard on the name of a sheet as it is opened', async () => {
  const { doc, cell, tabs } = await draw({ sheets: [small(1, 'Sales', 0), small(2, 'Costs', 1)] }, 1100)

  tabs()[1].focus()
  tabs()[1].click()
  await expect.poll(() => cell('A1')?.textContent).toBe('Costs A1')

  expect(doc.activeElement).toBe(tabs()[1])
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

it('starts a window too small for the view at the view\'s first row', async () => {
  const book = bigBook()
  book.failDrawing = range => windowOf(range).cells > 400
    ? 'The drawing of this range is too large to read at once. Request fewer cells.' : undefined
  const { doc, cell } = await draw(book)

  doc.getElementById('scroll')!.scrollTo(0, 0)
  // Row 1 is frozen: row 2 is the first the view holds.
  await expect.poll(() => cell('A2')?.textContent, { timeout: 10_000 }).toBe('row 2')
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
  const { doc, reads, cell } = await draw(bigBook({ frozenColumnCount: 30 }))
  const scroll = doc.getElementById('scroll')!

  scroll.scrollTo(40 * 100, 100 * 21)
  await expect.poll(() => cell('A101')?.textContent, { timeout: 10_000 }).toBe('row 101')
  for (const range of reads) expect(windowOf(range, 30).cells).toBeLessThanOrEqual(10_000)
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
  // Nothing of the grid shows through the outline laid over it.
  doc.getElementById('outline-toggle')!.click()
  const outline = doc.getElementById('outline')!
  expect(outline.hidden).toBe(false)
  const { left, top } = outline.querySelector('.tab')!.getBoundingClientRect()
  // Once it has unfolded from its button.
  await expect.poll(() => outline.contains(doc.elementFromPoint(left + 20, top + 10))).toBe(true)
  expect(outline.contains(doc.elementFromPoint(100, 300))).toBe(true)
})
