// The Google Doc preview client, run in a same-origin frame with a scripted session so its drawing
// can be read. ConnectionPreviewPane's test runs it in the real sandbox, where it cannot.

import { afterEach, expect, it } from 'vitest'
import { prepareUiPage } from '@gadgets/workshop-shared/ui-page'
import { DOCS_PREVIEW_BUNDLE } from './docsPreviewBundle'

type Doc = { savedMarkdown: string, markdown?: string, styles?: object, tabs?: string[], titles?: string[] }

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

/** Draws `doc` and resolves to the frame's document once the page has its blocks. */
async function draw(doc: Doc) {
  const gadget = {
    listTabs: async () => (doc.tabs ?? ['t.0']).map((id, index) =>
      ({ id, title: doc.titles?.[index] ?? `Tab ${index + 1}`, index, nestingLevel: 0 })),
    getPendingChanges: async (tabId: string) => {
      if (!(doc.tabs ?? ['t.0']).includes(tabId)) throw new Error(`no tab with ID "${tabId}"`)
      // With several tabs, each reads as its own ID.
      const savedMarkdown = doc.tabs ? `${tabId}\n` : doc.savedMarkdown
      return { changes: [], markdown: savedMarkdown, ...doc, savedMarkdown }
    },
    getStyles: async () => doc.styles ?? Promise.reject(new Error('no styles')),
    listImages: async () => [],
  }
  Object.assign(window, { docsPreviewGadget: gadget })
  frame = document.body.appendChild(document.createElement('iframe'))
  frame.style.width = '900px'
  // Started as the gadget UI frame starts it: main(gadget) on the module's default export.
  const { entryUrl, importMap } = prepareUiPage(DOCS_PREVIEW_BUNDLE, '')
  frame.srcdoc = `<body><script type="importmap">${importMap}</script><script type="module">
    import client from ${JSON.stringify(entryUrl)}
    client.main(parent.docsPreviewGadget)
  </script>`
  const page = () => frame!.contentDocument?.getElementById('page')
  await expect.poll(() => page() && !page()!.hasAttribute('aria-busy')).toBe(true)
  return {
    page: page()!,
    blocks: () => [...page()!.children] as HTMLElement[],
    look: (element: Element) => frame!.contentWindow!.getComputedStyle(element),
    async refresh(next: Partial<Doc>) {
      Object.assign(doc, next)
      frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
    },
  }
}

const BLUE = 'rgb(74, 134, 232)'
const STYLES = {
  page: { width: 600, marginTop: 72, marginRight: 72, marginLeft: 72 },
  named: {
    NORMAL_TEXT: { fontFamily: 'Arial', fontSize: 11 },
    TITLE: { fontFamily: 'Arial', fontSize: 26, color: '#4a86e8', alignment: 'center' },
    HEADING_1: { fontFamily: 'Arial', fontSize: 20, bold: true },
  },
  paragraphs: [
    { line: 0, style: 'TITLE' },
    { line: 2, style: 'NORMAL_TEXT', runs: [{ start: 6, end: 10, look: 0 }] },
  ],
  runLooks: [{ fontFamily: 'Consolas', color: '#880000' }],
  tables: [{
    line: 4,
    columns: [100, 300],
    rows: [[
      { background: '#d9ead3', look: { alignment: 'center' } },
      { borders: { top: { width: 0, color: '#000000' } } },
    ]],
  }],
}
const SAVED = [
  '# Report', '', 'plain code plain', '',
  '<table>', '  <tr>', '    <td><p>Head</p></td>', '    <td><p>Body</p></td>', '  </tr>', '</table>', '',
].join('\n')

it('draws paragraphs, runs and table cells in the styles the session gives', async () => {
  const { blocks, look } = await draw({ savedMarkdown: SAVED, styles: STYLES })
  const [title, paragraph, table] = blocks()

  // The title is a first-level heading in Markdown, told apart by its named style.
  expect(look(title).color).toBe(BLUE)
  expect(title.style.textAlign).toBe('center')
  expect(title.style.fontSize).toBe('26pt')

  const run = [...paragraph.querySelectorAll('span')].find(span => span.textContent === 'code')!
  expect(look(run).color).toBe('rgb(136, 0, 0)')
  expect(look(run).fontFamily).toContain('Consolas')
  expect(paragraph.textContent).toBe('plain code plain')

  const [head, body] = table.querySelectorAll('td')
  expect(look(head).backgroundColor).toBe('rgb(217, 234, 211)')
  expect(look(head).textAlign).toBe('center')
  expect(look(body).borderTopStyle).toBe('none')
  expect([...table.querySelectorAll('col')].map(column => column.style.width)).toEqual(['25%', '75%'])
})

it('keeps a run\'s look on the words an edit keeps, and gives an added block its kind\'s style', async () => {
  const { blocks, look, refresh } = await draw({ savedMarkdown: SAVED, styles: STYLES })

  await refresh({ markdown: SAVED.replace('plain code plain', 'plainer code plain\n\n# Added') })
  await expect.poll(() => blocks().some(block => block.classList.contains('changed'))).toBe(true)

  const changed = blocks().find(block => block.classList.contains('changed'))!
  expect(changed.querySelector('del')!.textContent).toBe('plain')
  expect(changed.querySelector('ins')!.textContent).toBe('plainer')
  const run = [...changed.querySelectorAll('span')].find(span => span.textContent === 'code')!
  expect(look(run).color).toBe('rgb(136, 0, 0)')

  // A new heading has no saved paragraph to take after, so it is a Heading 1, not the title.
  const added = blocks().find(block => block.classList.contains('added'))!
  expect(added.textContent).toBe('Added')
  expect(added.style.fontSize).toBe('20pt')
  expect(look(added).fontWeight).toBe('700')
  expect(added.style.textAlign).toBe('')
})

it('draws no paragraph\'s own look when a style is on a line that does not read as its kind', async () => {
  const styles = { ...STYLES, paragraphs: [{ line: 0, style: 'NORMAL_TEXT' }, STYLES.paragraphs[1]] }
  const { blocks } = await draw({ savedMarkdown: SAVED, styles })
  const [title, paragraph] = blocks()

  expect(title.style.fontSize).toBe('20pt')
  expect(paragraph.querySelectorAll('span')).toHaveLength(0)
})

it('draws the document in its own styles when the session gives none', async () => {
  const { blocks } = await draw({ savedMarkdown: SAVED })

  expect(blocks().map(block => block.tagName)).toEqual(['H1', 'P', 'DIV'])
  expect(blocks()[0].getAttribute('style')).toBeNull()
})

it('draws one empty paragraph for each the tab has, at its start and end as between blocks', async () => {
  // As the converter writes an empty paragraph first, between two paragraphs, and last.
  const { blocks } = await draw({ savedMarkdown: '\n\nFirst\n\n\n\nSecond\n\n\n' })

  expect(blocks().map(block => block.textContent)).toEqual(['', 'First', '', 'Second', ''])
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
  expect(changed.querySelector('del')).toBeNull()
  expect([...changed.querySelectorAll('ins')].map(node => node.textContent).join('')).toBe(', and every embedder,')
})

it('draws a page break as the gap between two sheets', async () => {
  const { page } = await draw({ savedMarkdown: 'Before\n\n\\[Page break\\]\n\nAfter\n' })

  expect(page.querySelectorAll('.break')).toHaveLength(1)
  expect(page.textContent).toBe('BeforeAfter')
})

it('lists the tabs again on a refresh, and leaves a tab that has gone for the first', async () => {
  const { page, refresh } = await draw({ savedMarkdown: '', tabs: ['t.0', 'pending-tab-1'] })
  const buttons = () => [...frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')]
  // The tab still to be added is marked as new.
  expect(buttons().map(button => [button.title, getComputedStyle(button, '::after').content])).toEqual(
    [['Tab 1', 'none'], ['Tab 2 (new, not yet added)', '""']])
  buttons()[1].click()
  await expect.poll(() => page.textContent).toBe('pending-tab-1')

  // The tab's add was discarded.
  await refresh({ tabs: ['t.0'] })

  await expect.poll(() => page.textContent).toBe('t.0')
  expect(buttons()).toHaveLength(0)
  expect(frame!.contentDocument!.getElementById('error')).toBeNull()
})

it('stays on an added tab once Google has it, though another tab has its title', async () => {
  const titles = ['Notes', 'Notes']
  const { page, refresh } = await draw({ savedMarkdown: '', tabs: ['t.0', 'pending-tab-1'], titles })
  frame!.contentDocument!.querySelectorAll<HTMLElement>('#outline .tab .name')[1].click()
  await expect.poll(() => page.textContent).toBe('pending-tab-1')

  await refresh({ tabs: ['t.0', 't.1'], titles })

  await expect.poll(() => page.textContent).toBe('t.1')
})

it('lists the headings in an outline, marks a section that holds a change, and scrolls to one', async () => {
  const filler = Array.from({ length: 60 }, (_, line) => `Line ${line}`).join('\n\n')
  const savedMarkdown = `# Intro\n\n${filler}\n\n## Details\n\nOld text\n\n# Last\n\nEnd\n`
  const { page } = await draw({ savedMarkdown, markdown: savedMarkdown.replace('Old text', 'New text') })
  const outline = frame!.contentDocument!.getElementById('outline')!
  const entries = () => [...outline.querySelectorAll<HTMLElement>('#rail .entry')]

  // The frame is too narrow for the outline to stand beside the page, so it starts closed.
  expect(outline.hidden).toBe(true)
  frame!.contentDocument!.getElementById('outline-toggle')!.click()

  expect(entries().map(entry => entry.textContent)).toEqual(['Intro', 'Details', 'Last'])
  expect(entries().map(entry => entry.classList.contains('touched'))).toEqual([false, true, false])
  expect(entries().map(entry => entry.parentElement!.style.paddingLeft)).toEqual(['0px', '12px', '0px'])

  entries()[1].click()
  const details = page.querySelector('h2')!
  await expect.poll(() => Math.round(details.getBoundingClientRect().top)).toBeLessThan(40)
  expect(outline.hidden).toBe(true)
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
  expect(rows()[0].querySelector('.entry')!.classList.contains('touched')).toBe(true)
  // Folding goes nowhere.
  expect(scrolled()).toBe(before)

  rows()[2].querySelector<HTMLElement>('.entry')!.click()
  const last = page.querySelectorAll('h1')[1]
  await expect.poll(() => Math.round(last.getBoundingClientRect().top)).toBeLessThan(400)
  arrows()[0]!.click()
  expect(rows().map(row => row.hidden)).toEqual([false, false, false])
})

it('follows a link to a heading of the document, and makes one to the web a link to a new tab', async () => {
  const filler = Array.from({ length: 60 }, (_, line) => `Line ${line}`).join('\n\n')
  const savedMarkdown = `# Intro\n\nSee [the end](#heading=h.last) or [the web](https://example.com/) or [a mark](?tab=t.0#bookmark=id.x) or [a slip](#heading=%).\n\n${filler}\n\n# Last\n\nEnd\n`
  const paragraphs = [
    { line: 0, style: 'HEADING_1', headingId: 'h.intro' },
    { line: savedMarkdown.split('\n').indexOf('# Last'), style: 'HEADING_1', headingId: 'h.last' },
  ]
  const { page, look } = await draw({ savedMarkdown, styles: { named: {}, paragraphs, runLooks: [], tables: [] } })
  const [inside, outside, bookmark, slip] = [...page.querySelectorAll<HTMLElement>('.link')]
  const last = page.querySelectorAll('h1')[1]
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
  await expect.poll(top).toBeLessThan(40)
})

it('keeps an asterisk that stands alone as the document\'s text, and a run\'s look to its own characters', async () => {
  const savedMarkdown = 'Calculate 2 * 3 * 4 and *stress* it\n\nPrice: (USD)100\n'
  const styles = {
    named: {}, runLooks: [{ color: '#880000' }], tables: [],
    paragraphs: [{ line: 0, style: 'NORMAL_TEXT' }, { line: 2, style: 'NORMAL_TEXT', runs: [{ start: 8, end: 11, look: 0 }] }],
  }
  const { blocks, look } = await draw({ savedMarkdown, styles })
  const [sum, price] = blocks()

  expect(sum.textContent).toBe('Calculate 2 * 3 * 4 and stress it')
  expect([...sum.querySelectorAll('.i')].map(run => run.textContent)).toEqual(['stress'])
  // The run starts and ends inside a word, which takes its look for those characters alone.
  expect(price.textContent).toBe('Price: (USD)100')
  expect([...price.querySelectorAll('span')].filter(run => look(run).color === 'rgb(136, 0, 0)').map(run => run.textContent))
    .toEqual(['USD'])
})

it('draws a word a pending change writes as the text before it is drawn', async () => {
  const savedMarkdown = 'Big title here\n\nSmall then loud\n\nYour Company\n'
  const styles = {
    named: {}, runLooks: [{ fontSize: 24 }], tables: [],
    paragraphs: [
      { line: 0, style: 'NORMAL_TEXT', runs: [{ start: 0, end: 14, look: 0 }] },
      { line: 2, style: 'NORMAL_TEXT', runs: [{ start: 11, end: 15, look: 0 }] },
      { line: 4, style: 'NORMAL_TEXT', runs: [{ start: 0, end: 12, look: 0 }] },
    ],
  }
  const markdown = savedMarkdown.replace('title', 'heading').replace('loud', 'quiet').replace('Your Company', 'Fresh Words')
  const { blocks, look } = await draw({ savedMarkdown, markdown, styles })
  const size = (block: Element, text: string) =>
    look([...block.querySelectorAll('span, ins, del')].find(run => run.textContent?.trim() === text)!).fontSize
  const [title, line, , fresh] = blocks()

  // The write removes the old text first, so the new takes the look of what is left before it.
  expect(size(title, 'heading')).toBe(size(title, 'Big'))
  expect(size(line, 'loud')).toBe(size(title, 'Big'))
  expect(size(line, 'quiet')).toBe(look(line).fontSize)
  expect(size(line, 'quiet')).not.toBe(size(title, 'Big'))
  // A paragraph written over whole is that paragraph still, and draws the new text as it began.
  expect(fresh.textContent).toBe('Fresh Words')
  expect(size(fresh, 'Fresh Words')).toBe(size(title, 'Big'))
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

it('draws a table a pending change writes as the text it is, and one the document holds as a table', async () => {
  const held = ['<table>', '  <tr>', '    <td><p>Held</p></td>', '  </tr>', '</table>'].join('\n')
  const written = held.replace('Held', 'Written')
  const { page } = await draw({ savedMarkdown: `${held}\n`, markdown: `${held}\n\n${written}\n` })

  // The write inserts table markup as plain text, so that is what applying it leaves.
  expect([...page.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Held'])
  expect(page.textContent).toContain('<td><p>Written</p></td>')
})
