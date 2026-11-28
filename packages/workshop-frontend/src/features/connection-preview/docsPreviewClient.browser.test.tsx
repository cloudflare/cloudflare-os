// The Google Doc preview client, run in a same-origin frame with a scripted session so its drawing
// can be read. ConnectionPreviewPane's test runs it in the real sandbox, where it cannot.

import { afterEach, expect, it } from 'vitest'
import FONT_URL from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url'
import { prepareUiPage } from '@gadgets/workshop-shared/ui-page'
import { DOCS_PREVIEW_BUNDLE } from './docsPreviewBundle'
import { DRIVE_PREVIEW_BUNDLE } from './drivePreviewBundle'
import { previewHost } from './previewBundle'

type Edit = { start: number, end: number, blocks: object[] }
type Doc = {
  drawing?: object, edits?: Edit[], tabs?: string[], titles?: string[], changes?: object[]
  /** The lists the edits make or change, each level as far as the gatekeeper's copy tells it. */
  lists?: object
  /** What Google Docs names the document as saved, which the drawing and the edits are both of. */
  version?: string
  /** The tabs that have changes waiting. */
  edited?: string[]
}

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

// What ends every paragraph, so an empty one is a line high.
const text = (element: Element) => element.textContent!.replaceAll('⁠', '')

/** Whether `tabId` names a tab still to be added, as the gatekeeper names one. */
const unmade = (tabId: string) => tabId.startsWith('pending-tab-')

/**
 * Draws `doc` and resolves to the frame's document once the page has its blocks. What `session`
 * holds answers in place of the scripted session's own, and `at` is the spot its host sends it to.
 * `folder` makes of that session the one of a Drive connection, whose preview then opens the file.
 */
async function draw(
  doc: Doc, session: { [method: string]: (...given: never[]) => Promise<unknown> } = {}, at?: string,
  folder?: (file: object) => object,
) {
  // The session answers as GoogleDocSession does.
  const waiting = (tabId: string) => unmade(tabId) || !!doc.edited?.includes(tabId) || !doc.tabs && !!doc.edits?.length
  const listed = (tabId: string) => {
    if (!(doc.tabs ?? ['t.0']).includes(tabId)) throw new Error(`no tab with ID "${tabId}"`)
    return { tabId, ...!unmade(tabId) && { version: doc.version ?? 'v1' } }
  }
  // With several tabs, each reads as its own ID, and one with changes waiting has "Edited" put after that.
  const edits = (tabId: string) => !doc.tabs ? doc.edits ?? []
    : unmade(tabId) ? [{ start: 0, end: 0, blocks: [written(tabId)] }] : waiting(tabId) ? [edit(1, 1, [written('Edited')])] : []
  const fonts: [string, number, boolean][] = []
  const { host, said, held, go } = previewHost(at)
  const gadget = {
    // No font is served here: each is asked for, and the text is drawn without.
    readFont: async (...font: [string, number, boolean]) => {
      fonts.push(font)
      throw new Error('no such font')
    },
    listTabs: async () => (doc.tabs ?? ['t.0']).map((id, index) =>
      ({ id, title: doc.titles?.[index] ?? `Tab ${index + 1}`, index, nestingLevel: 0, ...waiting(id) && { pending: true } })),
    getPendingChanges: async (tabId: string) =>
      ({ tabId: listed(tabId).tabId, changes: doc.changes ?? (waiting(tabId) ? [{ id: 1, type: 'replaceText' }] : []) }),
    readPendingDrawing: async (tabId: string) => ({ ...listed(tabId), edits: edits(tabId), ...STATED, ...doc.lists && { lists: doc.lists } }),
    readDrawing: async (tabId: string) => {
      const { version } = listed(tabId)
      return unmade(tabId) ? BLANK : { ...doc.tabs ? drawing([paragraph(tabId)]) : doc.drawing ?? drawing([]), version }
    },
    readImage: async () => Promise.reject(new Error('no image')),
    ...session,
  }
  Object.assign(window, { docsPreviewGadget: folder?.(gadget) ?? gadget, docsPreviewHost: host })
  frame = document.body.appendChild(document.createElement('iframe'))
  Object.assign(frame.style, { width: '900px', height: '600px' })
  // Started as the gadget UI frame starts it: main(gadget, host) on the module's default export.
  const { entryUrl, importMap } = prepareUiPage(folder ? DRIVE_PREVIEW_BUNDLE : DOCS_PREVIEW_BUNDLE, '')
  frame.srcdoc = `<body><script type="importmap">${importMap}</script><script type="module">
    import client from ${JSON.stringify(entryUrl)}
    client.main(parent.docsPreviewGadget, parent.docsPreviewHost)
  </script>`
  const page = () => frame!.contentDocument?.getElementById('page')
  // The first drawing waits a moment for its fonts.
  await expect.poll(() => !!frame!.contentDocument?.getElementById('error') || page() && !page()!.hasAttribute('aria-busy'), { timeout: 5_000 }).toBe(true)
  const blocks = () => [...page()!.querySelectorAll<HTMLElement>('.col > *')]
  return {
    page: page()!,
    /** The fonts asked for, in order: family, weight and whether italic. */
    fonts,
    /** Each focus the host was told, and what sends the preview to a spot as its host does. */
    said,
    held,
    go,
    blocks,
    sheets: () => [...page()!.querySelectorAll<HTMLElement>('.sheet')],
    look: (element: Element) => frame!.contentWindow!.getComputedStyle(element),
    async refresh(next: Partial<Doc>) {
      Object.assign(doc, next)
      frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
    },
    /** Shows another copy of the tab, by the name on its button. */
    show(view: string) {
      const buttons = [...frame!.contentDocument!.querySelectorAll<HTMLElement>('.views button')]
      buttons.find(button => button.textContent === view)!.click()
    },
  }
}

const POINT = 4 / 3
const BLUE = 'rgb(74, 134, 232)'
const RED = 'rgb(136, 0, 0)'
const ARIAL = { fontFamily: 'Arial', fontSize: 11, weight: 400 }
// Places in the looks below.
const [NORMAL, TITLE, CODE, HEADING, LARGE] = [0, 1, 2, 3, 4]
// The named styles no test sets a paragraph in, which Google Docs sends all the same.
const OTHER_STYLES = {
  SUBTITLE: { fontSize: 15, color: '#666666' }, HEADING_2: { fontSize: 16 }, HEADING_3: { fontSize: 14, color: '#434343' },
  HEADING_4: { fontSize: 12, color: '#666666' }, HEADING_5: { color: '#666666' }, HEADING_6: { color: '#666666', italic: true },
}

/** Where block `index` of a drawing starts in the saved tab: each is ten indexes long. */
const startOf = (index: number) => 1 + index * 10

/** A tab's drawing: a small page with `blocks` on it, in a handful of looks. */
const drawing = (blocks: object[], more: object = {}) => ({
  page: { width: 600, height: 400 },
  sections: [{ margins: { top: 40, right: 50, bottom: 40, left: 50, header: 10, footer: 10 } }],
  blocks: blocks.map((block, index) => ({ ...block, range: { start: startOf(index), end: startOf(index + 1) } })),
  headers: {}, footers: {}, footnotes: {}, lists: {}, objects: {},
  paragraphLooks: [{ lineSpacing: 1 }, { lineSpacing: 1, alignment: 'center' }, { lineSpacing: 1 }, { lineSpacing: 1, spaceAbove: 20 }],
  textLooks: [
    ARIAL,
    { ...ARIAL, fontSize: 26, color: '#4a86e8' },
    { ...ARIAL, fontFamily: 'Consolas', color: '#880000' },
    { ...ARIAL, fontSize: 20, weight: 700 },
    { ...ARIAL, fontSize: 24 },
    ...Object.values(OTHER_STYLES).map(look => ({ ...ARIAL, ...look })),
  ],
  named: {
    NORMAL_TEXT: { paragraph: NORMAL, text: NORMAL },
    TITLE: { paragraph: TITLE, text: TITLE },
    HEADING_1: { paragraph: HEADING, text: HEADING },
    ...Object.fromEntries(Object.keys(OTHER_STYLES).map((name, at) => [name, { paragraph: HEADING, text: LARGE + 1 + at }])),
  },
  ...more,
})

type More = { look?: number, style?: string, [more: string]: unknown }

/** A paragraph of a drawing: its runs, or text in one look. */
const paragraph = (runs: string | object[], more: More = {}) => ({
  type: 'paragraph', style: 'NORMAL_TEXT', look: more.look ?? NORMAL, end: more.look ?? NORMAL,
  runs: typeof runs === 'string' ? [{ look: more.look ?? NORMAL, text: runs }] : runs,
  ...more,
})

/**
 * What the gatekeeper draws for a tab or a document still to be made: a blank page that names no
 * style, with its one empty paragraph in the look the gatekeeper falls back on.
 */
const BLANK = { ...drawing([paragraph('')]), named: {}, paragraphLooks: [{ lineSpacing: 1 }], textLooks: [ARIAL] }

const heading = (name: string, level = 1, more: More = {}) => paragraph(name, { style: `HEADING_${level}`, look: HEADING, ...more })

// What the blocks of an edit state of how they are set, as the gatekeeper's copy of the document
// keeps it: places in the pending drawing's own looks. A font is not among them.
const STATED = { paragraphLooks: [{}, { indentStart: 0, indentFirstLine: 0 }], textLooks: [{}, { color: '#880000' }, { bold: true }], lists: {} }
const [UNSTATED, DARK, BOLD] = [0, 1, 2]
// The paragraph look that states an indent of none, which is not one that states no indent.
const FLUSH = 1

/** A paragraph of an edit: its runs, or text that states no look. */
const written = (runs: string | object[], more: More = {}) => ({
  type: 'paragraph', style: 'NORMAL_TEXT', look: 0, end: UNSTATED,
  runs: typeof runs === 'string' ? [{ look: UNSTATED, text: runs }] : runs,
  ...more,
})

/** An edit that puts `blocks` in place of the blocks `from` up to `to` of a drawing, or before `from` where they are the same. */
const edit = (from: number, to: number, blocks: object[]): Edit => ({ start: startOf(from), end: startOf(to), blocks })

// A cell as Google Docs makes one: a 1pt line at each edge.
const EDGE = { width: 1, color: '#000000' }
const CELL = { padding: [5, 5, 5, 5], borders: { top: EDGE, right: EDGE, bottom: EDGE, left: EDGE } }
/**
 * A page taller than the frame the tests draw in. It is whole pixels tall: a page at a fraction
 * of one is stepped to a pixel either way, which the client allows for and a test's count does not.
 */
const TALL = { page: { width: 600, height: 810 } }

type Cell = { column: number, rowSpan?: number, columnSpan?: number, [more: string]: unknown }

/**
 * A table of `rows` of cells, each the words of one paragraph that `block` makes, or the cell
 * itself. A cell's column is its place in the grid, as Google Docs lists every place of it: the
 * places a merged cell reaches are passed over, in its row and in those under it. A cell given
 * at such a place is one that still holds text there, which the gatekeeper keeps.
 */
const table = (columns: number[], rows: (string | Cell)[][], block: (words: string) => object = paragraph) => {
  const reached = new Set<string>()
  const free = (row: number, column: number): number => reached.has(`${row} ${column}`) ? free(row, column + 1) : column
  return {
    type: 'table', columns,
    rows: rows.map((cells, row) => {
      let next = 0
      return { cells: cells.map(cell => {
        const made: Cell = typeof cell === 'string' ? { ...CELL, column: free(row, next), blocks: [block(cell)] } : cell
        for (let down = 0; down < (made.rowSpan ?? 1); down++) {
          for (let over = 0; over < (made.columnSpan ?? 1); over++) reached.add(`${row + down} ${made.column + over}`)
        }
        next = made.column + 1
        return made
      }) }
    }),
  }
}

const DRAWN = drawing([
  paragraph([{ text: 'Report', look: TITLE }], { style: 'TITLE', look: TITLE }),
  paragraph([{ text: 'plain ', look: NORMAL }, { text: 'code', look: CODE }, { text: ' plain', look: NORMAL }]),
  table([100, 300], [[
    { ...CELL, column: 0, background: '#d9ead3', blocks: [paragraph('Head', { look: TITLE })] },
    { ...CELL, column: 1, borders: { bottom: { width: 1, color: '#000000' } }, blocks: [paragraph('Body')] },
  ]]),
])

/** The run of `block` that reads `words`. */
const run = (block: Element, words: string) =>
  [...block.querySelectorAll('span, ins, del, a')].find(found => text(found).trim() === words)!

it('draws each paragraph, run and table cell as the tab\'s drawing sets it', async () => {
  const { blocks, look } = await draw({ drawing: DRAWN })
  const [title, body, grid] = blocks()

  expect(title.getAttribute('aria-level')).toBe('1')
  expect(title.style.textAlign).toBe('center')
  expect(look(run(title, 'Report')).color).toBe(BLUE)
  expect(parseFloat(look(run(title, 'Report')).fontSize)).toBeCloseTo(26 * POINT, 1)

  expect(look(run(body, 'code')).color).toBe(RED)
  expect(look(run(body, 'code')).fontFamily).toContain('Consolas')
  expect(text(body)).toBe('plain code plain')

  const [head, cell] = grid.querySelectorAll('td')
  expect(look(head).backgroundColor).toBe('rgb(217, 234, 211)')
  expect(look(head.firstElementChild!).textAlign).toBe('center')
  expect([look(cell).borderTopStyle, look(cell).borderBottomStyle]).toEqual(['none', 'solid'])
  expect([...grid.querySelectorAll('col')].map(column => column.style.width)).toEqual(['100pt', '300pt'])
})

it('sets text in a font whose name holds line breaks, which would leave its rule setting nothing', async () => {
  const set = drawing([paragraph('Words')], { textLooks: [{ ...ARIAL, fontSize: 20, fontFamily: 'Open\r\nSans\f' }] })
  const { blocks, look } = await draw({ drawing: set })
  const words = look(run(blocks()[0], 'Words'))

  expect(words.fontFamily).toContain('OpenSans')
  expect(parseFloat(words.fontSize)).toBeCloseTo(20 * POINT, 1)
})

it('sets a table, its rows and the paragraphs in them where Google Docs does', async () => {
  const edge = { width: 1, color: '#000000' }
  const cell = (column: number, block: object, padding = [0, 5.4, 0, 5.4]) =>
    ({ padding, borders: { top: edge, right: edge, bottom: edge, left: edge }, column, blocks: [block] })
  // As one brought in from Word is: wider than the 500pt column, with no padding over or under its text.
  const { blocks } = await draw({
    drawing: drawing([table([300, 220], [
      [cell(0, paragraph('Same', { look: TITLE, end: NORMAL })), cell(1, paragraph([]))],
      // Ending in spaces, and in an end larger than its text.
      [cell(0, paragraph([{ text: 'Same   ', look: TITLE }], { look: TITLE, end: LARGE })), cell(1, paragraph([]))],
      [cell(0, paragraph('Padded'), [5, 5, 5, 5]), cell(1, paragraph([]), [5, 5, 5, 5])],
    ])]),
  })
  const [grid] = blocks()
  const box = (element: Element) => element.getBoundingClientRect()
  const scale = box(grid).width / grid.offsetWidth

  // Its first cell's text starts where the column does: the table a border and a padding before it.
  expect((box(grid).left - box(grid.parentElement!).left) / scale).toBeCloseTo(-8, 1)
  const [first, spaced, padded] = [...grid.querySelectorAll('tr')]
  // The spaces a paragraph ends in do not move its text, and its end does not make its line taller.
  expect(box(run(spaced, 'Same')).left).toBeCloseTo(box(run(first, 'Same')).left, 1)
  expect(box(spaced).height).toBeCloseTo(box(first).height, 1)
  // A row is a whole number of pixels tall: a line of 18, 5pt over and under it, and a border.
  expect(box(padded).height / scale).toBeCloseTo(33, 1)
})

it('shows the tab as its changes leave it, as it is saved, or with each change marked in place', async () => {
  const { blocks, look, refresh, show } = await draw({ drawing: DRAWN })
  const views = frame!.contentDocument!.querySelector<HTMLElement>('.views')!
  // A tab with nothing pending has one copy.
  expect(views.hidden).toBe(true)

  // The paragraph with a word written over another, and a heading after it.
  await refresh({ edits: [edit(1, 2, [
    written([{ text: 'plainer ', look: UNSTATED }, { text: 'code', look: DARK }, { text: ' plain', look: UNSTATED }]),
    written('Added', { style: 'HEADING_1' }),
  ])] })
  await expect.poll(() => blocks().some(block => block.classList.contains('changed'))).toBe(true)
  expect(views.hidden).toBe(false)
  const changed = () => blocks().find(block => block.classList.contains('changed'))!

  // As it will be: what was removed takes no room, and is a mark where it was.
  expect(text(changed())).toBe('plainer code plain')
  expect(changed().querySelector('ins')!.textContent).toBe('plainer')
  expect(changed().querySelector('.tick')!.getAttribute('aria-label')).toBe('Removed here: “plain”')
  // A word the edit keeps stays in its run's look, though the edit does not state its font.
  expect(look(run(changed(), 'code')).color).toBe(RED)
  expect(look(run(changed(), 'code')).fontFamily).toContain('Consolas')
  // A new heading is set as its named style is, not as the paragraph it follows.
  const added = blocks().find(block => block.classList.contains('added'))!
  expect([text(added), added.getAttribute('aria-level')]).toEqual(['Added', '1'])
  expect(parseFloat(look(run(added, 'Added')).fontSize)).toBeCloseTo(20 * POINT, 1)
  expect(look(run(added, 'Added')).fontWeight).toBe('700')

  show('Inline')
  expect([changed().querySelector('del')!.textContent, changed().querySelector('ins')!.textContent]).toEqual(['plain', 'plainer'])
  expect(changed().querySelector('.tick')).toBeNull()

  show('As saved')
  expect(text(changed())).toBe('plain code plain')
  expect(changed().querySelector('.tick')!.getAttribute('aria-label')).toBe('Added here: “plainer”')
  // The heading still to be added is a mark between the blocks it will stand between.
  expect(blocks().map(block => block.className)).toContain('omit came')
  expect(blocks().some(block => block.classList.contains('added'))).toBe(false)
})

it('sets what a pending change writes as the saved paragraph it stands for, or the one before it', async () => {
  const spaced = drawing([paragraph([{ text: 'Spaced out code', look: CODE }], { look: 3, end: CODE }), paragraph('Plain')])
  const { blocks, look, show } = await draw({
    drawing: spaced,
    edits: [edit(0, 1, [written([{ text: 'Spaced out words', look: DARK }]), written([{ text: 'And more', look: DARK }])])],
  })
  const [edited, added, plain] = blocks()

  // Neither states its font or its spacing: the one is the paragraph it was, the other is written into it.
  expect([edited, added].map(block => block.className)).toEqual(['para changed', 'para added'])
  expect(look(run(edited, 'words')).fontFamily).toContain('Consolas')
  expect(look(run(added, 'And more')).fontFamily).toContain('Consolas')
  expect(added.offsetHeight).toBeGreaterThan(plain.offsetHeight)
  const tall = edited.offsetHeight
  show('As saved')
  expect(blocks()[0].offsetHeight).toBe(tall)
})

it('sets the words a pending change writes as the saved text beside them: raised, light, in small capitals', async () => {
  const { blocks, look } = await draw({
    drawing: drawing([
      paragraph([{ text: 'See ', look: 0 }, { text: 'note 42 here', look: 1 }]),
      paragraph('It is due today', { look: 2 }),
      paragraph('It is due today', { look: 3 }),
      paragraph([{ text: 'Total: 100', look: 0 }, { text: 'USD', look: 4 }]),
    ], {
      paragraphLooks: Array.from({ length: 5 }, () => ({ lineSpacing: 1 })),
      textLooks: [ARIAL, { ...ARIAL, baseline: 'super' }, { ...ARIAL, fontFamily: 'Roboto', weight: 300 }, { ...ARIAL, smallCaps: true },
        { ...ARIAL, fontFamily: 'Consolas', color: '#880000' }],
    }),
    edits: [edit(0, 4, [
      written('See note 43 here'),
      written([{ text: 'It is ready ', look: UNSTATED }, { text: 'now', look: BOLD }, { text: ' today', look: UNSTATED }]),
      written('It is ready today'),
      // The copy holds the runs as it cut them, which is not where the drawing does.
      written([{ text: 'Sum: ', look: UNSTATED }, { text: '100', look: UNSTATED }, { text: 'USD', look: DARK }]),
    ])],
  })
  const [raised, light, capitals, sum] = blocks()

  const [put, beside] = ['43', 'here'].map(words => look(run(raised, words)))
  expect([put.verticalAlign, put.fontSize]).toEqual(['super', beside.fontSize])
  // Bold of a family lighter than regular is a step up from its weight.
  expect(['ready', 'now', 'today'].map(words => look(run(light, words)).fontWeight)).toEqual(['300', '400', '300'])
  expect(['ready', 'today'].map(words => look(run(capitals, words)).fontVariantCaps)).toEqual(['small-caps', 'small-caps'])
  // A run that starts inside a word keeps its look to its own characters.
  expect(text(sum)).toBe('Sum: 100USD')
  expect([...sum.querySelectorAll('span, ins')].filter(found => text(found) && look(found).fontFamily.includes('Consolas')).map(text)).toEqual(['USD'])
})

it('sets the body on as many sheets as it fills, each under the header with its page\'s number', async () => {
  const lines = Array.from({ length: 40 }, (_, line) => `Line ${line}`)
  const header = paragraph([{ text: 'Page ', look: NORMAL }, { field: 'pageNumber', look: NORMAL }, { text: ' of ', look: NORMAL }, { field: 'pageCount', look: NORMAL }])
  const paged = drawing(lines.map(line => paragraph(line)), {
    sections: [{ margins: { top: 40, right: 50, bottom: 40, left: 50, header: 10, footer: 10 }, header: 'h', footer: 'f' }],
    headers: { h: [header] },
    footers: { f: [paragraph('Foot')] },
  })
  const { sheets, blocks } = await draw({ drawing: paged })

  expect(sheets().length).toBeGreaterThan(1)
  expect(sheets().map(sheet => text(sheet.querySelector('.head')!))).toEqual(
    sheets().map((_, index) => `Page ${index + 1} of ${sheets().length}`))
  // Every line is on one sheet, in order, inside the margins that sheet keeps.
  expect(blocks().map(text)).toEqual(lines)
  for (const sheet of sheets()) {
    const { top, bottom, height } = sheet.getBoundingClientRect()
    expect(height).toBeCloseTo(400 * POINT, 0)
    const body = [...sheet.querySelectorAll('.col > *')].map(block => block.getBoundingClientRect())
    expect(Math.min(...body.map(box => box.top))).toBeGreaterThanOrEqual(top + 40 * POINT - 1)
    expect(Math.max(...body.map(box => box.bottom))).toBeLessThanOrEqual(bottom - 40 * POINT + 1)
    const foot = sheet.querySelector('.foot')!.getBoundingClientRect()
    expect(foot.bottom).toBeCloseTo(bottom - 10 * POINT, 0)
  }
})

// Each was carried on from every page, without end.
const LONG = 'Long '.repeat(600).trim()
it.each([
  ['a row it repeats that is taller than a page', 2, [{ words: ['Head'], header: true, minHeight: 400 }, { words: ['One'] }, { words: ['Two'] }]],
  ['a paragraph kept whole that is taller than a page', 2, [{ words: [LONG] }, { words: ['After'] }]],
  ['one beside a cell that ends a page before it', 3, [{ words: ['Short', LONG] }, { words: ['After', 'All'] }]],
])('ends a table with %s, and draws each row once', async (_name, pages, rows) => {
  const grid = {
    type: 'table', columns: rows[0].words.map(() => 120),
    rows: rows.map(({ words, ...row }) => ({ ...row, cells: words.map((cell, column) => ({ ...CELL, column, blocks: [paragraph(cell)] })) })),
  }
  const { sheets, page } = await draw({
    drawing: drawing([grid], { paragraphLooks: Array.from({ length: 4 }, () => ({ lineSpacing: 1, keepLinesTogether: true })) }),
  })

  expect(sheets()).toHaveLength(pages)
  const cells = [...page.querySelectorAll('td')].map(cell => text(cell).replace(/\s+/g, ' ').trim())
  expect(cells.filter(Boolean)).toEqual(rows.flatMap(({ words }) => words))
})

it('sets each line as tall as Google Docs does in any font, with the larger space between two paragraphs', async () => {
  const lines = ['Body', 'Code', 'Large heading', 'Small heading', 'Body', 'Two\u000blines']
  const set = drawing(lines.map((line, index) => paragraph(line, { look: [0, 1, 2, 3, 0, 4][index] })), {
    paragraphLooks: [
      { lineSpacing: 1.15 }, { lineSpacing: 1.15 }, { lineSpacing: 1.15, spaceAbove: 24, spaceBelow: 6 },
      { lineSpacing: 1.15, spaceAbove: 14, spaceBelow: 4 }, { lineSpacing: 1.4, spaceAbove: 10 },
    ],
    textLooks: [ARIAL, { ...ARIAL, fontFamily: 'Consolas' }, { ...ARIAL, fontSize: 18, weight: 700 }, { ...ARIAL, fontSize: 12, weight: 700 }, ARIAL],
  })
  const { blocks } = await draw({ drawing: set })

  // As Google Docs draws them. A line is 1.18 of its size times its spacing, rounded up with the
  // space it carries: 11pt at 1.15 is 20px. The large heading gives the space under it up to the
  // larger one over the small heading, whose one line has the space over and under it; and of two
  // lines only the first has the space over them.
  expect(blocks().map(block => block.offsetHeight)).toEqual([20, 20, 65, 46, 20, 38 + 25])
})

it('ends no line at a hyphen inside a word, and copies the word as the document has it', async () => {
  // Wide enough that the line ends inside the last word or before it, in whatever font stands in.
  const words = `${'x '.repeat(36)}${'a'.repeat(20)}-${'b'.repeat(20)}`
  const { page, blocks } = await draw({ drawing: drawing([paragraph(words)]) })
  const [letters] = [...blocks()[0].querySelectorAll('span')].flatMap(span => [...span.childNodes]).filter(node => node.textContent!.includes('-'))
  const top = (character: string) => {
    const range = frame!.contentDocument!.createRange()
    const at = letters.textContent!.indexOf(character)
    range.setStart(letters, at)
    range.setEnd(letters, at + 1)
    return Math.round(range.getBoundingClientRect().top)
  }

  expect(top('b')).toBe(top('a'))
  expect(top('a')).toBeGreaterThan(top('x'))

  const view = frame!.contentWindow as Window & typeof globalThis
  view.getSelection()!.selectAllChildren(page)
  const copy = new view.ClipboardEvent('copy', { clipboardData: new view.DataTransfer(), bubbles: true, cancelable: true })
  page.dispatchEvent(copy)
  expect(copy.clipboardData!.getData('text/plain').trim()).toBe(words)
})

it('keeps the images of a paragraph a pending change edits, and wraps its text round one tethered to it', async () => {
  const pictured = drawing([paragraph([
    { text: 'Beside ', look: NORMAL }, { object: 'inline', look: NORMAL }, { text: ' the picture', look: NORMAL },
  ], { objects: ['tethered'] })], {
    objects: {
      tethered: { width: 100, height: 60, readable: true, placed: { left: 0, top: 0, layout: 'wrap' } },
      inline: { width: 20, height: 10, readable: true },
    },
  })
  const { blocks, look } = await draw({
    drawing: pictured,
    edits: [edit(0, 1, [written([
      { text: 'Beside ', look: UNSTATED }, { object: 'inline', look: UNSTATED }, { text: ' the photograph', look: UNSTATED },
    ], { objects: ['tethered'] })])],
  })
  const [edited] = blocks()

  expect(edited.classList.contains('changed')).toBe(true)
  expect([...edited.querySelectorAll<HTMLElement>('.obj')].map(box => box.dataset.object)).toEqual(['tethered', 'inline'])
  expect(text(edited)).toBe('Beside  the photograph')
  const [tethered] = edited.querySelectorAll('.obj')
  expect(look(tethered).float).toBe('left')
  // The text starts beside the image, not under it.
  const words = run(edited, 'Beside').getBoundingClientRect()
  expect(words.left).toBeGreaterThanOrEqual(tethered.getBoundingClientRect().right - 1)
  expect(words.top).toBeLessThan(tethered.getBoundingClientRect().bottom)
})

it('asks for the fonts the drawing is set in, each once, and none the browser has', async () => {
  const set = drawing([paragraph('Words')], {
    textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }, { ...ARIAL, fontFamily: 'Open Sans', weight: 700 }, ARIAL],
  })
  const { fonts } = await draw({ drawing: set })

  await expect.poll(() => fonts).toEqual([['Open Sans', 400, false], ['Open Sans', 700, false]])
})

it('asks for the faces a pending change writes in, of the font it is written beside', async () => {
  const set = drawing([paragraph('Words')], { textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }] })
  const [BOTH, ITALIC] = [1, 2]
  const { fonts } = await draw({ drawing: set }, {
    readPendingDrawing: async (tabId: string) => ({
      tabId, version: 'v1', ...STATED, textLooks: [{}, { bold: true, italic: true }, { italic: true }],
      edits: [edit(1, 1, [written([{ text: 'Both', look: BOTH }, { text: ' and ', look: UNSTATED }, { text: 'one', look: ITALIC }])])],
    }),
  })

  await expect.poll(() => fonts).toEqual([['Open Sans', 400, false], ['Open Sans', 700, true], ['Open Sans', 400, true]])
})

it('asks again, after a while, for a font that could not be read', async () => {
  const set = drawing([paragraph('Words')], { textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }] })
  const later: (() => void)[] = []
  let asked = 0
  const { refresh } = await draw({ drawing: set }, {
    readFont: async () => {
      asked++
      // The frame's wait of a minute is held, to be ended here.
      const { setTimeout: wait } = frame!.contentWindow!
      frame!.contentWindow!.setTimeout = ((run: () => void, ms?: number) =>
        ms === 60_000 ? later.push(run) : wait(run, ms)) as typeof setTimeout
      throw new Error('Google is busy')
    },
  })
  expect(asked).toBe(1)

  for (const run of later) run()
  await refresh({ edits: [edit(1, 1, [written('More')])] })
  await expect.poll(() => asked).toBe(2)

  // And on a refresh that finds the tab as it was.
  for (const run of later.splice(0)) run()
  await refresh({})
  await expect.poll(() => asked).toBe(3)
})

it('sets the text in a font that arrives after a later read has drawn it', async () => {
  const set = (text: string) => drawing([paragraph(text)], { textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }] })
  let arrive!: (bytes: ArrayBuffer) => void
  const { blocks, refresh } = await draw({ drawing: set('Words'), version: 'a' }, {
    readFont: () => new Promise<ArrayBuffer>(resolve => { arrive = resolve }).then(bytes => new Blob([bytes]).stream()),
  })
  await refresh({ drawing: set('Wide words'), version: 'b' })
  await expect.poll(() => text(blocks()[0])).toBe('Wide words')
  const width = () => run(blocks()[0], 'Wide words').getBoundingClientRect().width
  const before = width()

  arrive(await (await fetch(FONT_URL)).arrayBuffer())

  await expect.poll(width).not.toBe(before)
})

it('keeps what it says of a refresh that failed when a font arrives and the tab is set again', async () => {
  const set = drawing([paragraph('Words')], { textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }] })
  let arrive!: (bytes: ArrayBuffer) => void
  let reads = 0
  const { blocks } = await draw({ drawing: set }, {
    readFont: () => new Promise<ArrayBuffer>(resolve => { arrive = resolve }).then(bytes => new Blob([bytes]).stream()),
    readPendingDrawing: async (tabId: string) =>
      reads++ ? Promise.reject(new Error('Google is away')) : { tabId, version: 'v1', edits: [], ...STATED },
  })
  const missed = frame!.contentDocument!.getElementById('missed')!
  frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
  await expect.poll(() => missed.hidden).toBe(false)
  const width = () => run(blocks()[0], 'Words').getBoundingClientRect().width
  const before = width()

  arrive(await (await fetch(FONT_URL)).arrayBuffer())

  // Set in the font, the tab is still the one that could not be read again.
  await expect.poll(width).not.toBe(before)
  expect([missed.hidden, missed.textContent]).toEqual([false, 'This document could not be updatedTry again'])
})

it('keeps a tab\'s drawing until its edits are of the document saved anew', async () => {
  const set = (fontSize: number) => drawing([paragraph('Words')], { textLooks: [{ ...ARIAL, fontSize }] })
  const { blocks, look, refresh } = await draw({ drawing: set(11) })
  const size = () => parseFloat(look(run(blocks()[0], 'Words')).fontSize)

  // Google Docs is asked for the whole document for a drawing, so it is asked once for each saving.
  await refresh({ drawing: set(20), edits: [edit(1, 1, [written('More')])] })
  await expect.poll(() => blocks().length).toBe(2)
  expect(size()).toBeCloseTo(11 * POINT, 1)

  await refresh({ version: 'v2' })
  await expect.poll(size).toBeCloseTo(20 * POINT, 1)
})

it('asks for the edits again when they are of another saving than the drawing', async () => {
  const asked: string[] = []
  const saved = drawing([paragraph('One'), paragraph('Two')])
  const { blocks } = await draw({ drawing: saved }, {
    readDrawing: async () => ({ ...saved, version: 'b' }),
    // The copy the edits are made from learns of the saving from the read of the drawing.
    readPendingDrawing: async (tabId: string) => {
      const version = asked.push(tabId) > 1 ? 'b' : 'a'
      return { tabId, version, ...STATED, edits: version === 'a' ? [edit(0, 2, [written('Of the tab as it was')])] : [edit(2, 2, [written('Three')])] }
    },
    // Made again, an edit may no longer fit: the changes are listed again after it, too.
    getPendingChanges: async (tabId: string) =>
      ({ tabId, changes: [{ id: 1, type: 'replaceText', ...asked.length > 1 && { stale: true } }, { id: 2, type: 'appendText' }] }),
  })

  expect(blocks().map(text)).toEqual(['One', 'Two', 'Three'])
  expect(asked).toHaveLength(2)
  const stale = frame!.contentDocument!.getElementById('stale')!
  expect([stale.hidden, stale.textContent]).toEqual([false, '1 change no longer applies'])
})

it('keeps what is drawn while its edits stay of another saving than the drawing', async () => {
  let saves = 0
  const saved = drawing([paragraph('One'), paragraph('Two')])
  const { blocks } = await draw({ drawing: saved }, {
    // Once someone is typing, each read is of a later saving than the read before it, and a
    // paragraph has been put above the ones the edits count from.
    readDrawing: async () => saves ? { ...drawing([paragraph('Above'), paragraph('One'), paragraph('Two')]), version: `v${++saves}` } : { ...saved, version: 'a' },
    readPendingDrawing: async (tabId: string) =>
      ({ tabId, version: saves ? `v${++saves}` : 'a', ...STATED, edits: [edit(2, 2, [written('Three')])] }),
  })
  expect(blocks().map(text)).toEqual(['One', 'Two', 'Three'])

  saves = 1
  const missed = frame!.contentDocument!.getElementById('missed')!
  frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
  await expect.poll(() => missed.hidden).toBe(false)
  expect([missed.textContent, blocks().map(text)]).toEqual(['This document could not be updatedTry again', ['One', 'Two', 'Three']])
})

it('draws a tab that is itself pending from its one edit, in Google\'s own styles', async () => {
  const { blocks, look, show } = await draw({ tabs: ['pending-tab-1'] }, {
    readPendingDrawing: async (tabId: string) =>
      ({ tabId, ...STATED, edits: [{ start: 0, end: 0, blocks: [written('Report', { style: 'HEADING_1' }), written('Words')] }] }),
  })
  const [title, body] = blocks()

  // All it holds is added, and the blank page's own empty paragraph is no part of it.
  expect(blocks().map(block => [text(block), block.className])).toEqual([['Report', 'para added'], ['Words', 'para added']])
  expect(title.getAttribute('aria-level')).toBe('1')
  expect(parseFloat(look(run(title, 'Report')).fontSize)).toBeCloseTo(20 * POINT, 1)
  expect(parseFloat(look(run(body, 'Words')).fontSize)).toBeCloseTo(11 * POINT, 1)
  show('As saved')
  expect(blocks().map(block => block.className)).toEqual(['omit came'])
})

it('opens another tab at its top, wherever the reading was in the one left, and says nothing of where until it is read', async () => {
  const long = (name: string) => drawing(Array.from({ length: 80 }, (_, line) => paragraph(`${name} line ${line}`)))
  const { blocks, said } = await draw({ tabs: ['t.0', 't.1'], titles: ['Notes', 'Plan'] }, {
    readDrawing: async (tabId: string) => {
      // Long enough in the reading for the scroll back to the top to be heard.
      if (tabId === 't.1') await new Promise(done => setTimeout(done, 200))
      return { ...long(tabId), version: 'v1' }
    },
  })
  const scroller = frame!.contentDocument!.scrollingElement!
  scroller.scrollTop = 900
  expect(scroller.scrollTop).toBe(900)

  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => blocks()[0] && text(blocks()[0])).toBe('t.1 line 0')
  expect(scroller.scrollTop).toBe(0)
  // Nowhere, said of a tab still being read, would have its host forget the place it holds.
  await expect.poll(() => said.at(-1)).toEqual({ anchor: '?tab=t.1', label: 'Plan' })
  expect(said).not.toContain(null)
})

it('counts no change of the tab left as no longer fitting once another is opened, though that one cannot be read', async () => {
  await draw({ tabs: ['t.0', 't.1'] }, {
    getPendingChanges: async (tabId: string) => ({ tabId, changes: [{ id: 1, stale: true, type: 'replaceText' }] }),
    readPendingDrawing: async (tabId: string) =>
      tabId === 't.1' ? Promise.reject(new Error('Google is away')) : { tabId, version: 'v1', edits: [], ...STATED },
  })
  const doc = frame!.contentDocument!
  const stale = doc.getElementById('stale')!
  expect(stale.hidden).toBe(false)

  doc.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => doc.getElementById('error')).not.toBeNull()
  expect(stale.hidden).toBe(true)
})

it('offers no step to a change of the tab left while another is being read', async () => {
  await draw({ tabs: ['t.0', 't.1'] }, {
    readPendingDrawing: (tabId: string) => tabId === 't.1' ? new Promise(() => {})
      : Promise.resolve({ tabId, version: 'v1', ...STATED, edits: [edit(1, 1, [written('Edited')])] }),
  })
  const doc = frame!.contentDocument!
  const nav = doc.getElementById('nav')!
  expect(nav.hidden).toBe(false)

  doc.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  expect(nav.hidden).toBe(true)
})

it('keeps the tab as it is drawn when it cannot be read again, and says so at its foot', async () => {
  let reads = 0
  const { blocks } = await draw({ drawing: drawing([paragraph('Words')]) }, {
    readPendingDrawing: async (tabId: string) =>
      reads++ === 1 ? Promise.reject(new Error('Google is away')) : { tabId, version: 'v1', edits: [], ...STATED },
  })
  const refresh = () => frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
  const missed = frame!.contentDocument!.getElementById('missed')!
  expect(missed.hidden).toBe(true)
  refresh()
  await expect.poll(() => missed.hidden).toBe(false)
  expect(missed.textContent).toBe('This document could not be updatedTry again')
  expect([frame!.contentDocument!.getElementById('error'), frame!.contentDocument!.getElementById('page')!.hidden, blocks().map(text)])
    .toEqual([null, false, ['Words']])

  // A refresh that is read takes it away, though it finds the tab as it is drawn.
  refresh()
  await expect.poll(() => missed.hidden).toBe(true)
  expect(blocks().map(text)).toEqual(['Words'])
})

it('draws an empty paragraph as high as a line of text, and a line break a paragraph holds', async () => {
  const { blocks } = await draw({ drawing: drawing(['', 'First', '', 'one\u000b', 'two'].map(line => paragraph(line))) })
  const heights = blocks().map(block => Math.round(block.getBoundingClientRect().height))

  expect(new Set(heights.slice(0, 3)).size).toBe(1)
  // The break that ends a paragraph leaves a line under it.
  expect(heights[3]).toBeGreaterThan(heights[4] * 1.5)
})

it('leaves out a paragraph that is removed where the changes are shown made, and marks where it was', async () => {
  const { blocks, show } = await draw({
    drawing: drawing([paragraph('First'), paragraph('Going'), paragraph('Last')]),
    edits: [edit(1, 2, [])],
  })
  expect(blocks().map(block => [text(block), block.className, block.title])).toEqual(
    [['First', 'para', ''], ['', 'omit gone', 'Removed here: “Going”'], ['Last', 'para', '']])

  show('As saved')
  expect(blocks().map(block => [text(block), block.className])).toEqual([['First', 'para'], ['Going', 'para removed'], ['Last', 'para']])
})

it('marks what was put in beside a word, not the word', async () => {
  const { blocks } = await draw({
    drawing: drawing([paragraph('Open to all users today.')]),
    edits: [edit(0, 1, [written('Open to all users, and every embedder, today.')])],
  })
  const [changed] = blocks()

  expect(changed.querySelector('.tick')).toBeNull()
  expect([...changed.querySelectorAll('ins')].map(node => node.textContent).join('')).toBe(', and every embedder,')
  // It only adds, and is told in the color of what is added.
  expect(changed.dataset.does).toBe('added')
})

it('starts a new sheet at a page break the tab has, in each copy that is set on pages', async () => {
  const broken = drawing([paragraph('Before'), paragraph([{ break: 'page', look: NORMAL }]), paragraph('After')])
  const { sheets, refresh, show } = await draw({ drawing: broken })
  const pages = () => sheets().map(sheet => text(sheet.querySelector('.area')!))
  expect(pages()).toEqual(['Before', 'After'])
  // A paragraph that ends in its page break leaves no line of itself on the next sheet.
  expect(sheets()[1].querySelectorAll('.col > *')).toHaveLength(1)

  await refresh({ edits: [edit(3, 3, [written('Last')])] })
  await expect.poll(pages).toEqual(['Before', 'AfterLast'])
  // As saved, the tab ends where it did.
  show('As saved')
  expect(pages()).toEqual(['Before', 'After'])
  // With each change in place there is one sheet, as long as the tab.
  show('Inline')
  expect(sheets()).toHaveLength(1)
  expect(sheets()[0].querySelectorAll('.pagebreak')).toHaveLength(1)
})

it('starts a new sheet after a paragraph that ends in a page break, however many sheets it is on', async () => {
  const { sheets } = await draw({
    drawing: drawing([paragraph([{ text: 'Word '.repeat(2500), look: NORMAL }, { break: 'page', look: NORMAL }]), paragraph('After')]),
  })
  expect(sheets().length).toBeGreaterThan(2)
  expect(text(sheets().at(-1)!.querySelector('.area')!)).toBe('After')
})

it('steps from page to page with a navigator at the foot of the frame, where there are pages', async () => {
  const end = paragraph([{ break: 'page', look: NORMAL }])
  // Each page taller than the frame, so that any of them can come to its head.
  const { sheets, refresh, show } = await draw({ drawing: drawing([paragraph('One'), end, paragraph('Two'), end, paragraph('Three')], TALL) })
  const pager = frame!.contentDocument!.getElementById('pager')!
  const [previous, next] = [...pager.querySelectorAll('button')]
  const reading = () => pager.getAttribute('aria-label')
  const top = (sheet: number) => Math.round(sheets()[sheet].getBoundingClientRect().top)

  expect(pager.hidden).toBe(false)
  // What the pill shows, and what it is called.
  expect(pager.textContent).toBe('Page1 / 3')
  expect(reading()).toBe('Page 1 of 3')
  expect([previous.disabled, next.disabled]).toEqual([true, false])
  // Once the sheets have settled where they arrive.
  await expect.poll(() => top(0)).toBe(52)

  // Two steps go two pages on, though the first is still under way.
  next.click()
  next.click()
  await expect.poll(reading).toBe('Page 3 of 3')
  expect(pager.querySelector('.count')!.textContent).toBe('3 / 3')
  // The page stepped to is at the head of the frame, clear of the controls there.
  await expect.poll(() => top(2)).toBe(52)
  expect([previous.disabled, next.disabled]).toEqual([false, true])
  previous.click()
  await expect.poll(reading).toBe('Page 2 of 3')
  await expect.poll(() => top(1)).toBe(52)

  // Read change by change the tab is one sheet, which has no pages to step through.
  await refresh({ edits: [edit(5, 5, [written('More')])] })
  await expect.poll(() => sheets()[2]?.textContent).toContain('More')
  show('Inline')
  expect(pager.hidden).toBe(true)
  show('With changes')
  expect(pager.hidden).toBe(false)
})

it('lists the tabs again on a refresh, and leaves a tab that has gone for the first', async () => {
  const { page, refresh } = await draw({ tabs: ['t.0', 'pending-tab-1'] })
  const buttons = () => [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')]
  // The tab still to be added is marked as new.
  expect(buttons().map(button => [button.title, getComputedStyle(button, '::after').content])).toEqual(
    [['Tab 1', 'none'], ['Tab 2 (new, not yet added)', '"New"']])
  buttons()[1].click()
  await expect.poll(() => text(page)).toBe('pending-tab-1')
  // All it holds is still to come.
  expect([...page.querySelectorAll('.col > *')].map(block => block.className)).toEqual(['para added'])

  // The tab's add was discarded.
  await refresh({ tabs: ['t.0'] })

  await expect.poll(() => text(page)).toBe('t.0')
  expect(buttons()).toHaveLength(0)
  expect(frame!.contentDocument!.getElementById('error')).toBeNull()
})

it('stays on an added tab once Google has it, though another tab has its title', async () => {
  const titles = ['Notes', 'Notes']
  const { page, refresh } = await draw({ tabs: ['t.0', 'pending-tab-1'], titles })
  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => text(page)).toBe('pending-tab-1')

  await refresh({ tabs: ['t.0', 't.1'], titles })

  await expect.poll(() => text(page)).toBe('t.1')
})

// A document of headings: `filler` lines under the first, then a second-level heading and its text.
const outlined = (filler: number) => drawing([
  heading('Intro', 1, { headingId: 'h.intro' }), ...Array.from({ length: filler }, (_, line) => paragraph(`Line ${line}`)),
  heading('Details', 2), paragraph('Old text'), heading('Last', 1, { headingId: 'h.last' }), paragraph('End'),
], TALL)

it('lists the headings in an outline, marks a section that holds a change, and scrolls to one', async () => {
  const { page } = await draw({ drawing: outlined(55), edits: [edit(57, 58, [written('New text')])] })
  const outline = frame!.contentDocument!.getElementById('outline')!
  const entries = () => [...outline.querySelectorAll<HTMLElement>('#rail .entry')]

  // The frame is too narrow for the outline to stand beside the page, so it starts closed.
  expect(outline.hidden).toBe(true)
  const toggle = frame!.contentDocument!.getElementById('outline-toggle')!
  toggle.click()

  expect(entries().map(entry => entry.textContent)).toEqual(['Intro', 'Details', 'Last'])
  expect(entries().map(entry => entry.title)).toEqual(['Intro', 'Details (has pending edits)', 'Last'])
  expect(entries().map(entry => entry.parentElement!.style.paddingLeft)).toEqual(['0px', '12px', '0px'])

  entries()[1].focus()
  entries()[1].click()
  const details = page.querySelector('[aria-level="2"]')!
  // Clear of the controls that float over the top of the page.
  await expect.poll(() => Math.round(details.getBoundingClientRect().top)).toBeLessThan(60)
  expect(outline.hidden).toBe(true)
  // Closed over the heading that had the keyboard, it hands it to what opens it.
  expect(frame!.contentDocument!.activeElement).toBe(toggle)
})

it('keeps the keyboard on a heading of the outline while the tab is read again', async () => {
  const { refresh } = await draw({ drawing: drawing([heading('Intro'), paragraph('Text'), heading('Schedule'), paragraph('More')]) })
  const doc = frame!.contentDocument!
  doc.getElementById('outline-toggle')!.click()
  const schedule = () => doc.querySelectorAll<HTMLElement>('#rail .entry')[1]
  const was = schedule()
  was.focus()

  await refresh({})
  await expect.poll(schedule).not.toBe(was)
  expect([doc.activeElement, schedule().textContent]).toEqual([schedule(), 'Schedule'])
})

it('colors the dot on a section by what its changes do, in every copy of the tab', async () => {
  const saved = ['# Grow', 'Kept', '# Shrink', 'Going', '# Edit', 'Old words', '# Mixed', 'Stays', 'Leaving', '# Words', 'One two three', '# Plain', 'Same']
  const { show } = await draw({
    drawing: drawing(saved.map(line => line.startsWith('# ') ? heading(line.slice(2)) : paragraph(line))),
    edits: [
      edit(2, 2, [written('Arrived')]), edit(3, 4, []), edit(5, 6, [written('New words')]),
      edit(7, 7, [written('Arriving')]), edit(8, 9, []), edit(10, 11, [written('One three')]),
    ],
  })
  const doc = frame!.contentDocument!
  doc.getElementById('outline-toggle')!.click()
  const entries = () => [...doc.querySelectorAll<HTMLElement>('#rail .entry')]
  // Added alone, removed alone, words both gone and come, paragraphs both, words removed alone.
  const kinds = ['added', 'removed', 'changed', 'changed', 'removed', undefined]

  expect(entries().map(entry => entry.dataset.touched)).toEqual(kinds)
  // Color is not all that says it.
  expect(entries().map(entry => entry.title)).toEqual([
    'Grow (has pending additions)', 'Shrink (has pending deletions)', 'Edit (has pending edits)',
    'Mixed (has pending edits)', 'Words (has pending deletions)', 'Plain',
  ])
  const dots = entries().map(entry => getComputedStyle(entry, '::after').backgroundColor)
  expect(new Set(dots.slice(0, 3)).size).toBe(3)
  expect(dots[3]).toBe(dots[2])
  expect(dots[4]).toBe(dots[1])

  for (const view of ['Inline', 'As saved']) {
    show(view)
    expect(entries().map(entry => entry.dataset.touched)).toEqual(kinds)
  }
})

it('folds a heading\'s own headings away from its arrow, and still goes to it from its name', async () => {
  const { page } = await draw({ drawing: outlined(60), edits: [edit(62, 63, [written('New text')])] })
  const outline = frame!.contentDocument!.getElementById('outline')!
  const rows = () => [...outline.querySelectorAll<HTMLElement>('#rail .row')]
  const arrows = () => rows().map(row => row.querySelector<HTMLElement>('.fold'))

  // Only a heading with headings under it has an arrow.
  expect(arrows().map(arrow => arrow?.getAttribute('aria-expanded'))).toEqual(['true', undefined, undefined])
  const scrolled = () => page.ownerDocument.scrollingElement!.scrollTop
  const before = scrolled()
  // The frame is too narrow for the outline to stand open, and nothing hidden holds the keyboard.
  if (outline.hidden) frame!.contentDocument!.getElementById('outline-toggle')!.click()
  arrows()[0]!.click()

  expect(rows().map(row => row.hidden)).toEqual([false, true, false])
  expect(arrows()[0]!.getAttribute('aria-expanded')).toBe('false')
  // The outline is drawn again, and the keyboard stays on the arrow that took its place.
  expect(frame!.contentDocument!.activeElement).toBe(arrows()[0])
  // The change under the folded heading shows on it.
  expect(rows()[0].querySelector<HTMLElement>('.entry')!.dataset.touched).toBe('changed')
  // Folding goes nowhere.
  expect(scrolled()).toBe(before)

  rows()[2].querySelector<HTMLElement>('.entry')!.click()
  const last = page.querySelectorAll('[aria-level="1"]')[1]
  await expect.poll(() => Math.round(last.getBoundingClientRect().top)).toBeLessThan(400)
  arrows()[0]!.click()
  expect(rows().map(row => row.hidden)).toEqual([false, false, false])
})

it('follows a link to a heading of the document, and makes one to the web a link to a new tab', async () => {
  const leading = (words: string, to: string) => ({ text: words, look: NORMAL, link: to })
  const between = { text: ' or ', look: NORMAL }
  const links = paragraph([
    leading('the end', '#heading=h.last'), between, leading('the web', 'https://example.com/'), between,
    leading('a mark', '?tab=t.0#bookmark=id.x'), between, leading('a slip', '#heading=%'),
  ])
  const set = outlined(55)
  const { page, look } = await draw({ drawing: drawing([set.blocks[0], links, ...set.blocks.slice(1)], TALL) })
  const [inside, outside, bookmark, slip] = [...page.querySelectorAll<HTMLElement>('.link')]
  const last = page.querySelectorAll('[aria-level="1"]')[1]
  const top = () => Math.round(last.getBoundingClientRect().top)
  const far = top()

  expect([inside, outside, bookmark, slip].map(link => [link.title, look(link).cursor])).toEqual([
    ['Go to “Last”', 'pointer'],
    ['https://example.com/', 'pointer'],
    ['A bookmark in this document, which the preview cannot find', 'text'],
    ['A heading the preview cannot find', 'text'],
  ])
  // The frame lets nothing but a link element open a browser tab, so only the web link is one.
  expect([inside, outside, bookmark, slip].map(link => ['href', 'target', 'rel'].map(name => link.getAttribute(name))))
    .toEqual([[null, null, null], ['https://example.com/', '_blank', 'noopener noreferrer'], [null, null, null], [null, null, null]])
  bookmark.click()
  expect(top()).toBe(far)

  // A link followed in place is in reach of the keyboard, as the web link is by its address.
  expect([inside, bookmark].map(link => ['tabindex', 'role'].map(name => link.getAttribute(name)))).toEqual([['0', 'link'], [null, null]])
  inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  // The heading is near the foot of the last sheet, which scrolls no further.
  await expect.poll(top).toBeLessThan(400)
})

it('opens and closes an outline nobody chose as the frame gains and loses the room for it', async () => {
  await draw({ drawing: drawing([heading('Intro'), paragraph('Text')]) })
  const outline = frame!.contentDocument!.getElementById('outline')!
  expect(outline.hidden).toBe(true)

  frame!.style.width = '1200px'
  await expect.poll(() => outline.hidden).toBe(false)
  frame!.style.width = '900px'
  await expect.poll(() => outline.hidden).toBe(true)
  // Folding away, it is already out of the keyboard's reach.
  expect(outline.inert).toBe(true)

  // One the person opened stays as they left it.
  frame!.contentDocument!.getElementById('outline-toggle')!.click()
  frame!.style.width = '1200px'
  frame!.style.width = '900px'
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(outline.hidden).toBe(false)
})

it('makes no link of a web address that is in a pending change', async () => {
  const link = (words: string, to: string) => ({ text: words, look: UNSTATED, link: `https://example.com/${to}` })
  const linked = paragraph([{ text: 'See ', look: NORMAL }, { text: 'the saved page', look: NORMAL, link: 'https://example.com/saved' }])
  const { page, look } = await draw({
    drawing: drawing([linked, paragraph('Old text')]),
    edits: [edit(1, 2, [
      written([{ text: 'Old ', look: UNSTATED }, link('text', 'word')]),
      written([{ text: 'And ', look: UNSTATED }, link('a new one', 'added')]),
    ])],
  })
  const links = [...page.querySelectorAll<HTMLElement>('.link')]
  expect(links.map(found => found.title)).toEqual([
    'https://example.com/saved',
    'Not opened while its change is pending: https://example.com/word',
    'Not opened while its change is pending: https://example.com/added',
  ])

  expect(links.map(found => found.getAttribute('href'))).toEqual(['https://example.com/saved', null, null])
  expect(links.map(found => look(found).cursor)).toEqual(['pointer', 'text', 'text'])
})

/** The links of `root` as what each says and where a click on it leads, which is nowhere for one that is held. */
const leads = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.link')].map(link => [text(link), link.getAttribute('href')])

it('follows, in a paragraph a change edits, only the links of its saved words that the change leaves alone', async () => {
  const to = (name: string) => `https://example.com/${name}`
  const saved = paragraph([{ text: 'Read ', look: NORMAL }, { text: 'the guide', look: NORMAL, link: to('guide') }, { text: ' and the notes', look: NORMAL }])
  const { page, show } = await draw({
    drawing: drawing([saved]),
    edits: [edit(0, 1, [written([
      { text: 'Read ', look: UNSTATED }, { text: 'the guide', look: UNSTATED, link: to('guide') }, { text: ' and the ', look: UNSTATED },
      { text: 'new', look: UNSTATED, link: to('new') }, { text: ' ', look: UNSTATED }, { text: 'notes', look: UNSTATED, link: to('notes') },
    ])])],
  })

  for (const view of ['With changes', 'Inline']) {
    show(view)
    expect(leads(page).filter(([, href]) => href)).toEqual([['the guide', to('guide')]])
    // A word that was there and leads somewhere new is held as the word that came is.
    expect(leads(page).filter(([, href]) => !href).map(([words]) => words)).toEqual(['new', 'notes'])
    expect([...page.querySelectorAll('[href]')].map(link => link.getAttribute('href'))).toEqual([to('guide')])
  }
  expect(page.querySelector<HTMLElement>('ins.link')!.title).toBe(`Not opened while its change is pending: ${to('new')}`)
})

it('follows no link of a cell a change makes where a merged cell was, and tints what it holds as added', async () => {
  const to = (name: string) => `https://example.com/${name}`
  const cell = (column: number, block: object, more = {}) => ({ ...CELL, column, blocks: [block], ...more })
  const merged = table([100, 100], [
    [cell(0, paragraph('Head'), { columnSpan: 2 })],
    [cell(0, paragraph([{ text: 'kept', look: NORMAL, link: to('saved') }])), 'b'],
  ])
  // The cells are split, and the one that comes holds a link.
  const split = table([100, 100], [
    ['Head', cell(1, written([{ text: 'click', look: UNSTATED, link: to('pending') }]))],
    [cell(0, written([{ text: 'kept', look: UNSTATED, link: to('saved') }])), 'b'],
  ], written)
  const { page, show } = await draw({ drawing: drawing([merged]), edits: [edit(0, 1, [split])] })

  for (const view of ['With changes', 'Inline']) {
    show(view)
    expect(leads(page)).toEqual([['click', null], ['kept', to('saved')]])
    expect([...page.querySelectorAll('[href]')].map(link => link.getAttribute('href'))).toEqual([to('saved')])
    const held = page.querySelector<HTMLAnchorElement>('.link')!
    expect([held.title, held.target]).toEqual([`Not opened while its change is pending: ${to('pending')}`, ''])
    expect([held.closest('.para')!.className, held.closest('td')!.className]).toEqual(['para added', 'changed'])
  }
  // The table saved has neither the cell nor its link.
  show('As saved')
  expect(leads(page)).toEqual([['kept', to('saved')]])
})

it('starts a table whose unsized columns fill the column where the column starts', async () => {
  // Seven shares of 500pt sum to a hair over it.
  const { blocks } = await draw({ drawing: drawing([table(Array.from({ length: 7 }, () => 0), [Array.from({ length: 7 }, () => 'Cell')])]) })

  const [grid] = blocks()
  expect(grid.getBoundingClientRect().left).toBeCloseTo(grid.parentElement!.getBoundingClientRect().left, 1)
})

it('shares what a table\'s sized columns leave among those Google Docs gives no width', async () => {
  // As a table whose columns are spread evenly is drawn: one column sized, and two of no width.
  const spread = table([90, 0, 0], [['Sized', 'Even', 'Even']])
  const { blocks, show } = await draw({ drawing: drawing([spread]), edits: [edit(0, 1, [table([90, 0, 0], [['Sized', 'Even', 'Odd']], written)])] })
  const widths = () => [...blocks()[0].querySelectorAll('col')].map(column => column.style.width)

  // The text column is 500pt wide. A table its changes edit is sized the same way.
  expect(widths()).toEqual(['90pt', '205pt', '205pt'])
  show('As saved')
  expect(widths()).toEqual(['90pt', '205pt', '205pt'])
})

it('gives a paragraph of raised text alone the line its size makes', async () => {
  const raised = { ...ARIAL, baseline: 'super' }
  const { blocks } = await draw({
    drawing: drawing([paragraph([{ text: '2', look: 1 }]), paragraph('plain'), paragraph('plain')], { textLooks: [ARIAL, raised] }),
  })

  const [first, second, third] = blocks().map(block => block.getBoundingClientRect().top)
  expect(second - first).toBeCloseTo(third - second, 1)
})

// A table of fruit, and the same with a column gone, a row gone, a row come and a cell edited.
const STOCK = [['Name', 'Qty', 'Note'], ['Apples', '3', 'ok'], ['Pears', '5', 'ok'], ['Plums', '7', 'ok']]
const FRUIT = table([120, 60, 80], STOCK)
const FEWER = table([120, 60], [['Name', 'Qty'], ['Apples', '4'], ['Plums', '7'], ['Kiwis', '9']], written)
const cells = (root: ParentNode, mark = '') => [...root.querySelectorAll(`td${mark}`)].map(text)

it('draws a table its changes edit as the table it will be, with each cell that came or was edited marked', async () => {
  const { blocks, show } = await draw({ drawing: drawing([paragraph('Stock'), FRUIT]), edits: [edit(1, 2, [FEWER])] })
  const grid = () => blocks()[1]

  expect(grid().className).toBe('grid changed')
  expect([...grid().querySelectorAll('tr')].map(row => cells(row))).toEqual([['Name', 'Qty'], ['Apples', '4'], ['Plums', '7'], ['Kiwis', '9']])
  expect([cells(grid(), '.changed'), cells(grid(), '.added'), cells(grid(), '.removed')]).toEqual([['4'], ['Kiwis', '9'], []])
  // A cell left alone is the saved one, set as it was.
  expect(grid().querySelectorAll('td')[0].querySelector('.para')!.className).toBe('para')
  // The table has the bar in the margin, and no cell one of its own.
  const bar = (element: Element) => frame!.contentWindow!.getComputedStyle(element, '::before').content
  expect([bar(grid()), ...[...grid().querySelectorAll('td.changed, td.added')].map(bar)]).toEqual(['""', 'none', 'none', 'none'])

  show('As saved')
  expect([...grid().querySelectorAll('tr')].map(row => cells(row))).toEqual(STOCK)
  expect([cells(grid(), '.changed'), cells(grid(), '.added')]).toEqual([['3'], []])
  expect(cells(grid(), '.removed')).toEqual(['Note', 'ok', 'Pears', '5', 'ok', 'ok'])
})

it('keeps a row a change edits whole on a page where the saved row is kept so', async () => {
  const kept = { ...FRUIT, rows: FRUIT.rows.map((row, at) => at === 1 ? { ...row, unbroken: true } : row) }
  const { blocks } = await draw({ drawing: drawing([paragraph('Stock'), kept]), edits: [edit(1, 2, [FEWER])] })
  expect([...blocks()[1].querySelectorAll('tr')].map(row => 'unbroken' in row.dataset)).toEqual([false, true, false, false])
})

// A table, and the same words in it set another way: a column widened, a row given a least
// height, a cell filled.
const PLAIN = [['Name', 'Qty'], ['Apples', '3']]
const reset = (columns = [120, 80], cell: object = {}, row: object = {}) => {
  const { rows: [head, last] } = table(columns, PLAIN, written)
  return { type: 'table', columns, rows: [head, { ...last, ...row, cells: [last.cells[0], { ...last.cells[1], ...cell }] }] }
}

it.each([
  ['a column widened', reset([170, 80]), ['Name', 'Apples'], (grid: Element) => grid.querySelector('col')!.style.width, '170pt', '120pt'],
  ['a row given a least height', reset(undefined, {}, { minHeight: 50 }), ['Apples', '3'], (grid: Element) => grid.querySelectorAll('tr')[1].dataset.least, '50pt', undefined],
  ['a cell filled', reset(undefined, { background: '#ff0000' }), ['3'], (grid: Element) => grid.querySelectorAll('td')[3].style.background, 'rgb(255, 0, 0)', ''],
])('draws a table with %s as changed, its words as they were, and as it was in As saved', async (_name, pending, marked, set, now, was) => {
  const { blocks, show } = await draw({ drawing: drawing([table([120, 80], PLAIN)]), edits: [edit(0, 1, [pending])] })
  const grid = () => blocks()[0]

  for (const view of ['With changes', 'Inline']) {
    show(view)
    expect([grid().className, cells(grid(), '.changed'), set(grid())]).toEqual(['grid changed', marked, now])
  }
  show('As saved')
  expect([cells(grid(), '.changed'), set(grid())]).toEqual([marked, was])
})

it('takes a pending cell filled with the color of its page for one with no fill, as a saved cell is told', async () => {
  const { blocks } = await draw({ drawing: drawing([table([120, 80], PLAIN)]), edits: [edit(0, 1, [reset(undefined, { background: '#ffffff' })])] })
  expect(blocks()[0].className).toBe('grid')
  expect(frame!.contentDocument!.querySelector<HTMLElement>('.views')!.hidden).toBe(true)
})

/** The seams of `root`, each as its edge, its note and the text of the cell it is on. */
const seams = (root: ParentNode, kind = '.gone') =>
  [...root.querySelectorAll<HTMLElement>(`td > .tick.seam${kind}`)].map(seam => [seam.className.split(' ').at(-1), seam.title, text(seam.parentElement!)])
/** STOCK without the rows `gone`, as a pending change writes it. */
const stockLess = (...gone: string[]) => table([120, 60, 80], STOCK.filter(([name]) => !gone.includes(name)), written)

it('marks where a row went with a seam on the border of the row after it, which takes no room', async () => {
  const { blocks, show } = await draw({ drawing: drawing([paragraph('Stock'), FRUIT]), edits: [edit(1, 2, [stockLess('Pears')])] })
  const grid = () => blocks()[1]

  const note = 'Removed here: row “Pears 5 ok”'
  expect(seams(grid())).toEqual([['above', note, 'Plums'], ['above', note, '7'], ['above', note, 'ok']])
  expect(seams(grid(), '.came')).toEqual([])
  const [seam] = grid().querySelectorAll<HTMLElement>('.seam')
  expect(seam.getAttribute('aria-label')).toBe(note)
  // On the border, as wide as its cell, and red.
  const [line, cell] = [seam, seam.parentElement!].map(element => element.getBoundingClientRect())
  expect(Math.abs((line.top + line.bottom) / 2 - cell.top)).toBeLessThan(1.5)
  expect(line.height).toBeLessThan(4)
  expect(Math.abs(line.width - cell.width)).toBeLessThan(1.5)
  expect(getComputedStyle(seam).backgroundColor).toBe('rgb(165, 14, 14)')
  // The rows are as tall as those of the table saved.
  const tall = () => [...grid().querySelectorAll('tr')].map(row => row.getBoundingClientRect().height)
  const [, , after] = tall()
  show('As saved')
  expect(seams(grid(), '')).toEqual([])
  expect(tall()[3]).toBe(after)

  // Pressed, it is read where the row is struck.
  show('With changes')
  grid().querySelector<HTMLElement>('.seam')!.click()
  expect(cells(grid(), '.removed')).toEqual(['Pears', '5', 'ok'])
  expect(seams(grid(), '')).toEqual([])
})

it('marks rows that went side by side with one seam, under the last row where they ended the table', async () => {
  const { blocks } = await draw({ drawing: drawing([FRUIT]), edits: [edit(0, 1, [stockLess('Apples', 'Pears')])] })
  const note = '2 rows removed here, from row “Apples 3 ok”'
  expect(seams(blocks()[0])).toEqual([['above', note, 'Plums'], ['above', note, '7'], ['above', note, 'ok']])

  const ended = await draw({ drawing: drawing([FRUIT]), edits: [edit(0, 1, [stockLess('Plums')])] })
  expect(seams(ended.blocks()[0]).map(([edge, said, cell]) => [edge, said, cell])).toEqual(
    ['Pears', '5', 'ok'].map(cell => ['below', 'Removed here: row “Plums 7 ok”', cell]))
  const [seam] = ended.blocks()[0].querySelectorAll<HTMLElement>('.seam')
  const [line, cell] = [seam, seam.parentElement!].map(element => element.getBoundingClientRect())
  expect(Math.abs((line.top + line.bottom) / 2 - cell.bottom)).toBeLessThan(1.5)
})

it('marks where a column went with a seam down the border of the column after it, and where one came in the table saved', async () => {
  const narrow = table([120, 80], STOCK.map(([name, , note]) => [name, note]), written)
  const { blocks } = await draw({ drawing: drawing([FRUIT]), edits: [edit(0, 1, [narrow])] })
  const note = 'Removed here: column “Qty 3 5 7”'
  expect(seams(blocks()[0])).toEqual(['Note', 'ok', 'ok', 'ok'].map(cell => ['before', note, cell]))
  const [seam] = blocks()[0].querySelectorAll<HTMLElement>('.seam')
  const [line, cell] = [seam, seam.parentElement!].map(element => element.getBoundingClientRect())
  expect(Math.abs((line.left + line.right) / 2 - cell.left)).toBeLessThan(1.5)
  expect(line.width).toBeLessThan(4)
  expect(Math.abs(line.height - cell.height)).toBeLessThan(1.5)

  // The last column goes and a row goes, and in the table saved the row that comes is a green seam.
  const both = await draw({ drawing: drawing([FRUIT]), edits: [edit(0, 1, [FEWER])] })
  expect(seams(both.blocks()[0])).toEqual([
    ['after', 'Removed here: column “Note ok ok ok”', 'Qty'], ['after', 'Removed here: column “Note ok ok ok”', '4'],
    ['above', 'Removed here: row “Pears 5 ok”', 'Plums'], ['above', 'Removed here: row “Pears 5 ok”', '7'],
    ['after', 'Removed here: column “Note ok ok ok”', '7'], ['after', 'Removed here: column “Note ok ok ok”', '9'],
  ])
  both.show('As saved')
  expect(seams(both.blocks()[0], '.came')).toEqual(['Plums', '7', 'ok'].map(on => ['below', 'Added here: row “Kiwis 9”', on]))
  expect(getComputedStyle(both.blocks()[0].querySelector('.seam')!).backgroundColor).toBe('rgb(19, 115, 51)')
})

it('repeats no seam over a row with the row a table repeats on each page, and carries one at a cell\'s side on down the cell', async () => {
  const body = Array.from({ length: 30 }, (_, row) => [`Row ${row}`, 'x', 'y'])
  const rows = (...head: string[][]) => [...head, ...body].map((words, row) => ({ ...table([120, 60, 80], [words], written).rows[0], ...row < head.length && { header: true } }))
  const stock = (head: string[][], block = table([120, 60, 80], [], written)) => ({ ...block, rows: rows(...head) })
  const first = await draw({ drawing: drawing([stock([['Old head', 'a', 'b'], ['Head', 'c', 'd']])]), edits: [edit(0, 1, [stock([['Head', 'c', 'd']])])] })
  // The table runs over several pages, each of which starts with the row it repeats.
  const heads = first.page.querySelectorAll('tr[data-header]')
  expect(heads.length).toBeGreaterThan(2)
  expect(seams(first.page).map(([edge, , on]) => [edge, on])).toEqual([['above', 'Head'], ['above', 'c'], ['above', 'd']])

  // A cell too tall for its page is ended there, and the seam at its side goes on down what is left of it.
  const tall = (words: string) => ({ ...CELL, column: 2, blocks: Array.from({ length: 40 }, (_, line) => written(`${words} ${line}`)) })
  const split = await draw({
    drawing: drawing([table([120, 60, 80], [['Name', 'Qty', tall('Note')]], written)]),
    edits: [edit(0, 1, [table([120, 80], [['Name', { ...tall('Note'), column: 1 }]], written)])],
  })
  const parts = [...split.page.querySelectorAll<HTMLElement>('.seam.before')]
  expect(parts.length).toBeGreaterThan(1)
  expect(new Set(parts.map(seam => seam.closest('.sheet'))).size).toBe(parts.length)
  expect(new Set(parts.map(seam => seam.title))).toEqual(new Set(['Removed here: column “Qty”']))
})

/** A cell at `column` of its row that says `words`, in a paragraph that `block` makes. */
const cellAt = (column: number, words: string, block = paragraph, more = {}) => ({ ...CELL, column, blocks: [block(words)], ...more })

it('draws no cell that a merged cell reaches, though it still holds text, and marks an edit to a cell past it', async () => {
  // The first cell reaches the second, across or down, which Google Docs keeps with the text it had.
  const across = (last: string, block = paragraph) => table([100, 100, 100], [
    [cellAt(0, 'Merged head', block, { columnSpan: 2 }), cellAt(1, 'Leftover words', block), cellAt(2, last, block)], ['d one', 'e two', 'f three'],
  ], block)
  const down = (last: string, block = paragraph) => table([100, 100, 100], [
    [cellAt(0, 'Tall', block, { rowSpan: 2 }), 'b', 'c'], [cellAt(0, 'Leftover', block), 'e', cellAt(2, last, block)],
  ], block)
  const { blocks, refresh, show } = await draw({ drawing: drawing([across('Quarterly total')]) })
  const lefts = () => Object.fromEntries([...blocks()[0].querySelectorAll('td')].map(found => [text(found), Math.round(found.getBoundingClientRect().left)]))

  // Each cell that is drawn stands in its own column.
  expect(cells(blocks()[0])).toEqual(['Merged head', 'Quarterly total', 'd one', 'e two', 'f three'])
  expect(lefts()['Quarterly total']).toBe(lefts()['f three'])

  const marked = async (drawn: string[], edited: string[]) => {
    for (const [at, view] of ['With changes', 'Inline', 'As saved'].entries()) {
      show(view)
      await expect.poll(() => cells(blocks()[0], '.changed')).toEqual([edited[at]])
      expect(cells(blocks()[0]).filter(words => !edited.includes(words))).toEqual(drawn)
    }
    show('With changes')
  }
  await refresh({ edits: [edit(0, 1, [across('Quarterly total revised', written)])] })
  await marked(['Merged head', 'd one', 'e two', 'f three'], ['Quarterly total revised', 'Quarterly total revised', 'Quarterly total'])
  await refresh({ version: 'v2', drawing: drawing([down('final')]), edits: [edit(0, 1, [down('final edited', written)])] })
  await marked(['Tall', 'b', 'c', 'e'], ['final edited', 'final edited', 'final'])
})

/** What the blocks of the body say and what each is marked as, where every change is read in place. */
const redline = (blocks: HTMLElement[]) => blocks.map(block => [text(block), block.className.replace(/^para ?| ?fresh/g, '')])

it('marks the text a split brings out from under a merged cell, and the text a merge takes under one', async () => {
  // Google Docs keeps what a cell said when another is merged over it, and shows it again when the two are split.
  const row = (span: object, block = paragraph) => table([100, 100, 100], [
    [cellAt(0, 'Merged head', block, span), cellAt(1, 'Leftover words', block), 'last'], ['d one', 'e two', 'f three'],
  ], block)
  const [merged, split] = [{ columnSpan: 2 }, {}]
  const { blocks, refresh, show, look } = await draw({ drawing: drawing([row(merged)]), edits: [edit(0, 1, [row(split, written)])] })
  // The paragraphs of the cells marked as edited, with what each is marked as, and whether the cell under the merged one is drawn.
  const marks = () => [redline([...blocks()[0].querySelectorAll<HTMLElement>('td.changed .para')]), cells(blocks()[0]).includes('Leftover words')]
  const tint = () => look(run(blocks()[0], 'Leftover words')).backgroundColor

  for (const view of ['With changes', 'Inline']) {
    show(view)
    expect(marks()).toEqual([[['Merged head', ''], ['Leftover words', 'added']], true])
    expect(tint()).toBe('rgb(230, 244, 234)')
  }
  show('As saved')
  expect(marks()).toEqual([[['Merged head', '']], false])

  await refresh({ version: 'v2', drawing: drawing([row(split)]), edits: [edit(0, 1, [row(merged, written)])] })
  await expect.poll(marks).toEqual([[['Merged head', ''], ['Leftover words', 'removed']], true])
  expect(tint()).toBe('rgb(252, 232, 230)')
  for (const view of ['With changes', 'Inline']) {
    show(view)
    expect(marks()).toEqual([[['Merged head', '']], false])
  }
})

it('pairs a row or a paragraph only with the one that says the same where several are alike', async () => {
  const rows = (...told: string[][]) => told.map(([task, state]) => [task, state])
  const { blocks, refresh, show } = await draw({
    drawing: drawing([table([150, 100], rows(['Status report', 'Owner'], ['Task alpha', 'done'], ['Task beta', 'done']))]),
    edits: [edit(0, 1, [table([150, 100], rows(['Weekly summary', 'Who'], ['Task alpha', 'done']), written)])],
  })
  // The first row is rewritten and the last one goes: the row between them is left as it was.
  show('Inline')
  expect([cells(blocks()[0], '.removed'), cells(blocks()[0], '.added'), cells(blocks()[0], '.changed')]).toEqual(
    [['Status report', 'Owner', 'Task beta', 'done'], ['Weekly summary', 'Who'], []])

  const list = (...items: string[]) => items.map(item => `Buy ${item} today`)
  const edits = (told: string[]) => [edit(0, 5, told.map(words => written(words)))]
  await refresh({ version: 'v2', drawing: drawing(['Shopping list for the week', ...list('eggs', 'bread')].map(words => paragraph(words))), edits: edits(list('eggs')) })
  await expect.poll(() => redline(blocks())).toEqual([['Shopping list for the week', 'removed'], ['Buy eggs today', ''], ['Buy bread today', 'removed']])

  // One of five lines that are all alike goes, and the four after it are not told as each other.
  await refresh({ version: 'v3', drawing: drawing(list('milk', 'eggs', 'bread', 'cheese', 'jam').map(words => paragraph(words))), edits: edits(list('milk', 'bread', 'cheese', 'jam')) })
  await expect.poll(() => redline(blocks())).toEqual(
    [['Buy milk today', ''], ['Buy eggs today', 'removed'], ['Buy bread today', ''], ['Buy cheese today', ''], ['Buy jam today', '']])
})

it('reads a changed table in place as one table, the rows and columns that go among those that come', async () => {
  const { blocks, show } = await draw({ drawing: drawing([paragraph('Stock'), FRUIT]), edits: [edit(1, 2, [FEWER])] })
  show('Inline')
  const [, grid, ...rest] = blocks()

  expect(rest).toEqual([])
  // The row and the column that go stand where they were, and the cell edited holds both its words.
  expect([...grid.querySelectorAll('tr')].map(row => cells(row))).toEqual(
    [['Name', 'Qty', 'Note'], ['Apples', '34', 'ok'], ['Pears', '5', 'ok'], ['Plums', '7', 'ok'], ['Kiwis', '9', '']])
  expect(cells(grid, '.removed')).toEqual(['Note', 'ok', 'Pears', '5', 'ok', 'ok'])
  expect(cells(grid, '.added')).toEqual(['Kiwis', '9'])
  const [edited] = grid.querySelectorAll('td.changed')
  expect([...edited.querySelectorAll('.para')].map(block => [text(block), block.className])).toEqual([['3', 'para removed'], ['4', 'para added']])
})

it('draws cells a pending change merges as the one cell, edited, with what it took in', async () => {
  const merged = table([100, 100], [[{ ...CELL, column: 0, columnSpan: 2, blocks: [written('A'), written('B')] }], ['C', 'D']], written)
  const { blocks, show } = await draw({ drawing: drawing([table([100, 100], [['A', 'B'], ['C', 'D']])]), edits: [edit(0, 1, [merged])] })
  const wide = () => blocks()[0].querySelector('td')!

  for (const view of ['With changes', 'Inline']) {
    show(view)
    expect([wide().colSpan, wide().className, cells(blocks()[0])]).toEqual([2, 'changed', ['AB', 'C', 'D']])
    expect([...wide().querySelectorAll('.para')].map(block => block.className)).toEqual(['para', 'para added'])
  }
})

it('numbers the items of a list as its changes leave them, and marks a list they start as they define it', async () => {
  const level = { format: '%0.', numbering: 'decimal', start: 1, indentFirstLine: 18, indentStart: 36 }
  const indented = { lineSpacing: 1, indentFirstLine: 18, indentStart: 36 }
  const item = (words: string) => paragraph([{ text: words, look: NORMAL }], { look: 1, list: { id: 'l', level: 0, look: NORMAL } })
  const put = (words: string, id = 'l') => written(words, { list: { id, level: 0, look: UNSTATED } })
  const { blocks, show } = await draw({
    drawing: drawing([item('First'), item('Second'), item('Third')], { lists: { l: [level] }, paragraphLooks: [{ lineSpacing: 1 }, indented] }),
    edits: [edit(1, 1, [put('New')]), edit(2, 3, []), edit(3, 3, [put('Apart', 'dotted'), put('Counted', 'counted')])],
    // Of a list the changes start only how its items are marked is told.
    lists: { dotted: [{ symbol: '○', start: 1 }], counted: [{ numbering: 'upperAlpha', start: 3 }] },
  })
  const items = () => blocks().filter(block => block.matches('.para')).map(block => `${text(block.querySelector('.marker')!)} ${text(block).slice(text(block.querySelector('.marker')!).length)}`)

  // The item put in takes the number of the one it stands before, which counts on from it.
  expect(items()).toEqual(['1. First', '2. New', '3. Second', '○ Apart', 'C. Counted'])
  // It is indented as its level is, which it does not state.
  expect(blocks().slice(0, 2).map(block => block.style.marginLeft)).toEqual(['36pt', '36pt'])
  show('As saved')
  expect(items()).toEqual(['1. First', '2. Second', '3. Third'])
  // Read in place, the item that goes shows the number it would take there and takes none.
  show('Inline')
  expect(items()).toEqual(['1. First', '2. New', '3. Second', '4. Third', '○ Apart', 'C. Counted'])
})

it('sets an item at the edge where its paragraph states an indent of none, and as its level where it states no indent', async () => {
  const level = { format: '%0.', numbering: 'decimal', start: 1, indentFirstLine: 18, indentStart: 36 }
  const item = (words: string, look: number) => written(words, { look, list: { id: 'l', level: 0, look: UNSTATED } })
  const { blocks } = await draw({
    drawing: drawing([paragraph('Before')], { lists: { l: [level] } }),
    edits: [edit(1, 1, [item('As its level', UNSTATED), item('At the edge', FLUSH)])],
  })
  expect(blocks().slice(1).map(block => [block.style.marginLeft, block.style.textIndent])).toEqual([['36pt', '-18pt'], ['', '']])
})

it('numbers a footnote a pending change adds, and those after it', async () => {
  const noted = (words: string, footnote: string, mark: string, look: number, block = paragraph) => block([{ text: words, look }, { footnote, mark, look }])
  const { page, show } = await draw({
    drawing: drawing([paragraph('Text'), noted('Saved', 'f1', '1', NORMAL)], { footnotes: { f1: [paragraph('The note')] } }),
    edits: [edit(1, 1, [noted('Put in', 'f2', '', UNSTATED, written)])],
  })
  const marks = () => [...page.querySelectorAll('.col [data-footnote]')].map(text)

  expect(marks()).toEqual(['1', '2'])
  show('As saved')
  expect(marks()).toEqual(['1'])
})

const PICTURE = { width: 20, height: 10, readable: true }
const png = () => ({ mimeType: 'image/png', content: new Blob([new Uint8Array([137, 80, 78, 71])]).stream() })

const GONE_INK = 'rgb(165, 14, 14)'

it('marks what is no text that a change takes out of a paragraph or brings into it', async () => {
  const { blocks, show, look } = await draw({
    drawing: drawing([
      paragraph([{ look: NORMAL, text: 'Beside ' }, { look: NORMAL, object: 'gone' }, { look: NORMAL, text: ' the picture ' }, { look: NORMAL, object: 'kept' }]),
      paragraph('Owner:'),
      paragraph([{ look: NORMAL, chip: 'Alice' }, { look: NORMAL, text: ' approves' }]),
    ], { objects: { gone: PICTURE, kept: PICTURE } }),
    edits: [
      // A picture goes. The one that stays is told in another order than the drawing tells it.
      edit(0, 1, [written([{ text: 'Beside  the picture ', look: UNSTATED }, { object: 'kept', look: UNSTATED }])]),
      // Two paragraphs are joined, which brings the chip of the second into the first.
      edit(1, 3, [written([{ look: UNSTATED, text: 'Owner: ' }, { look: UNSTATED, chip: 'Alice' }, { look: UNSTATED, text: ' approves' }])]),
    ],
  })
  const pictures = () => [...blocks()[0].querySelectorAll<HTMLElement>('.obj')].map(box => [box.dataset.object, ['added', 'removed'].filter(mark => box.classList.contains(mark))])

  // Where the picture was is marked, though no word went with it.
  expect([...blocks()[0].querySelectorAll<HTMLElement>('.tick')].map(tick => [tick.title, tick.getAttribute('aria-label')])).toEqual(
    [['Removed here: an image', 'Removed here: an image']])
  expect(pictures()).toEqual([['kept', []]])
  // The chip that came is tinted as the words that came with it are, and has no bar of its own.
  const chip = blocks()[1].querySelector('.chip')!
  expect([text(chip), chip.classList.contains('added'), look(chip).backgroundColor]).toEqual(['Alice', true, look(run(blocks()[1], 'approves')).backgroundColor])
  expect(look(chip).backgroundColor).toBe('rgb(230, 244, 234)')
  expect(frame!.contentWindow!.getComputedStyle(chip, '::before').content).toBe('none')

  // Read in place, the picture that goes is ringed in the ink of what goes, and dimmed.
  show('Inline')
  expect(pictures()).toEqual([['gone', ['removed']], ['kept', []]])
  const gone = blocks()[0].querySelector('.obj.removed')!
  expect([look(gone).opacity, look(gone).boxShadow.includes(GONE_INK)]).toEqual(['0.45', true])
  expect(blocks()[0].querySelectorAll('.tick')).toHaveLength(0)
})

it('marks a footnote\'s mark that a change takes out of a paragraph', async () => {
  const { blocks, page, show, look } = await draw({
    drawing: drawing([paragraph([{ look: NORMAL, text: 'Claim' }, { look: NORMAL, footnote: 'f1', mark: '1' }, { look: NORMAL, text: ' made' }])],
      { footnotes: { f1: [paragraph('The note')] } }),
    edits: [edit(0, 1, [written('Claim made')])],
  })
  expect([...blocks()[0].querySelectorAll<HTMLElement>('.tick')].map(tick => tick.title)).toEqual(['Removed here: a footnote mark'])
  expect(page.querySelectorAll('[data-footnote]')).toHaveLength(0)

  show('Inline')
  const mark = blocks()[0].querySelector('[data-footnote]')!
  expect([text(mark), mark.classList.contains('removed'), look(mark).color, look(mark).textDecorationLine]).toEqual(['1', true, GONE_INK, 'line-through'])
})

const MARK_INK = 'rgb(19, 115, 51)'

it('marks a line, a page number, an equation and a picture that a change takes out of a paragraph or brings into it', async () => {
  const { blocks, show, look } = await draw({
    drawing: drawing([
      paragraph([{ look: NORMAL, text: 'Sum ' }, { look: NORMAL, equation: true }, { look: NORMAL, text: ' page ' }, { look: NORMAL, field: 'pageNumber' }, { look: NORMAL, text: ' end' }]),
      paragraph([{ look: NORMAL, text: 'Ruled' }, { look: NORMAL, rule: true }]),
    ], { objects: { fresh: PICTURE } }),
    edits: [edit(0, 2, [written([{ look: UNSTATED, text: 'Sum  page  end ' }, { look: UNSTATED, object: 'fresh' }]), written('Ruled')])],
  })
  const ticks = () => blocks().flatMap(block => [...block.querySelectorAll<HTMLElement>('.tick')].map(tick => tick.title))

  // The picture that comes is ringed in the ink of what comes, and what went is named where it was.
  expect(look(blocks()[0].querySelector('.obj.added')!).boxShadow.includes(MARK_INK)).toBe(true)
  expect(ticks()).toEqual(['Removed here: an equation', 'Removed here: a page number', 'Removed here: a line'])

  show('Inline')
  expect(ticks()).toEqual([])
  expect(look(blocks()[0].querySelector('.obj.added')!).boxShadow.includes(MARK_INK)).toBe(true)
  const [equation, number] = [blocks()[0].querySelector('.chip.removed')!, blocks()[0].querySelector('[data-field].removed')!]
  expect([text(equation), look(equation).color, look(equation).textDecorationLine]).toEqual(['Equation', GONE_INK, 'line-through'])
  expect([look(number).color, look(number).textDecorationLine]).toEqual([GONE_INK, 'line-through'])
  expect(look(blocks()[1].querySelector('.rule.removed')!).borderTopColor).toBe(GONE_INK)
})

it('marks a break that a change takes away or brings: where its page ends, and on the line that stands for it', async () => {
  const ended = (kind?: string, block = paragraph, look = NORMAL) => block([{ look, text: 'One' }, ...kind ? [{ look, break: kind }] : []])
  const { page, sheets, show, look, refresh } = await draw({
    drawing: drawing([ended('page'), paragraph('Two')]), edits: [edit(0, 1, [ended(undefined, written, UNSTATED)])],
  })
  // Each mark at a break: what it says, the color of its caret, and the sheet it is on.
  const ticks = () => [...page.querySelectorAll<HTMLElement>('.tick')].map(tick =>
    [tick.title, frame!.contentWindow!.getComputedStyle(tick, '::before').borderBottomColor, sheets().indexOf(tick.closest<HTMLElement>('.sheet')!)])
  const line = () => {
    const [found, ...more] = page.querySelectorAll<HTMLElement>('.pagebreak')
    return [more.length, text(found), found.className, look(found).color, look(found).textDecorationLine]
  }

  // The break goes: the tab will be one sheet, and was two.
  expect([sheets().length, ticks()]).toEqual([1, [['Removed here: a page break', GONE_INK, 0]]])
  show('As saved')
  expect([sheets().length, ticks()]).toEqual([2, [['Removed here: a page break', GONE_INK, 0]]])
  show('Inline')
  expect([ticks(), line()]).toEqual([[], [0, 'Page break', 'pagebreak gone', GONE_INK, 'line-through']])

  // A break comes, of a column, which in one column ends the page.
  await refresh({ version: 'v2', drawing: drawing([ended(), paragraph('Two')]), edits: [edit(0, 1, [ended('column', written, UNSTATED)])] })
  await expect.poll(() => page.querySelector('.pagebreak')?.textContent).toBe('Column break')
  expect([ticks(), line()]).toEqual([[], [0, 'Column break', 'pagebreak came', MARK_INK, 'none']])
  show('With changes')
  expect([sheets().length, ticks()]).toEqual([2, [['Added here: a column break', MARK_INK, 0]]])
  show('As saved')
  expect([sheets().length, ticks()]).toEqual([1, [['Added here: a column break', MARK_INK, 0]]])
})

it('names a break that goes with the words after it, and ends a paragraph at a break that only the mark of what went follows', async () => {
  const runs = (look: number, ...told: string[]) => told.map(part => part === 'page' ? { look, break: part } : { look, text: part })
  const { page, sheets, refresh } = await draw({
    drawing: drawing([paragraph(runs(NORMAL, 'Chapter end', 'page', 'Next chapter')), paragraph('Two')]),
    edits: [edit(0, 1, [written(runs(UNSTATED, 'Chapter end'))])],
  })
  const ticks = () => [...page.querySelectorAll<HTMLElement>('.tick')].map(tick => tick.title)
  const lines = () => sheets().map(sheet => [...sheet.querySelectorAll('.col > *')].map(text))
  expect([ticks(), lines()]).toEqual([['Removed here: “Next chapter” and a page break'], [['Chapter end', 'Two']]])

  // The words go and the break stays: the sheet after it starts with the next paragraph, as it will.
  await refresh({ edits: [edit(0, 1, [written(runs(UNSTATED, 'Chapter end', 'page'))])] })
  await expect.poll(ticks).toEqual(['Removed here: “Next chapter”'])
  expect(lines()).toEqual([['Chapter end'], ['Two']])
})

it('sets a document still to be made as Google Docs sets a new one: what is written into it, and its blank paragraph', async () => {
  // Its blank page is drawn as a tab's still to be added is, but under a version, and its edit is of that page's one paragraph.
  const { blocks, show } = await draw({ drawing: BLANK, edits: [edit(0, 1, [written('Hello world')])] })
  const spacing = () => blocks().filter(block => block.matches('.para')).map(block => [text(block), block.style.getPropertyValue('--ls')])
  expect(spacing()).toEqual([['Hello world', '1.15']])
  show('As saved')
  expect(spacing()).toEqual([['', '1.15']])

  const added = await draw({ tabs: ['pending-tab-1'] })
  expect(added.blocks().map(block => [text(block), block.style.getPropertyValue('--ls')])).toEqual([['pending-tab-1', '1.15']])
})

it('lines up no blocks of an edit that holds too many to compare, which all go and come', async () => {
  // Every line is akin to every other, and neither the first nor the last is to the one in its place.
  const lines = (first: string, count: number, more: string, last: string) =>
    [first, ...Array.from({ length: count }, (_, line) => `Line ${line} of the report${more}`), last]
  const saved = lines('Opening', 999, '', 'Closing').map(line => paragraph(line))
  const { blocks, refresh } = await draw({
    drawing: drawing(saved, { pageless: true }),
    edits: [edit(0, saved.length, lines('Start', 999, ' revised', 'Finish').map(line => written(line)))],
  })
  expect(blocks()).toHaveLength(1002)
  expect([blocks()[0].className, blocks()[0].title]).toEqual(['omit gone', '1001 blocks removed here, from “Opening”'])
  expect(blocks().slice(1).every(block => block.className === 'para added')).toBe(true)

  // Two lines fewer are few enough, and each line is then the one it was, edited.
  await refresh({ edits: [edit(0, saved.length, lines('Start', 997, ' revised', 'Finish').map(line => written(line)))] })
  await expect.poll(() => blocks().filter(block => block.classList.contains('changed')).length).toBe(997)
})

it('asks again on a refresh for a picture that could not be read', async () => {
  let reads = 0
  const pictured = drawing([paragraph([{ object: 'pic', look: NORMAL }])], { objects: { pic: PICTURE } })
  const { page, refresh } = await draw({ drawing: pictured }, {
    readImage: async () => {
      if (!reads++) throw new Error('not just now')
      return png()
    },
  })
  await expect.poll(() => page.querySelector('.obj.wait')).toBeNull()
  expect([reads, page.querySelector('.obj img')]).toEqual([1, null])

  // Nothing of the tab moved, so the page stands, and its missing picture is read.
  await refresh({})
  await expect.poll(() => page.querySelector('.obj img')).not.toBeNull()
  expect(reads).toBe(2)
})

it('reads no picture of a tab that was left while the picture waited its turn', async () => {
  const asked: string[] = []
  const waiting: (() => void)[] = []
  const pictures = (...ids: string[]) => drawing([paragraph(ids.map(object => ({ object, look: NORMAL })))],
    { objects: Object.fromEntries(ids.map(id => [id, PICTURE])) })
  const { page } = await draw({ tabs: ['t.0', 't.1'] }, {
    readDrawing: async (tabId: string) => tabId === 't.0' ? pictures('first', 'second') : pictures('other'),
    readImage: async (object: string, tabId: string) => {
      asked.push(`${tabId} ${object}`)
      await new Promise<void>(resolve => waiting.push(resolve))
      return png()
    },
  })
  await expect.poll(() => asked).toEqual(['t.0 first'])

  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => page.querySelectorAll('.obj')).toHaveLength(1)
  waiting.shift()!()

  // One picture is read at a time, and the next is the one the tab shown waits for.
  await expect.poll(() => asked).toEqual(['t.0 first', 't.1 other'])
  waiting.shift()!()
  await expect.poll(() => page.querySelector('.obj img')).not.toBeNull()
})

it('offers no copy of the tab it left while the tab chosen is read', async () => {
  let arrive = () => {}
  const { page } = await draw({ tabs: ['t.0', 't.1'] }, {
    readPendingDrawing: async (tabId: string) => {
      if (tabId === 't.1') await new Promise<void>(resolve => { arrive = resolve })
      return { tabId, version: 'v1', ...STATED, edits: tabId === 't.0' ? [edit(0, 1, [written('Edited')])] : [] }
    },
  })
  const views = frame!.contentDocument!.querySelector<HTMLElement>('.views')!
  expect(views.hidden).toBe(false)

  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => page.hasAttribute('aria-busy')).toBe(true)
  expect(views.hidden).toBe(true)

  arrive()
  await expect.poll(() => page.textContent).toContain('t.1')
})

it('steps back from where it opens to the last of the places its changes are in', async () => {
  const { page } = await draw({
    drawing: drawing([paragraph('One'), paragraph('Two'), paragraph('Three')]),
    edits: [edit(0, 1, [written('One more')]), edit(2, 3, [written('Three more')])],
  })
  const nav = frame!.contentDocument!.getElementById('nav')!
  const [previous, next] = [...nav.querySelectorAll<HTMLElement>('button')]
  const here = () => [...page.querySelectorAll('.here')].map(text)

  // Edits apart are places apart.
  expect(nav.getAttribute('aria-label')).toBe('2 changed places')
  previous.click()
  expect(here()).toEqual(['Three more'])
  next.click()
  expect(here()).toEqual(['One more'])
})

it('says how many changes no longer fit, and keeps what floats over its corner inside a narrow pane', async () => {
  const { page } = await draw({
    drawing: drawing([paragraph('It is due today')]),
    edits: [edit(0, 1, [written('It is ready today')])],
    changes: [{ id: 1, stale: true, type: 'replaceText' }, { id: 2, stale: true, type: 'appendText' }, { id: 3, type: 'replaceText' }],
  })
  const doc = page.ownerDocument
  expect(doc.getElementById('stale')!.textContent).toBe('2 changes no longer apply')

  frame!.style.width = '399px'
  await expect.poll(() => doc.documentElement.clientWidth).toBeLessThan(400)
  const edges = ['#stale', '.views', '#nav button[aria-label="Next change"]'].map(found => doc.querySelector(found)!.getBoundingClientRect())

  expect(edges.every(({ left, right, width }) => width > 0 && left >= 0 && right <= doc.documentElement.clientWidth)).toBe(true)
})

it('starts a section on the next sheet when the sheet it starts on has no line left for it', async () => {
  const lines = Array.from({ length: 40 }, (_, line) => `Line ${line}`)
  const margins = { top: 40, right: 50, bottom: 40, left: 50, header: 10, footer: 10 }
  const whole = await draw({ drawing: drawing(lines.map(line => paragraph(line))) })
  const full = whole.sheets()[0].querySelectorAll('.col > *').length
  frame!.remove()

  // The same lines, set in two columns from where the first sheet is full.
  const broken = [...lines.slice(0, full).map(line => paragraph(line)), { type: 'section', section: 1 }, ...lines.slice(full).map(line => paragraph(line))]
  const { sheets } = await draw({
    drawing: drawing(broken, { sections: [{ margins }, { margins, columns: [{ width: 240, gap: 20 }, { width: 240, gap: 0 }] }] }),
  })
  expect(sheets()[0].querySelectorAll('.col > *')).toHaveLength(full)
  expect(sheets()[1].querySelectorAll('.col')).toHaveLength(2)
  expect(text(sheets()[1].querySelector('.col > *')!)).toBe(lines[full])
  const lefts = (found: HTMLElement[]) => [...found[1].querySelectorAll('.col')].map(column => Math.round(column.getBoundingClientRect().left))
  const [first, second] = lefts(sheets())
  expect(second - first).toBe(Math.round(260 * POINT))
  frame!.remove()

  // A section read from the right fills the column on the right first, the gap still between them.
  const reversed = await draw({
    drawing: drawing(broken, { sections: [{ margins }, { margins, rightToLeft: true, columns: [{ width: 240, gap: 20 }, { width: 240, gap: 0 }] }] }),
  })
  expect(text(reversed.sheets()[1].querySelector('.col > *')!)).toBe(lines[full])
  expect(lefts(reversed.sheets())).toEqual([second, first])
})

it('counts the page at the head of the frame, where a step puts one, however short its pages', async () => {
  const lines = Array.from({ length: 30 }, (_, line) => `Line ${line}`)
  const short = drawing(lines.map(line => paragraph(line)), { page: { width: 600, height: 150 } })
  const { sheets } = await draw({ drawing: short })
  const view = frame!.contentDocument!.scrollingElement!
  const pager = frame!.contentDocument!.getElementById('pager')!
  const [previous, next] = [...pager.querySelectorAll('button')]
  const reading = () => pager.getAttribute('aria-label')
  const count = sheets().length

  // Two pages start in the upper half of the frame, and the first is the one being read.
  expect(sheets()[1].getBoundingClientRect().top).toBeLessThan(view.clientHeight / 2)
  await expect.poll(reading).toBe(`Page 1 of ${count}`)
  expect(previous.disabled).toBe(true)
  next.click()
  await expect.poll(reading).toBe(`Page 2 of ${count}`)
  previous.click()
  await expect.poll(reading).toBe(`Page 1 of ${count}`)

  // The last page is too short to reach the head of the frame, and is read at the document's foot.
  await expect.poll(() => {
    // Asked for until the step back before it has come to rest.
    view.scrollTo(0, view.scrollHeight)
    return reading()
  }).toBe(`Page ${count} of ${count}`)
  expect(next.disabled).toBe(true)

  // A step back from there is to the last page that can come to the head of the frame, as the
  // ones under it cannot, and the next step is to the page before that one.
  const head = () => sheets().findIndex(sheet => Math.round(sheet.getBoundingClientRect().top) === 52)
  previous.click()
  await expect.poll(head).toBeGreaterThan(0)
  const stepped = head()
  await expect.poll(reading).toBe(`Page ${stepped + 1} of ${count}`)
  previous.click()
  await expect.poll(reading).toBe(`Page ${stepped} of ${count}`)
})

it('folds one of two headings of the same name, and keeps the keyboard on its arrow', async () => {
  await draw({ drawing: drawing([heading('Results'), heading('First', 2), heading('Results'), heading('Second', 2)]) })
  const rows = () => [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#rail .row')]
  const arrows = () => [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#rail .fold')]

  // Nothing hidden holds the keyboard, and the frame is too narrow for the outline to stand open.
  if (frame!.contentDocument!.getElementById('outline')!.hidden) frame!.contentDocument!.getElementById('outline-toggle')!.click()
  arrows()[1].focus()
  arrows()[1].click()

  expect(rows().map(row => [text(row), row.hidden])).toEqual(
    [['Results', false], ['First', false], ['Results', false], ['Second', true]])
  expect(frame!.contentDocument!.activeElement).toBe(arrows()[1])
})

it('stands the page navigator above the card for a change that waits on a tab not shown', async () => {
  const { refresh } = await draw({ tabs: ['t.0', 't.1'] })
  const lifted = () => frame!.contentDocument!.body.classList.contains('waiting')
  expect(lifted()).toBe(false)

  await refresh({ edited: ['t.1'] })
  await expect.poll(lifted).toBe(true)
  await refresh({ edited: [] })
  await expect.poll(lifted).toBe(false)
})

it('opens on the first tab with changes waiting, and marks each that has them', async () => {
  const { page } = await draw({ tabs: ['t.0', 't.1', 't.2'], edited: ['t.1', 't.2'] })
  const buttons = [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')]

  expect(text(page)).toBe('t.1Edited')
  expect(buttons.map(button => [button.title, getComputedStyle(button, '::after').content])).toEqual(
    [['Tab 1', 'none'], ['Tab 2 (has pending edits)', '"Edited"'], ['Tab 3 (has pending edits)', '"Edited"']])
})

/** A first-level heading the drawing names, as a link to it or a reader's spot does. */
const named = (name: string, more: More = {}) => heading(name, 1, { headingId: `h.${name.toLowerCase()}`, ...more })
/** More lines than the frame shows at once. */
const lines = () => Array.from({ length: 55 }, (_, line) => paragraph(`Line ${line}`))
/** A tab of three named headings, a frame or more apart. */
const sectioned = () => drawing([named('Intro'), paragraph('Old text'), ...lines(), named('Middle'), ...lines(), named('Last'), paragraph('End')])
const MIDDLE = { anchor: '?tab=t.0#heading=h.middle', label: 'Middle' }
const LAST = { anchor: '?tab=t.0#heading=h.last', label: 'Last' }

it('tells its host the heading the reader is under, and goes to one its host names', async () => {
  // Its host sends it to the heading the reader left, which it opens on, not on its first change.
  const { page, said, go } = await draw({ drawing: sectioned(), edits: [edit(1, 2, [written('New text')])] }, {}, MIDDLE.anchor)
  const top = (level: number) => Math.round(page.querySelectorAll('[aria-level="1"]')[level].getBoundingClientRect().top)

  await expect.poll(() => said.at(-1)).toEqual(MIDDLE)
  expect(top(1)).toBeLessThan(60)
  // The scroll to the first change, which a tab opens with, has not carried it off.
  await new Promise(done => setTimeout(done, 500))
  expect([said.at(-1), top(1) < 60]).toEqual([MIDDLE, true])

  // At the foot of the tab the last heading is the one read, though it scrolls no higher.
  expect(await go(LAST.anchor)).toBe(true)
  await expect.poll(() => said.at(-1)).toEqual(LAST)
  // Above its first heading, a document of one tab has no spot to tell of.
  frame!.contentWindow!.scrollTo(0, 0)
  await expect.poll(() => said.at(-1)).toBeNull()
  expect(await go('?tab=t.0#heading=h.intro')).toBe(true)
  expect(said.at(-1)).toEqual({ anchor: '?tab=t.0#heading=h.intro', label: 'Intro' })

  // A heading or a tab that is not there leaves the reader where they are.
  expect([await go('?tab=t.0#heading=h.gone'), await go('?tab=t.9'), await go('nowhere')]).toEqual([false, false, false])
  expect(top(0)).toBeGreaterThan(0)
})

it('tells its host only what Google has saved: a heading by its saved words, and no heading or tab that only a change makes', async () => {
  // A change rewrites the middle heading, which keeps its ID, and adds one after it. The session
  // gives a heading it adds no ID, or the ID of the one it was split from: a new one is a fork's.
  const { page, said, go } = await draw({
    drawing: sectioned(),
    edits: [edit(57, 58, [written('Middle rewritten', { style: 'HEADING_1' }), written('Brand new', { style: 'HEADING_1', headingId: 'h.new' })])],
  }, {}, MIDDLE.anchor)
  const headings = () => [...page.querySelectorAll<HTMLElement>('[data-heading]')]

  expect(headings().map(found => [found.dataset.heading, text(found)])).toEqual(
    [['h.intro', 'Intro'], ['h.middle', 'Middle rewritten'], ['h.new', 'Brand new'], ['h.last', 'Last']])
  await expect.poll(() => said.at(-1)).toEqual(MIDDLE)
  // Under the heading the change adds, the last one Google has is still the one told.
  expect(await go('?tab=t.0#heading=h.new')).toBe(true)
  expect(Math.round(headings()[2].getBoundingClientRect().top)).toBeLessThan(60)
  await new Promise(done => setTimeout(done, 300))
  expect(said.at(-1)).toEqual(MIDDLE)
  frame!.remove()

  // A tab still to be added is nowhere its host can be told of.
  const tabbed = await draw({ tabs: ['t.0', 'pending-tab-1'], titles: ['Notes', 'Plan'] }, {}, '?tab=t.0')
  expect(tabbed.said).toEqual([{ anchor: '?tab=t.0', label: 'Notes' }])
  expect(await tabbed.go('?tab=pending-tab-1')).toBe(true)
  expect(text(tabbed.page)).toBe('pending-tab-1')
  expect(tabbed.said.at(-1)).toBeNull()
})

it('tells its host a heading by the words of a chip in it too', async () => {
  const dated = paragraph([{ text: 'Sync ', look: HEADING }, { chip: 'Nov 25, 2026', look: HEADING }], { style: 'HEADING_1', look: HEADING, headingId: 'h.date' })
  const anchor = '?tab=t.0#heading=h.date'
  const { said } = await draw({ drawing: drawing([named('Intro'), ...lines(), dated, ...lines()]) }, {}, anchor)
  await expect.poll(() => said.at(-1)).toEqual({ anchor, label: 'Sync Nov 25, 2026' })
})

it('goes to the heading its host names once a read that failed is tried again, and stays on it though others follow close under it', async () => {
  // Headings as small as the text, so three are within sight of the head of the frame.
  const small = (name: string) => named(name, { look: NORMAL })
  let reads = 0
  const { page, said } = await draw(
    { drawing: drawing([small('Intro'), ...lines(), small('One'), small('Two'), small('Three'), ...lines()]) },
    { listTabs: async () => reads++ ? [{ id: 't.0', title: 'Tab 1', index: 0, nestingLevel: 0 }] : Promise.reject(new Error('Google is away')) },
    '?tab=t.0#heading=h.one')
  expect(said).toEqual([])

  frame!.contentDocument!.querySelector<HTMLElement>('#error button')!.click()
  const one = { anchor: '?tab=t.0#heading=h.one', label: 'One' }
  await expect.poll(() => said).toEqual([one])
  const tops = [...page.querySelectorAll('[aria-level="1"]')].map(found => Math.round(found.getBoundingClientRect().top))
  expect(tops[3]).toBeLessThan(96)
  // Its host would send it back to the same heading: nothing has moved it on to the last of them.
  await new Promise(done => setTimeout(done, 500))
  expect(said).toEqual([one])
})

it('opens on a tab added since its reader left it, which the ID the reader held still reads', async () => {
  // As the session answers for the provisional ID of a tab Google has since been given.
  const read = (asked: string) => ({ tabId: asked === 'pending-tab-1' ? 't.1' : asked, version: 'v1' })
  const { said, blocks } = await draw({ tabs: ['t.0', 't.1'], titles: ['Notes', 'Plan'] }, {
    getPendingChanges: async (asked: string) => ({ ...read(asked), changes: [] }),
    readPendingDrawing: async (asked: string) => ({ ...read(asked), edits: [], ...STATED }),
    readDrawing: async (asked: string) => ({ ...drawing([paragraph(read(asked).tabId)]), version: 'v1' }),
  }, '?tab=pending-tab-1')

  await expect.poll(() => said.at(-1)).toEqual({ anchor: '?tab=t.1', label: 'Plan' })
  expect(blocks().map(text)).toEqual(['t.1'])
})

it('says so while Google Drive opens the file, whose preview draws nothing until then', async () => {
  let open = () => {}
  // The session of a Drive connection, which opens the file when the test lets it.
  const drawn = draw({ drawing: drawing([paragraph('Words')]) }, {}, 'docs:file', file => ({
    openGoogleDoc: () => new Promise(opened => { open = () => opened(file) }),
  }))
  const status = () => frame?.contentDocument?.querySelector('[role=status]')?.textContent

  await expect.poll(status).toBe('Opening file…')
  open()
  await expect.poll(status).toBe('')
  const { blocks } = await drawn
  await expect.poll(() => blocks().map(text)).toEqual(['Words'])
})

it('lets go of what its host answers each time it says where the reader is', async () => {
  const direct = await draw({ tabs: ['t.0', 't.1'], titles: ['Notes', 'Plan'] }, {}, '?tab=t.1')
  await expect.poll(() => direct.said.length).toBeGreaterThan(0)
  expect(direct.held()).toBe(0)
  frame!.remove()

  // The file of a Drive connection says it through the connection's own preview.
  const through = await draw({ drawing: drawing([paragraph('Words')]) }, {}, 'docs:file', file => ({ openGoogleDoc: async () => file }))
  await expect.poll(() => through.said.length).toBeGreaterThan(0)
  expect(through.held()).toBe(0)
})

it('keeps the heading the reader is under when a refresh fails, and the tab stays as it is drawn', async () => {
  let reads = 0
  const { said, go } = await draw({ drawing: sectioned() }, {
    getPendingChanges: async () => reads++ === 1 ? Promise.reject(new Error('Google is away')) : { tabId: 't.0', changes: [] },
  })
  expect(await go(MIDDLE.anchor)).toBe(true)
  await expect.poll(() => said.at(-1)).toEqual(MIDDLE)

  frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
  await expect.poll(() => frame!.contentDocument!.getElementById('missed')!.hidden).toBe(false)
  frame!.contentWindow!.dispatchEvent(new Event('scroll'))
  frame!.contentDocument!.dispatchEvent(new Event('scroll'))
  await new Promise(done => setTimeout(done, 300))
  expect(said.at(-1)).toEqual(MIDDLE)

  // Read again, the tab is where the reading was.
  frame!.contentDocument!.querySelector<HTMLElement>('#missed button')!.click()
  await expect.poll(() => reads).toBe(3)
  await new Promise(done => setTimeout(done, 300))
  expect(frame!.contentDocument!.querySelector('[data-heading="h.middle"]')!.getBoundingClientRect().top).toBeLessThan(100)
  expect(said.at(-1)).toEqual(MIDDLE)
})

it('leaves the reader at the heading they have gone to since, when the read its host sent it with answers last', async () => {
  let answer = () => {}
  let reads = 0
  const { said, go } = await draw({ drawing: sectioned() }, {
    getPendingChanges: async () => {
      // The first read waits, and a refresh starts the one that overtakes it.
      if (!reads++) {
        await new Promise<void>(done => {
          answer = done
          frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
        })
      }
      return { tabId: 't.0', changes: [] }
    },
  }, MIDDLE.anchor)
  await expect.poll(() => said).toEqual([MIDDLE])

  expect(await go(LAST.anchor)).toBe(true)
  await expect.poll(() => said.at(-1)).toEqual(LAST)
  answer()
  await new Promise(done => setTimeout(done, 300))
  expect(said.at(-1)).toEqual(LAST)
})

it('follows a link to a heading of another tab though a refresh overtakes the read of that tab', async () => {
  const drawn: Record<string, object> = {
    't.0': drawing([paragraph([{ text: 'the plan', look: NORMAL, link: '?tab=t.1#heading=h.one' }])]),
    't.1': drawing([named('Intro'), ...lines(), named('One'), ...lines()]),
  }
  let held = false
  let answer = () => {}
  const { page } = await draw({ tabs: ['t.0', 't.1'], titles: ['Notes', 'Plan'] }, {
    readDrawing: async (tabId: string) => {
      // The first read of the tab the link leads to waits, and a refresh starts another.
      if (tabId === 't.1' && !held) {
        held = true
        frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
        await new Promise<void>(done => { answer = done })
      }
      return { ...drawn[tabId], version: 'v1' }
    },
  })

  page.querySelector<HTMLElement>('.link')!.click()
  const top = () => Math.round(frame!.contentDocument!.querySelector('[data-heading="h.one"]')?.getBoundingClientRect().top ?? NaN)
  await expect.poll(top).toBeLessThan(100)

  // The read that waited ends once the reader has moved on, and does not take them back.
  frame!.contentDocument!.scrollingElement!.scrollTop = 0
  answer()
  await new Promise(done => setTimeout(done, 500))
  expect(top()).toBeGreaterThan(600)
})

it('cuts what it tells its host to the length a host takes, at a whole character', async () => {
  // The cut falls between the two halves of the first face.
  const { said } = await draw({ tabs: ['t.0', 't.1'], titles: [`${'a'.repeat(118)}😀😀`, 'Plan'] }, {}, '?tab=t.0')

  expect(said).toEqual([{ anchor: '?tab=t.0', label: `${'a'.repeat(118)}…` }])
})

it('tells its host the tab shown, opens on the one its host names, and on its own choice when that is gone', async () => {
  const titles = ['Notes', 'Plan', 'Costs']
  const tabs = ['t.0', 't.1', 't.2']
  const { page, said, go } = await draw({ tabs, titles, edited: ['t.1'] }, {}, '?tab=t.2')

  expect(text(page)).toBe('t.2')
  expect(said).toEqual([{ anchor: '?tab=t.2', label: 'Costs' }])

  expect(await go('?tab=t.0')).toBe(true)
  expect(text(page)).toBe('t.0')
  expect(said.at(-1)).toEqual({ anchor: '?tab=t.0', label: 'Notes' })
  // The reader's own move is told too.
  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => said.at(-1)).toEqual({ anchor: '?tab=t.1', label: 'Plan' })
  expect(await go('?tab=t.9')).toBe(false)
  expect(text(page)).toBe('t.1Edited')
  frame!.remove()

  // Sent to a tab that is gone, it opens where it would have: on the first with changes waiting.
  const anew = await draw({ tabs, titles, edited: ['t.1'] }, {}, '?tab=t.9')
  expect(text(anew.page)).toBe('t.1Edited')
  expect(anew.said).toEqual([{ anchor: '?tab=t.1', label: 'Plan' }])
})
