// The Google Doc preview client, run in a same-origin frame with a scripted session so its drawing
// can be read. ConnectionPreviewPane's test runs it in the real sandbox, where it cannot.

import { afterEach, expect, it } from 'vitest'
import { prepareUiPage } from '@gadgets/workshop-shared/ui-page'
import { DOCS_PREVIEW_BUNDLE } from './docsPreviewBundle'

type Doc = {
  savedMarkdown: string, markdown?: string, revisionId?: string, drawing?: object, tabs?: string[], titles?: string[]
  /** The tabs that have changes waiting. */
  edited?: string[]
}

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

// What ends every paragraph, so an empty one is a line high.
const text = (element: Element) => element.textContent!.replaceAll('⁠', '')

/**
 * Draws `doc` and resolves to the frame's document once the page has its blocks. What `session`
 * holds answers in place of the scripted session's own.
 */
async function draw(doc: Doc, session: { [method: string]: (...given: never[]) => Promise<unknown> } = {}) {
  const fonts: [string, number, boolean][] = []
  const gadget = {
    // No font is served here: each is asked for, and the text is drawn without.
    readFont: async (...font: [string, number, boolean]) => {
      fonts.push(font)
      throw new Error('no such font')
    },
    listTabs: async () => (doc.tabs ?? ['t.0']).map((id, index) =>
      ({ id, title: doc.titles?.[index] ?? `Tab ${index + 1}`, index, nestingLevel: 0, ...doc.edited?.includes(id) && { pending: true } })),
    getPendingChanges: async (tabId: string) => {
      if (!(doc.tabs ?? ['t.0']).includes(tabId)) throw new Error(`no tab with ID "${tabId}"`)
      // With several tabs, each reads as its own ID.
      const savedMarkdown = doc.tabs ? `${tabId}\n` : doc.savedMarkdown
      return { changes: [], markdown: savedMarkdown, ...doc, savedMarkdown }
    },
    // A tab with no drawing here is drawn from its Markdown, in Google's own styles.
    readDrawing: async () => doc.drawing ?? Promise.reject(new Error('no drawing')),
    readImage: async () => Promise.reject(new Error('no image')),
    ...session,
  }
  Object.assign(window, { docsPreviewGadget: gadget })
  frame = document.body.appendChild(document.createElement('iframe'))
  Object.assign(frame.style, { width: '900px', height: '600px' })
  // Started as the gadget UI frame starts it: main(gadget) on the module's default export.
  const { entryUrl, importMap } = prepareUiPage(DOCS_PREVIEW_BUNDLE, '')
  frame.srcdoc = `<body><script type="importmap">${importMap}</script><script type="module">
    import client from ${JSON.stringify(entryUrl)}
    client.main(parent.docsPreviewGadget)
  </script>`
  const page = () => frame!.contentDocument?.getElementById('page')
  await expect.poll(() => page() && !page()!.hasAttribute('aria-busy')).toBe(true)
  const blocks = () => [...page()!.querySelectorAll<HTMLElement>('.col > *')]
  return {
    page: page()!,
    /** The fonts asked for, in order: family, weight and whether italic. */
    fonts,
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

/** A tab's drawing: a small page with `blocks` on it, in a handful of looks. */
const drawing = (blocks: object[], more: object = {}) => ({
  page: { width: 600, height: 400 },
  sections: [{ margins: { top: 40, right: 50, bottom: 40, left: 50, header: 10, footer: 10 } }],
  blocks, headers: {}, footers: {}, footnotes: {}, lists: {}, objects: {},
  paragraphLooks: [{ lineSpacing: 1 }, { lineSpacing: 1, alignment: 'center' }, { lineSpacing: 1 }, { lineSpacing: 1, spaceAbove: 20 }],
  textLooks: [
    ARIAL,
    { ...ARIAL, fontSize: 26, color: '#4a86e8' },
    { ...ARIAL, fontFamily: 'Consolas', color: '#880000' },
    { ...ARIAL, fontSize: 20, weight: 700 },
    { ...ARIAL, fontSize: 24 },
  ],
  named: {
    NORMAL_TEXT: { paragraph: NORMAL, text: NORMAL },
    TITLE: { paragraph: TITLE, text: TITLE },
    HEADING_1: { paragraph: HEADING, text: HEADING },
  },
  ...more,
})

type Run = { text: string, look: number, at?: number }

/** A paragraph of a drawing, on `line` of the saved Markdown: its runs, or text in one look. */
const paragraph = (line: number | undefined, runs: string | Run[] | object[], more: { look?: number, style?: string, [more: string]: unknown } = {}) => ({
  type: 'paragraph', line, style: 'NORMAL_TEXT', look: more.look ?? NORMAL, end: more.look ?? NORMAL,
  runs: typeof runs === 'string' ? [{ text: runs, look: more.look ?? NORMAL, at: 0 }] : runs,
  ...more,
})

const SAVED = [
  '# Report', '', 'plain code plain', '',
  '<table>', '  <tr>', '    <td><p>Head</p></td>', '    <td><p>Body</p></td>', '  </tr>', '</table>', '',
].join('\n')
const CELL = { padding: [5, 5, 5, 5], borders: {} }
const DRAWN = drawing([
  paragraph(0, [{ text: 'Report', look: TITLE, at: 2 }], { style: 'TITLE', look: TITLE }),
  paragraph(2, [{ text: 'plain ', look: NORMAL, at: 0 }, { text: 'code', look: CODE, at: 6 }, { text: ' plain', look: NORMAL, at: 10 }]),
  {
    type: 'table', line: 4, columns: [100, 300],
    rows: [{ cells: [
      { ...CELL, column: 0, background: '#d9ead3', blocks: [paragraph(undefined, 'Head', { look: TITLE })] },
      { ...CELL, column: 1, borders: { bottom: { width: 1, color: '#000000' } }, blocks: [paragraph(undefined, 'Body')] },
    ] }],
  },
])

/** The run of `block` that reads `words`. */
const run = (block: Element, words: string) =>
  [...block.querySelectorAll('span, ins, del, a')].find(found => text(found).trim() === words)!

it('draws each paragraph, run and table cell as the tab\'s drawing sets it', async () => {
  const { blocks, look } = await draw({ savedMarkdown: SAVED, drawing: DRAWN })
  const [title, body, table] = blocks()

  // The title is a first-level heading in Markdown, and is set as the title it is.
  expect(title.getAttribute('aria-level')).toBe('1')
  expect(title.style.textAlign).toBe('center')
  expect(look(run(title, 'Report')).color).toBe(BLUE)
  expect(parseFloat(look(run(title, 'Report')).fontSize)).toBeCloseTo(26 * POINT, 1)

  expect(look(run(body, 'code')).color).toBe(RED)
  expect(look(run(body, 'code')).fontFamily).toContain('Consolas')
  expect(text(body)).toBe('plain code plain')

  const [head, cell] = table.querySelectorAll('td')
  expect(look(head).backgroundColor).toBe('rgb(217, 234, 211)')
  expect(look(head.firstElementChild!).textAlign).toBe('center')
  expect([look(cell).borderTopStyle, look(cell).borderBottomStyle]).toEqual(['none', 'solid'])
  expect([...table.querySelectorAll('col')].map(column => column.style.width)).toEqual(['100pt', '300pt'])
})

it('sets a table, its rows and the paragraphs in them where Google Docs does', async () => {
  const edge = { width: 1, color: '#000000' }
  const cell = (column: number, block: object, padding = [0, 5.4, 0, 5.4]) =>
    ({ padding, borders: { top: edge, right: edge, bottom: edge, left: edge }, column, blocks: [block] })
  const markup = ['<table>', ...['Same', 'Same', 'Padded'].flatMap(words =>
    ['  <tr>', `    <td><p>${words}</p></td>`, '    <td><p></p></td>', '  </tr>']), '</table>'].join('\n')
  // As one brought in from Word is: wider than the 500pt column, with no padding over or under its text.
  const { blocks } = await draw({
    savedMarkdown: `${markup}\n`,
    drawing: drawing([{
      type: 'table', line: 0, columns: [300, 220],
      rows: [
        { cells: [cell(0, paragraph(undefined, 'Same', { look: TITLE, end: NORMAL })), cell(1, paragraph(undefined, []))] },
        // Ending in spaces, and in an end larger than its text.
        { cells: [cell(0, paragraph(undefined, [{ text: 'Same   ', look: TITLE }], { look: TITLE, end: LARGE })), cell(1, paragraph(undefined, []))] },
        { cells: [cell(0, paragraph(undefined, 'Padded'), [5, 5, 5, 5]), cell(1, paragraph(undefined, []), [5, 5, 5, 5])] },
      ],
    }]),
  })
  const [table] = blocks()
  const box = (element: Element) => element.getBoundingClientRect()
  const scale = box(table).width / table.offsetWidth

  // Its first cell's text starts where the column does: the table a border and a padding before it.
  expect((box(table).left - box(table.parentElement!).left) / scale).toBeCloseTo(-8, 1)
  const [first, spaced, padded] = [...table.querySelectorAll('tr')]
  // The spaces a paragraph ends in do not move its text, and its end does not make its line taller.
  expect(box(run(spaced, 'Same')).left).toBeCloseTo(box(run(first, 'Same')).left, 1)
  expect(box(spaced).height).toBeCloseTo(box(first).height, 1)
  // A row is a whole number of pixels tall: a line of 18, 5pt over and under it, and a border.
  expect(box(padded).height / scale).toBeCloseTo(33, 1)
})

it('shows the tab as its changes leave it, as it is saved, or with each change marked in place', async () => {
  const { blocks, look, refresh, show } = await draw({ savedMarkdown: SAVED, drawing: DRAWN })
  const views = frame!.contentDocument!.querySelector<HTMLElement>('.views')!
  // A tab with nothing pending has one copy.
  expect(views.hidden).toBe(true)

  await refresh({ markdown: SAVED.replace('plain code plain', 'plainer code plain\n\n# Added') })
  await expect.poll(() => blocks().some(block => block.classList.contains('changed'))).toBe(true)
  expect(views.hidden).toBe(false)
  const changed = () => blocks().find(block => block.classList.contains('changed'))!

  // As it will be: what was removed takes no room, and is a mark where it was.
  expect(text(changed())).toBe('plainer code plain')
  expect(changed().querySelector('ins')!.textContent).toBe('plainer')
  expect(changed().querySelector('.tick')!.getAttribute('aria-label')).toBe('Removed here: “plain”')
  // A word the edit keeps stays in its run's look.
  expect(look(run(changed(), 'code')).color).toBe(RED)
  // A new heading has no saved paragraph to take after, so it is a Heading 1, not the title.
  const added = blocks().find(block => block.classList.contains('added'))!
  expect(text(added)).toBe('Added')
  expect(parseFloat(look(run(added, 'Added')).fontSize)).toBeCloseTo(20 * POINT, 1)
  expect(look(run(added, 'Added')).fontWeight).toBe('700')
  expect(added.style.textAlign).toBe('')

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

it('sets the body on as many sheets as it fills, each under the header with its page\'s number', async () => {
  const lines = Array.from({ length: 40 }, (_, line) => `Line ${line}`)
  const header = paragraph(undefined, [{ text: 'Page ', look: NORMAL }, { field: 'pageNumber', look: NORMAL }, { text: ' of ', look: NORMAL }, { field: 'pageCount', look: NORMAL }])
  const paged = drawing(lines.map((line, index) => paragraph(index * 2, line)), {
    sections: [{ margins: { top: 40, right: 50, bottom: 40, left: 50, header: 10, footer: 10 }, header: 'h', footer: 'f' }],
    headers: { h: [header] },
    footers: { f: [paragraph(undefined, 'Foot')] },
  })
  const { sheets, blocks } = await draw({ savedMarkdown: `${lines.join('\n\n')}\n`, drawing: paged })

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

// Either was carried on from every page, without end.
it.each([
  ['a row it repeats that is taller than a page', [{ words: 'Head', header: true, minHeight: 400 }, { words: 'One' }, { words: 'Two' }]],
  ['a paragraph kept whole that is taller than a page', [{ words: 'Long '.repeat(600).trim() }, { words: 'After' }]],
])('ends a table with %s, and draws each row once', async (_name, rows) => {
  const table = {
    type: 'table', line: 0, columns: [120],
    rows: rows.map(({ words, ...row }) => ({ ...row, cells: [{ ...CELL, column: 0, blocks: [paragraph(undefined, words)] }] })),
  }
  const markup = ['<table>', ...rows.flatMap(({ words }) => ['  <tr>', `    <td><p>${words}</p></td>`, '  </tr>']), '</table>', '']
  const { sheets, page } = await draw({
    savedMarkdown: markup.join('\n'),
    drawing: drawing([table], { paragraphLooks: Array.from({ length: 4 }, () => ({ lineSpacing: 1, keepLinesTogether: true })) }),
  })

  expect(sheets()).toHaveLength(2)
  const cells = [...page.querySelectorAll('td')].map(cell => text(cell).replace(/\s+/g, ' ').trim())
  expect(cells.filter(Boolean)).toEqual(rows.map(({ words }) => words))
})

it('sets each line as tall as Google Docs does in any font, with the larger space between two paragraphs', async () => {
  const lines = ['Body', 'Code', 'Large heading', 'Small heading', 'Body', 'Two\u000blines']
  const set = drawing(lines.map((line, index) => paragraph(index * 2, line, { look: [0, 1, 2, 3, 0, 4][index] })), {
    paragraphLooks: [
      { lineSpacing: 1.15 }, { lineSpacing: 1.15 }, { lineSpacing: 1.15, spaceAbove: 24, spaceBelow: 6 },
      { lineSpacing: 1.15, spaceAbove: 14, spaceBelow: 4 }, { lineSpacing: 1.4, spaceAbove: 10 },
    ],
    textLooks: [ARIAL, { ...ARIAL, fontFamily: 'Consolas' }, { ...ARIAL, fontSize: 18, weight: 700 }, { ...ARIAL, fontSize: 12, weight: 700 }, ARIAL],
  })
  const { blocks } = await draw({ savedMarkdown: `${lines.join('\n\n')}\n`, drawing: set })

  // As Google Docs draws them. A line is 1.18 of its size times its spacing, rounded up with the
  // space it carries: 11pt at 1.15 is 20px. The large heading gives the space under it up to the
  // larger one over the small heading, whose one line has the space over and under it; and of two
  // lines only the first has the space over them.
  expect(blocks().map(block => block.offsetHeight)).toEqual([20, 20, 65, 46, 20, 38 + 25])
})

it('ends no line at a hyphen inside a word', async () => {
  // Wide enough that the line ends inside the last word or before it, in whatever font stands in.
  const words = `${'x '.repeat(36)}${'a'.repeat(20)}-${'b'.repeat(20)}`
  const { blocks } = await draw({ savedMarkdown: `${words}\n`, drawing: drawing([paragraph(0, words)]) })
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
})

it('keeps the images of a paragraph a pending change edits, and wraps its text round one tethered to it', async () => {
  const savedMarkdown = '[Image] Beside [Image] the picture\n'
  const pictured = drawing([paragraph(0, [
    { text: 'Beside ', look: NORMAL, at: 8 }, { object: 'inline', look: NORMAL }, { text: ' the picture', look: NORMAL, at: 22 },
  ], { objects: ['tethered'] })], {
    objects: {
      tethered: { width: 100, height: 60, readable: true, placed: { left: 0, top: 0, layout: 'wrap' } },
      inline: { width: 20, height: 10, readable: true },
    },
  })
  const { blocks, look } = await draw({ savedMarkdown, markdown: savedMarkdown.replace('picture', 'photograph'), drawing: pictured })
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
  const set = drawing([paragraph(0, 'Words')], {
    textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }, { ...ARIAL, fontFamily: 'Open Sans', weight: 700 }, ARIAL],
  })
  const { fonts } = await draw({ savedMarkdown: 'Words\n', drawing: set })

  await expect.poll(() => fonts).toEqual([['Open Sans', 400, false], ['Open Sans', 700, false]])
})

it('asks again, after a while, for a font that could not be read', async () => {
  const set = drawing([paragraph(0, 'Words')], { textLooks: [{ ...ARIAL, fontFamily: 'Open Sans' }] })
  const later: (() => void)[] = []
  let asked = 0
  const { refresh } = await draw({ savedMarkdown: 'Words\n', drawing: set }, {
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
  await refresh({ markdown: 'Words\n\nMore\n' })
  await expect.poll(() => asked).toBe(2)
})

it('draws a tab again once it is saved anew, though its Markdown reads the same', async () => {
  const set = (fontSize: number) => drawing([paragraph(0, 'Words')], { textLooks: [{ ...ARIAL, fontSize }] })
  const { blocks, look, refresh } = await draw({ savedMarkdown: 'Words\n', drawing: set(11), revisionId: 'a' })
  const size = () => parseFloat(look(run(blocks()[0], 'Words')).fontSize)

  // A drawing is kept for as long as the document is the one it was read of.
  await refresh({ drawing: set(20), markdown: 'Words\n\nMore\n' })
  await expect.poll(() => blocks().length).toBe(2)
  expect(size()).toBeCloseTo(11 * POINT, 1)

  await refresh({ revisionId: 'b' })
  await expect.poll(size).toBeCloseTo(20 * POINT, 1)
})

it('draws a tab from its Markdown when its drawing is of another document', async () => {
  // The first line is a heading in the Markdown and plain text in the drawing.
  const other = { ...DRAWN, blocks: [paragraph(0, 'Report'), ...DRAWN.blocks.slice(1)] }
  const { blocks, look } = await draw({ savedMarkdown: SAVED, drawing: other })
  const [title, body] = blocks()

  expect(parseFloat(look(run(title, 'Report')).fontSize)).toBeCloseTo(20 * POINT, 1)
  expect(look(run(body, 'plain code plain')).color).not.toBe(RED)
})

it('draws a paragraph that starts as a heading is written as the text it is, and the tab from its drawing', async () => {
  const savedMarkdown = ['# Report', '', '- # of rows', '', ...SAVED.split('\n').slice(4)].join('\n')
  const set = { ...DRAWN, blocks: [DRAWN.blocks[0], paragraph(2, [{ text: '# of rows', look: CODE, at: 2 }]), DRAWN.blocks[2]] }
  const { blocks, look, refresh } = await draw({ savedMarkdown, drawing: set })
  const [, item, table] = blocks()

  expect(text(item)).toBe('# of rows')
  expect(look(run(item, '# of rows')).color).toBe(RED)
  expect(table.matches('table')).toBe(true)
  const entries = () => [...frame!.contentDocument!.querySelectorAll('#rail .entry')].map(text)
  expect(entries()).toEqual(['Report'])

  // A pending change leaves the line as it is: it is not one the change wrote.
  await refresh({ markdown: `${savedMarkdown}\nMore\n` })
  await expect.poll(() => blocks().length).toBe(4)
  expect(blocks()[1].classList.contains('changed')).toBe(false)
  expect(entries()).toEqual(['Report'])
})

it('draws a tab in Google\'s own styles when its drawing cannot be read', async () => {
  const { blocks, look } = await draw({ savedMarkdown: '# Report\n\nWords\n' })
  const [title, body] = blocks()

  expect(title.getAttribute('aria-level')).toBe('1')
  expect(parseFloat(look(run(title, 'Report')).fontSize)).toBeCloseTo(20 * POINT, 1)
  expect(parseFloat(look(run(body, 'Words')).fontSize)).toBeCloseTo(11 * POINT, 1)
})

it('draws one empty paragraph for each the tab has, at its start and end as between blocks', async () => {
  // As the converter writes an empty paragraph first, between two paragraphs, and last.
  const { blocks } = await draw({ savedMarkdown: '\n\nFirst\n\n\n\nSecond\n\n\n' })

  expect(blocks().map(text)).toEqual(['', 'First', '', 'Second', ''])
  // An empty paragraph is as high as a line of text.
  const heights = blocks().map(block => Math.round(block.getBoundingClientRect().height))
  expect(new Set(heights).size).toBe(1)
})

it('leaves out a paragraph an empty one is written over, where the changes are shown made', async () => {
  const { blocks, show } = await draw({
    savedMarkdown: 'First\n\nGoing\n\nLast\n',
    markdown: 'First\n\n\n\nLast\n',
    drawing: drawing([paragraph(0, 'First'), paragraph(2, 'Going'), paragraph(4, 'Last')]),
  })
  expect(blocks().map(text).filter(Boolean)).toEqual(['First', 'Last'])

  show('As saved')
  expect(blocks().map(text).filter(Boolean)).toEqual(['First', 'Going', 'Last'])
})

it('marks what was put in beside a word, not the word, and draws a line break a paragraph holds', async () => {
  const savedMarkdown = 'Open to all users today.\n\n- one\u000b\n- two\n'
  const { blocks, refresh } = await draw({ savedMarkdown })
  const [, one, two] = blocks()
  // The break that ends the first item leaves a line under it.
  expect(one.getBoundingClientRect().height).toBeGreaterThan(two.getBoundingClientRect().height * 1.5)

  await refresh({ markdown: savedMarkdown.replace('users', 'users, and every embedder,') })
  await expect.poll(() => blocks().some(block => block.classList.contains('changed'))).toBe(true)

  const changed = blocks().find(block => block.classList.contains('changed'))!
  expect(changed.querySelector('.tick')).toBeNull()
  expect([...changed.querySelectorAll('ins')].map(node => node.textContent).join('')).toBe(', and every embedder,')
})

it('starts a new sheet at a page break the tab has, and draws one a pending change names as the text it writes', async () => {
  const savedMarkdown = 'Before\n\n\\[Page break\\]\n\nAfter\n'
  const { sheets, refresh, show } = await draw({ savedMarkdown })
  const pages = () => sheets().map(sheet => text(sheet.querySelector('.area')!))
  expect(pages()).toEqual(['Before', 'After'])
  // A paragraph that ends in its page break leaves no line of itself on the next sheet.
  expect(sheets()[1].querySelectorAll('.col > *')).toHaveLength(1)

  // Google is sent these names as text: no pending change can make a page break or an image.
  await refresh({ markdown: 'Before\n\n\\[Page break\\]\n\nAfter [Image]\n\n\\[Page break\\]\n\nLast\n' })
  await expect.poll(pages).toEqual(['Before', 'After [Image][Page break]Last'])
  expect(sheets()[1].querySelector('.obj, .chip')).toBeNull()
  // As saved, the tab ends where it did.
  show('As saved')
  expect(pages()).toEqual(['Before', 'After'])
  // With each change in place there is one sheet, as long as the tab.
  show('Inline')
  expect(sheets()).toHaveLength(1)
  expect(sheets()[0].querySelectorAll('.pagebreak')).toHaveLength(1)
})

it('draws a rule the tab has, and one a pending change names as the text it writes', async () => {
  const { page, blocks, refresh } = await draw({ savedMarkdown: 'Above\n\n<hr>\n\nBelow\n' })
  expect(blocks()[1].querySelector('.rule')).not.toBeNull()

  // Google is sent the name as text, in a paragraph changed as in one added: no pending change can make a rule.
  await refresh({ markdown: 'Above\n\n<hr>\n\nBelow <hr> it\n\nUse <hr> here\n' })
  await expect.poll(() => blocks().slice(2).map(text)).toEqual(['Below <hr> it', 'Use <hr> here'])
  expect(page.querySelectorAll('.rule')).toHaveLength(1)
})

it('steps from page to page with a navigator at the foot of the frame, where there are pages', async () => {
  const savedMarkdown = 'One\n\n\\[Page break\\]\n\nTwo\n\n\\[Page break\\]\n\nThree\n'
  const { sheets, refresh, show } = await draw({ savedMarkdown })
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
  await refresh({ markdown: `${savedMarkdown}\nMore\n` })
  await expect.poll(() => sheets()[2]?.textContent).toContain('More')
  show('Inline')
  expect(pager.hidden).toBe(true)
  show('With changes')
  expect(pager.hidden).toBe(false)
})

it('lists the tabs again on a refresh, and leaves a tab that has gone for the first', async () => {
  const { page, refresh } = await draw({ savedMarkdown: '', tabs: ['t.0', 'pending-tab-1'] })
  const buttons = () => [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')]
  // The tab still to be added is marked as new.
  expect(buttons().map(button => [button.title, getComputedStyle(button, '::after').content])).toEqual(
    [['Tab 1', 'none'], ['Tab 2 (new, not yet added)', '"New"']])
  buttons()[1].click()
  await expect.poll(() => text(page)).toBe('pending-tab-1')

  // The tab's add was discarded.
  await refresh({ tabs: ['t.0'] })

  await expect.poll(() => text(page)).toBe('t.0')
  expect(buttons()).toHaveLength(0)
  expect(frame!.contentDocument!.getElementById('error')).toBeNull()
})

it('stays on an added tab once Google has it, though another tab has its title', async () => {
  const titles = ['Notes', 'Notes']
  const { page, refresh } = await draw({ savedMarkdown: '', tabs: ['t.0', 'pending-tab-1'], titles })
  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => text(page)).toBe('pending-tab-1')

  await refresh({ tabs: ['t.0', 't.1'], titles })

  await expect.poll(() => text(page)).toBe('t.1')
})

it('lists the headings in an outline, marks a section that holds a change, and scrolls to one', async () => {
  const filler = Array.from({ length: 55 }, (_, line) => `Line ${line}`).join('\n\n')
  const savedMarkdown = `# Intro\n\n${filler}\n\n## Details\n\nOld text\n\n# Last\n\nEnd\n`
  const { page } = await draw({ savedMarkdown, markdown: savedMarkdown.replace('Old text', 'New text') })
  const outline = frame!.contentDocument!.getElementById('outline')!
  const entries = () => [...outline.querySelectorAll<HTMLElement>('#rail .entry')]

  // The frame is too narrow for the outline to stand beside the page, so it starts closed.
  expect(outline.hidden).toBe(true)
  frame!.contentDocument!.getElementById('outline-toggle')!.click()

  expect(entries().map(entry => entry.textContent)).toEqual(['Intro', 'Details', 'Last'])
  expect(entries().map(entry => entry.title)).toEqual(['Intro', 'Details (has pending edits)', 'Last'])
  expect(entries().map(entry => entry.parentElement!.style.paddingLeft)).toEqual(['0px', '12px', '0px'])

  entries()[1].click()
  const details = page.querySelector('[aria-level="2"]')!
  // Clear of the controls that float over the top of the page.
  await expect.poll(() => Math.round(details.getBoundingClientRect().top)).toBeLessThan(60)
  expect(outline.hidden).toBe(true)
})

it('colors the dot on a section by what its changes do, in every copy of the tab', async () => {
  const savedMarkdown = [
    '# Grow', 'Kept', '# Shrink', 'Going', '# Edit', 'Old words', '# Mixed', 'Stays', 'Leaving', '# Words', 'One two three', '# Plain', 'Same',
  ].join('\n\n')
  const markdown = savedMarkdown.replace('Kept', 'Kept\n\nArrived').replace('\n\nGoing', '').replace('Old words', 'New words')
    .replace('Stays\n\nLeaving', 'Arriving\n\nStays').replace('One two three', 'One three')
  const { show } = await draw({ savedMarkdown: `${savedMarkdown}\n`, markdown: `${markdown}\n` })
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
  const filler = Array.from({ length: 60 }, (_, line) => `Line ${line}`).join('\n\n')
  const savedMarkdown = `# Intro\n\n${filler}\n\n## Details\n\nOld text\n\n# Last\n\nEnd\n`
  const { page } = await draw({ savedMarkdown, markdown: savedMarkdown.replace('Old text', 'New text') })
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
  const filler = Array.from({ length: 55 }, (_, line) => `Line ${line}`).join('\n\n')
  const savedMarkdown = `# Intro\n\nSee [the end](#heading=h.last) or [the web](https://example.com/) or [a mark](?tab=t.0#bookmark=id.x) or [a slip](#heading=%).\n\n${filler}\n\n# Last\n\nEnd\n`
  const heading = (name: string, headingId: string) => paragraph(savedMarkdown.split('\n').indexOf(`# ${name}`),
    [{ text: name, look: HEADING, at: 2 }], { style: 'HEADING_1', look: HEADING, headingId })
  const { page, look } = await draw({ savedMarkdown, drawing: drawing([heading('Intro', 'h.intro'), heading('Last', 'h.last')]) })
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

it('keeps an asterisk that stands alone as the document\'s text, and a run\'s look to its own characters', async () => {
  const savedMarkdown = 'Calculate 2 * 3 * 4 and *stress* it\n\nPrice: (USD)100\n'
  const priced = drawing([paragraph(2, [
    { text: 'Price: (', look: NORMAL, at: 0 }, { text: 'USD', look: CODE, at: 8 }, { text: ')100', look: NORMAL, at: 11 },
  ])])
  const { blocks, look } = await draw({ savedMarkdown, markdown: savedMarkdown.replace('Price', 'Cost'), drawing: priced })
  const [sum, price] = blocks()
  const runs = (block: Element) => [...block.querySelectorAll('span, ins')]

  expect(text(sum)).toBe('Calculate 2 * 3 * 4 and stress it')
  expect(runs(sum).filter(found => look(found).fontStyle === 'italic').map(text)).toEqual(['stress'])
  // The run starts and ends inside a word, which takes its look for those characters alone.
  expect(text(price)).toBe('Cost: (USD)100')
  expect(runs(price).filter(found => look(found).color === RED).map(text)).toEqual(['USD'])
})

it('draws a word a pending change writes as the text before it is drawn', async () => {
  const savedMarkdown = 'Big title here\n\nSmall then loud\n\nYour Company\n'
  const sized = drawing([
    paragraph(0, [{ text: 'Big title here', look: LARGE, at: 0 }]),
    paragraph(2, [{ text: 'Small then ', look: NORMAL, at: 0 }, { text: 'loud', look: LARGE, at: 11 }]),
    paragraph(4, [{ text: 'Your Company', look: LARGE, at: 0 }]),
  ])
  const markdown = savedMarkdown.replace('title', 'heading').replace('loud', 'quiet').replace('Your Company', 'Fresh Words')
  const { blocks, look, show } = await draw({ savedMarkdown, markdown, drawing: sized })
  const size = (block: Element, words: string) => look(run(block, words)).fontSize
  const [title, line, fresh] = blocks()

  // The write removes the old text first, so the new takes the look of what is left before it.
  expect(size(title, 'heading')).toBe(size(title, 'Big'))
  expect(size(line, 'quiet')).toBe(size(line, 'Small then'))
  expect(size(line, 'quiet')).not.toBe(size(title, 'Big'))
  // A paragraph written over whole is that paragraph still, and draws the new text as it began.
  expect(blocks()).toHaveLength(3)
  expect(text(fresh)).toBe('Fresh Words')
  expect(size(fresh, 'Fresh Words')).toBe(size(title, 'Big'))
  const large = size(title, 'Big')

  // What it wrote over is drawn as Google has it, where every change is read in place.
  show('Inline')
  expect(blocks().map(text)).toEqual(['Big titleheading here', 'Small then loudquiet', 'Your Company', 'Fresh Words'])
  expect(size(blocks()[1], 'loud')).toBe(large)
})

it('opens and closes an outline nobody chose as the frame gains and loses the room for it', async () => {
  await draw({ savedMarkdown: '# Intro\n\nText\n' })
  const outline = frame!.contentDocument!.getElementById('outline')!
  expect(outline.hidden).toBe(true)

  frame!.style.width = '1200px'
  await expect.poll(() => outline.hidden).toBe(false)
  frame!.style.width = '900px'
  await expect.poll(() => outline.hidden).toBe(true)

  // One the person opened stays as they left it.
  frame!.contentDocument!.getElementById('outline-toggle')!.click()
  frame!.style.width = '1200px'
  frame!.style.width = '900px'
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(outline.hidden).toBe(false)
})

it('makes no link of a web address that is in a pending change', async () => {
  const savedMarkdown = 'See [the saved page](https://example.com/saved).\n\nOld text\n'
  const markdown = savedMarkdown.replace('Old text', 'Old [text](https://example.com/word)') +
    '\nAnd [a new one](https://example.com/added).\n'
  const { page, look } = await draw({ savedMarkdown, markdown })
  const links = [...page.querySelectorAll<HTMLElement>('.link')]
  expect(links.map(link => link.title)).toEqual([
    'https://example.com/saved',
    'Not opened while its change is pending: https://example.com/word',
    'Not opened while its change is pending: https://example.com/added',
  ])

  expect(links.map(link => link.getAttribute('href'))).toEqual(['https://example.com/saved', null, null])
  expect(links.map(link => look(link).cursor)).toEqual(['pointer', 'text', 'text'])
})

it('starts a table whose unsized columns fill the column where the column starts', async () => {
  // Seven shares of 500pt sum to a hair over it.
  const cells = Array.from({ length: 7 }, (_, column) => ({ ...CELL, column, blocks: [paragraph(undefined, 'Cell')] }))
  const markup = ['<table>', '  <tr>', ...cells.map(() => '    <td><p>Cell</p></td>'), '  </tr>', '</table>'].join('\n')
  const { blocks } = await draw({
    savedMarkdown: `${markup}\n`,
    drawing: drawing([{ type: 'table', line: 0, columns: cells.map(() => 0), rows: [{ cells }] }]),
  })

  const [table] = blocks()
  expect(table.getBoundingClientRect().left).toBeCloseTo(table.parentElement!.getBoundingClientRect().left, 1)
})

it('gives a paragraph of raised text alone the line its size makes', async () => {
  const raised = { ...ARIAL, baseline: 'super' }
  const { blocks } = await draw({
    savedMarkdown: '2\n\nplain\n\nplain\n',
    drawing: drawing([paragraph(0, [{ text: '2', look: 1, at: 0 }]), paragraph(2, 'plain'), paragraph(4, 'plain')],
      { textLooks: [ARIAL, raised] }),
  })

  const [first, second, third] = blocks().map(block => block.getBoundingClientRect().top)
  expect(second - first).toBeCloseTo(third - second, 1)
})

it('draws a table a pending change writes as the text it is, and one the document holds as a table', async () => {
  const held = ['<table>', '  <tr>', '    <td><p>Held</p></td>', '  </tr>', '</table>'].join('\n')
  const written = held.replace('Held', 'Written')
  const tabled = drawing([{ type: 'table', line: 0, columns: [200], rows: [{ cells: [{ ...CELL, column: 0, blocks: [paragraph(undefined, 'Held')] }] }] }])
  const { page } = await draw({ savedMarkdown: `${held}\n`, markdown: `${held}\n\n${written}\n`, drawing: tabled })

  // The write inserts table markup as plain text, so that is what applying it leaves.
  expect([...page.querySelectorAll('td')].map(text)).toEqual(['Held'])
  expect(text(page)).toContain('<td><p>Written</p></td>')
})

const PICTURE = { width: 20, height: 10, readable: true }
const png = () => ({ mimeType: 'image/png', content: new Blob([new Uint8Array([137, 80, 78, 71])]).stream() })

it('asks again on a refresh for a picture that could not be read', async () => {
  let reads = 0
  const pictured = drawing([paragraph(0, [{ object: 'pic', look: NORMAL }])], { objects: { pic: PICTURE } })
  const { page, refresh } = await draw({ savedMarkdown: '[Image]\n', drawing: pictured }, {
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
  const pictures = (...ids: string[]) => drawing([paragraph(0, ids.map(object => ({ object, look: NORMAL })))],
    { objects: Object.fromEntries(ids.map(id => [id, PICTURE])) })
  const { page } = await draw({ savedMarkdown: '', tabs: ['t.0', 't.1'] }, {
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
  const { page } = await draw({ savedMarkdown: '', tabs: ['t.0', 't.1'] }, {
    getPendingChanges: async (tabId: string) => {
      if (tabId === 't.1') await new Promise<void>(resolve => { arrive = resolve })
      return { changes: [], savedMarkdown: `${tabId}\n`, markdown: tabId === 't.0' ? 'Edited\n' : `${tabId}\n` }
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

it('steps back from where it opens to the last change', async () => {
  const savedMarkdown = 'One\n\nTwo\n\nThree\n'
  const { page } = await draw({ savedMarkdown, markdown: 'One more\n\nTwo\n\nThree more\n' })
  const [previous, next] = [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#nav button')]
  const here = () => [...page.querySelectorAll('.here')].map(text)

  previous.click()
  expect(here()).toEqual(['Three more'])
  next.click()
  expect(here()).toEqual(['One more'])
})

it('counts the page at the head of the frame, where a step puts one, however short its pages', async () => {
  const lines = Array.from({ length: 30 }, (_, line) => `Line ${line}`)
  const short = drawing(lines.map((line, index) => paragraph(index * 2, line)), { page: { width: 600, height: 150 } })
  const { sheets } = await draw({ savedMarkdown: `${lines.join('\n\n')}\n`, drawing: short })
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
})

it('draws a paragraph that says only <table> as that text, and what follows it as it is', async () => {
  const savedMarkdown = 'Intro\n\n<table>\n\n# Results\n\nAfter\n'
  const { blocks, look } = await draw({
    savedMarkdown,
    drawing: drawing([
      paragraph(0, 'Intro', { look: TITLE }), paragraph(2, '<table>'),
      paragraph(4, [{ text: 'Results', look: HEADING, at: 2 }], { style: 'HEADING_1', look: HEADING }), paragraph(6, 'After'),
    ]),
  })

  expect(blocks().map(block => [block.getAttribute('role'), text(block)])).toEqual(
    [[null, 'Intro'], [null, '<table>'], ['heading', 'Results'], [null, 'After']])
  // The tab is still drawn from its drawing.
  expect(parseFloat(look(run(blocks()[0], 'Intro')).fontSize)).toBeCloseTo(26 * POINT, 1)
})

it('folds one of two headings of the same name, and keeps the keyboard on its arrow', async () => {
  await draw({ savedMarkdown: '# Results\n\n## First\n\n# Results\n\n## Second\n' })
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
  const { refresh } = await draw({ savedMarkdown: '', tabs: ['t.0', 't.1'] })
  const pager = frame!.contentDocument!.getElementById('pager')!
  expect(pager.classList.contains('lifted')).toBe(false)

  await refresh({ edited: ['t.1'] })
  await expect.poll(() => pager.classList.contains('lifted')).toBe(true)
  await refresh({ edited: [] })
  await expect.poll(() => pager.classList.contains('lifted')).toBe(false)
})

it('opens on the first tab with changes waiting, and marks each that has them', async () => {
  const { page } = await draw({ savedMarkdown: '', tabs: ['t.0', 't.1', 't.2'], edited: ['t.1', 't.2'] })
  const buttons = [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')]

  expect(text(page)).toBe('t.1')
  expect(buttons.map(button => [button.title, getComputedStyle(button, '::after').content])).toEqual(
    [['Tab 1', 'none'], ['Tab 2 (has pending edits)', '"Edited"'], ['Tab 3 (has pending edits)', '"Edited"']])
})
