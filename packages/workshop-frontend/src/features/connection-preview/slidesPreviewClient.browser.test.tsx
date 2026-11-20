// The Google Slides preview client, run in a same-origin frame with a scripted session so its
// drawing can be read. slidesPreviewFonts.browser.test.tsx holds the real sandbox to taking the
// fonts the client hands it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareUiPage } from '@gadgets/workshop-shared/ui-page'
import { SLIDES_PREVIEW_BUNDLE } from './slidesPreviewBundle'

type Run = { fontFamily: string, fontSize: number, fontWeight: number, color: string, text: string, link?: string, italic?: boolean }
type Piece = Record<string, unknown> & { id: string, changes?: { id: number, op: string }[] }
type Drawn = { background?: object, behind?: number[], elements: Piece[], speakerNotes: string }
type Info = { id: string, index: number, title: string, skipped: boolean, hasSpeakerNotes: boolean }
type Deck = {
  saved: Info[]
  slides?: Info[]
  changes?: object[]
  drawings: Record<string, { drawing: Drawn | null, saved?: Drawn | null, outlinesPending?: true }>
  /** What masters and layouts put behind slides, which a drawing names by index in `behind`. */
  shared?: Piece[][]
  fonts?: string[]
  broken?: boolean
  /** Whether a read of a picture fails. */
  noPictures?: boolean
  /** Held back until it resolves: what the next read of drawings answers, as it was when asked. */
  hold?: Promise<void>
  /** How much each slide's drawing weighs, 1 unless given here: a read of more than 3 is refused. */
  weights?: Record<string, number>
}

// The smallest PNG there is: one transparent pixel.
const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))

const run = (text: string, more: Partial<Run> = {}): Run =>
  ({ fontFamily: 'Arial', fontSize: 18, fontWeight: 400, color: '#000000', text, ...more })
const box = (id: string, x: number, y: number, words?: string, more: object = {}): Piece => ({
  id, bounds: { x, y, width: 200, height: 50 }, kind: 'shape', shapeType: 'TEXT_BOX',
  ...(words === undefined ? {} : { text: [{ runs: [run(words)] }] }), ...more,
})
const slide = (elements: Piece[], speakerNotes = ''): Drawn => ({ background: { color: '#ffffff' }, elements, speakerNotes })
const listed = (...titles: string[]): Info[] =>
  titles.map((title, index) => ({ id: `s${index + 1}`, index, title, skipped: false, hasSpeakerNotes: false }))
const edit = (id: number, slideId: string, ...elementIds: string[]) => ({
  id, type: 'updateSlides', slideIds: [slideId], changes: elementIds.map(elementId => ({ op: 'editText', slideId, elementId })),
})
/** A slide whose title change 1 edits, as `edit(1, id, `${id}-title`)` queues it. */
const retitled = (id: string) => ({
  drawing: slide([box(`${id}-title`, 20, 20, 'Edited', { changes: [{ id: 1, op: 'editText' }] })]), saved: slide([box(`${id}-title`, 20, 20, id)]),
})

let frame: HTMLIFrameElement | undefined

afterEach(() => frame?.remove())

/** Draws `deck` and resolves once every slide it is to draw is drawn. */
async function draw(deck: Deck, width = 1100, height = 700) {
  const calls: [string, ...unknown[]][] = []
  let loads = 0
  const called = (name: string) => calls.filter(([method]) => method === name).map(([, ...args]) => args)
  const outline = (slides: Info[]) => ({ id: 'deck', title: 'Deck', pageSize: { width: 720, height: 405 }, masters: [], slides })
  const gadget = {
    getPendingChanges: async () => {
      loads++
      if (deck.broken) throw new Error('The presentation is gone')
      return { changes: deck.changes ?? [], savedPresentation: outline(deck.saved), presentation: outline(deck.slides ?? deck.saved) }
    },
    readSlideDrawings: async (ids: string[]) => {
      calls.push(['readSlideDrawings', ids])
      // As the session refuses them.
      if (ids.length > 10) throw new Error('Request between 1 and 10 slides at a time.')
      if (deck.weights && ids.reduce((sum, id) => sum + (deck.weights![id] ?? 1), 0) > 3) {
        throw new Error(`These ${ids.length} slides are too large to read at once. Request fewer.`)
      }
      const slides = ids.map(slideId => ({ slideId, ...deck.drawings[slideId] ?? { drawing: slide([box(`${slideId}-title`, 20, 20, slideId)]) } }))
      const read = { slides, shared: deck.shared ?? [] }
      await deck.hold
      return read
    },
    readPicture: async (pictureId: string, slideId: string) => {
      calls.push(['readPicture', pictureId, slideId])
      if (deck.noPictures) throw new Error('Google did not return this picture.')
      return { mimeType: 'image/png', bytes: PIXEL }
    },
    listFonts: async () => {
      calls.push(['listFonts'])
      return (deck.fonts ?? []).map(family => ({ family, weights: [400], italic: false }))
    },
    readFont: async (family: string, weight: number, italic: boolean) => {
      calls.push(['readFont', family, weight, italic])
      throw new Error(`Google Fonts does not serve "${family}"`)
    },
    getSlideThumbnail: async (slideId: string, size: string) => {
      calls.push(['getSlideThumbnail', slideId, size])
      return { mimeType: 'image/png', width: 1600, height: 900, content: PIXEL.buffer }
    },
  }
  Object.assign(window, { slidesPreviewGadget: gadget })
  frame = document.body.appendChild(document.createElement('iframe'))
  frame.style.cssText = `width:${width}px;height:${height}px`
  // Started as the gadget UI frame starts it: main(gadget) on the module's default export.
  const { entryUrl, importMap } = prepareUiPage(SLIDES_PREVIEW_BUNDLE, '')
  frame.srcdoc = `<body><script type="importmap">${importMap}</script><script type="module">
    import client from ${JSON.stringify(entryUrl)}
    client.main(parent.slidesPreviewGadget)
  </script>`
  const doc = () => frame!.contentDocument!
  const all = (selector: string) => [...doc().querySelectorAll<HTMLElement>(selector)]
  const settled = () => !!doc()?.getElementById('error') || !!doc()?.getElementById('page') && !doc().getElementById('page')!.hasAttribute('aria-busy') &&
    all('.card:not(.listed) .sheet.wait').length === 0 && doc().querySelector('[role=status]')!.textContent === ''
  await expect.poll(settled, { timeout: 10_000 }).toBe(true)
  /** Asks for a refresh of `next`, and resolves once it is being read. */
  const ask = async (next: Partial<Deck>) => {
    Object.assign(deck, next)
    const before = loads
    frame!.contentWindow!.postMessage({ type: 'refresh' }, '*')
    await expect.poll(() => loads).toBeGreaterThan(before)
  }
  return {
    doc: doc(), all, called,
    card: (id: string) => doc().querySelector<HTMLElement>(`.card[data-slide="${id}"]`)!,
    film: (id: string) => doc().querySelector<HTMLElement>(`.film[data-slide="${id}"]`)!,
    text: (selector: string) => all(selector).map(node => node.textContent),
    /** Resolves once every <img> naming the picture `id` shows it. */
    async pictured(id: string) {
      await expect.poll(() => all(`img[data-picture="${id}"]`).every(image => image.getAttribute('src')?.startsWith('data:image/png'))).toBe(true)
    },
    /** The names under a slide of what changes on it, as far as the view it is on shows them. */
    named: (id: string) => all(`.card[data-slide="${id}"] .change:not(.off)`)
      .map(chip => `${chip.lastChild!.textContent}${chip.classList.contains('gone') ? ' (gone)' : ''}`),
    ask,
    async refresh(next: Partial<Deck>) {
      await ask(next)
      await expect.poll(settled, { timeout: 10_000 }).toBe(true)
    },
  }
}

it('draws each slide from its drawing: text as text, shapes as paths, and pictures read through the session', async () => {
  const { card, film, all, called, pictured } = await draw({
    saved: listed('Welcome', 'Agenda'),
    drawings: {
      s1: { drawing: slide([
        box('title', 40, 30, '<img src=x onerror=alert(1)> & co', { rotation: 10 }),
        { id: 'blob', bounds: { x: 300, y: 100, width: 120, height: 80 }, kind: 'shape', shapeType: 'ELLIPSE', fill: { color: '#3fcbb1' }, outline: { color: '#000000', weight: 2 } },
        { id: 'photo', bounds: { x: 500, y: 200, width: 100, height: 100 }, kind: 'picture', of: 'image', pictureId: 'photo', crop: { left: .25, top: 0, right: .25, bottom: 0 } },
        { id: 'rule', bounds: { x: 0, y: 0, width: 100, height: 0 }, kind: 'line', start: { x: 20, y: 380 }, end: { x: 220, y: 380 }, stroke: { color: '#e25447', weight: 3 }, endArrow: 'FILL_ARROW' },
      ]) },
    },
  })

  const stage = card('s1').querySelector('.sheet > .stage')!
  const title = stage.querySelector<HTMLElement>('[data-id="title"]')!
  expect(title.textContent).toBe('<img src=x onerror=alert(1)> & co')
  expect(title.querySelector('img')).toBeNull()
  expect(title.style.transform).toBe('rotate(10deg)')
  expect(title.querySelector('span')!.style.fontSize).toBe('18px')
  expect(stage.querySelector('[data-id="blob"] path')!.getAttribute('fill')).toBe('#3fcbb1')
  expect(stage.querySelector('svg[data-id="rule"] path[stroke="#e25447"]')).not.toBeNull()

  // The picture is asked for once, for the slide and the filmstrip alike, and cropped by its box.
  await pictured('photo')
  expect(called('readPicture')).toEqual([['photo', 's1']])
  expect(stage.querySelector<HTMLElement>('img[data-picture="photo"]')!.style.width).toBe('200%')

  // The stage is the slide's own size, scaled to the sheet it lies on.
  const sheet = card('s1').querySelector<HTMLElement>('.sheet')!
  expect(sheet.style.getPropertyValue('--k')).toBe(String(sheet.clientWidth / 720))
  expect(film('s1').querySelector('.mini .stage [data-id="title"]')).not.toBeNull()
  expect(all('.film').map(node => node.querySelector('i')!.textContent)).toEqual(['1', '2'])
  expect(called('readSlideDrawings')).toEqual([[['s1', 's2']]])
})

it('rings what a pending change touches, names it under the slide, and shows the slide as saved on request', async () => {
  const saved = slide([box('title', 40, 30, 'Old title'), box('body', 40, 120, 'Body'), box('gone', 40, 300, 'Going')], 'Say hello to everyone')
  const { card, film, all, text, doc, named } = await draw({
    saved: listed('Old title', 'Agenda'),
    slides: [{ ...listed('New title')[0] }, listed('', 'Agenda')[1]],
    changes: [edit(4, 's1', 'title', 'body'), { id: 5, stale: true, type: 'deleteSlide', slideIds: ['s9'], slideId: 's9' }],
    drawings: {
      s1: { saved, drawing: slide([
        box('title', 40, 30, 'New title', { changes: [{ id: 4, op: 'editText' }] }),
        { ...box('body', 300, 120, 'Body', { changes: [{ id: 4, op: 'setBounds' }] }) },
        box('fresh', 400, 300, 'Brand new', { changes: [{ id: 4, op: 'createShape' }] }),
      ], 'Say goodbye to everyone') },
    },
  })

  // Named from the top of the slide down.
  expect(named('s1')).toEqual(['Text edited', 'Moved', 'Deleted (gone)', 'Added'])
  // A ring carries only the number its name has, so no name lies over the slide.
  expect(text('.card[data-slide="s1"] .marks .spot')).toEqual(['1', '2', '3', '4'])
  expect(text('.card[data-slide="s1"] .change > i')).toEqual(['1', '2', '3', '4'])
  // Each in its change's color: purple for an edit, red for what is deleted, green for what is added.
  for (const mark of ['.marks .spot', '.change']) {
    expect(all(`.card[data-slide="s1"] ${mark}`).map(node => ['edit', 'gone'].find(kind => node.classList.contains(kind)) ?? 'added'))
      .toEqual(['edit', 'edit', 'gone', 'added'])
  }
  const marks = card('s1').querySelector('.marks')!.getBoundingClientRect()
  expect(all('.card[data-slide="s1"] .change').every(chip => chip.getBoundingClientRect().top >= marks.bottom)).toBe(true)
  expect(card('s1').querySelector('.sheet [data-id="title"]')!.textContent).toBe('New title')
  expect(text('.card[data-slide="s1"] .tag')).toEqual(['2 changes'])
  expect(film('s1').classList.contains('changed')).toBe(true)
  expect(film('s2').classList.contains('changed')).toBe(false)

  // The notes are compared as text, word by word.
  const notes = card('s1').querySelector('.notes')!
  expect([...notes.querySelectorAll('del')].map(node => node.textContent)).toEqual(['hello'])
  expect([...notes.querySelectorAll('ins')].map(node => node.textContent)).toEqual(['goodbye'])

  expect(doc.getElementById('stale')!.title).toBe('1 change no longer fits this presentation and is not shown.')
  // The reason is in what it shows, for whoever cannot point at it.
  expect(doc.getElementById('stale')!.textContent).toBe('1 change no longer applies')
  // Each changed element is a stop, and so are the notes.
  expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe('5 changed places')
  doc.querySelector<HTMLElement>('#nav button[aria-label="Next change"]')!.click()
  expect(doc.querySelector('.change.here')!.lastChild!.textContent).toBe('Text edited')
  expect(doc.querySelector('.spot.here')!.textContent).toBe('1')
  // A name lights its ring while it has the pointer or the focus.
  const [chip] = all('.card[data-slide="s1"] .change')
  chip.focus()
  expect(card('s1').querySelector('.spot')!.classList.contains('lit')).toBe(true)
  chip.blur()
  expect(card('s1').querySelector('.spot')!.classList.contains('lit')).toBe(false)

  const [after, before] = all('.card[data-slide="s1"] .views button')
  expect([after.getAttribute('aria-pressed'), before.getAttribute('aria-pressed')]).toEqual(['true', 'false'])
  before.focus()
  before.click()
  await expect.poll(() => card('s1').querySelector('.sheet > .stage:last-child [data-id="title"]')!.textContent).toBe('Old title')
  // The buttons are the ones that were there, so the one pressed keeps the keyboard's focus.
  expect(all('.card[data-slide="s1"] .views button')).toEqual([after, before])
  expect(doc.activeElement).toBe(before)
  expect([after.getAttribute('aria-pressed'), before.getAttribute('aria-pressed')]).toEqual(['false', 'true'])
  // What is added is not on the saved slide; the rest is ringed where it is saved.
  expect(named('s1')).toEqual(['Text edited', 'Moved', 'Deleted (gone)'])
  expect(card('s2').querySelector('.views')).toBeNull()
})

it('rings the text a change leaves spilling out of a box too small for it, and a drawn box with it', async () => {
  // A year set on its side in a box shorter than its letters, as a timeline has them.
  const year = (id: string, x: number, words: string, more: object = {}): Piece => ({
    ...box(id, x, 180, undefined, more), bounds: { x, y: 180, width: 165, height: 48 }, rotation: 270,
    text: [{ runs: [run(words, { fontSize: 60, fontWeight: 700 })], alignment: 'center' }],
  })
  const changes = [{ id: 1, op: 'editText' }]
  const { card } = await draw({
    saved: listed('Timeline'),
    changes: [edit(1, 's1', 'bare', 'filled')],
    drawings: { s1: {
      saved: slide([year('bare', 100, '2017'), year('filled', 400, '2017', { fill: { color: '#eeeeee' } })]),
      drawing: slide([year('bare', 100, '2026', { changes }), year('filled', 400, '2026', { changes, fill: { color: '#eeeeee' } })]),
    } },
  })

  const rect = (node: Element) => node.getBoundingClientRect()
  const holds = (ring: DOMRect, inner: DOMRect) =>
    ring.left <= inner.left && ring.top <= inner.top && ring.right >= inner.right && ring.bottom >= inner.bottom
  const drawn = (id: string) => card('s1').querySelector(`.sheet [data-id="${id}"]`)!
  // Once the slide is scaled to its sheet.
  await vi.waitFor(() => {
    const [bare, filled] = [...card('s1').querySelectorAll('.marks .spot')].map(rect)
    const text = rect(drawn('bare').querySelector('.words p > *')!)
    // The letters reach past the box, and the ring goes with them: no wider than they are, where the box shows nothing.
    expect(holds(rect(drawn('bare')), text)).toBe(false)
    expect(holds(bare, text)).toBe(true)
    expect(bare.width).toBeLessThan(text.width + 12)
    expect(holds(filled, rect(drawn('filled')))).toBe(true)
    expect(holds(filled, rect(drawn('filled').querySelector('.words p > *')!))).toBe(true)
    expect(filled.width).toBeGreaterThan(bare.width)
  })
})

it('lists slides that are added, deleted, moved and skipped where they belong, each marked as what it is', async () => {
  const [a, b, c, d] = listed('Alpha', 'Bravo', 'Charlie', 'Delta')
  const added = { ...a, id: 'new', title: 'Added' }
  const { text, card, film, all, doc } = await draw({
    saved: [a, b, c, d],
    // Bravo is deleted, Delta moves ahead of Charlie, Charlie is skipped, and a slide is added last.
    slides: [a, d, { ...c, skipped: true }, added].map((info, index) => ({ ...info, index })),
    changes: [
      { id: 1, type: 'deleteSlide', slideIds: ['s2'], slideId: 's2' },
      { id: 2, type: 'moveSlides', slideIds: ['s4'], after: 's1' },
      { id: 3, type: 'setSlidesSkipped', slideIds: ['s3'], skipped: true },
      { id: 4, type: 'createSlide', slideIds: ['new'], layoutId: 'l', newSlideId: 'new' },
    ],
    drawings: {
      s2: { drawing: null, saved: slide([box('b', 20, 20, 'Bravo')]) },
      new: { drawing: slide([box('n', 20, 20, 'Added')]), saved: null },
    },
  })

  expect(all('.card').map(node => node.dataset.slide)).toEqual(['s1', 's2', 's4', 's3', 'new'])
  expect(text('.card .no')).toEqual(['1', '–', '2', '3', '4'])
  expect(all('.card').map(node => [...node.querySelectorAll('header .tag')].map(tag => tag.textContent)))
    .toEqual([[], ['Deleted'], ['Moved from 4'], ['Skipped'], ['New']])
  expect(all('.film').map(node => [...node.querySelectorAll('.tag')].map(tag => tag.textContent)))
    .toEqual([[], ['Deleted'], ['Moved'], ['Skipped'], ['New']])
  expect(card('s2').classList.contains('gone')).toBe(true)
  expect(card('s2').querySelector('.sheet [data-id="b"]')!.textContent).toBe('Bravo')
  expect(card('new').classList.contains('added')).toBe(true)
  expect(film('new').classList.contains('added')).toBe(true)
  // A slide changed as a whole is a stop of its own.
  expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe('4 changed places')

  // Each thumbnail is ringed in the color of what is to happen to it, and the one being read in
  // blue, with the only glow there is. The outline has no dots.
  doc.scrollingElement!.scrollTo({ top: 0, behavior: 'instant' })
  await expect.poll(() => film('s1').getAttribute('aria-current')).toBe('true')
  const ink = (name: string) => {
    const probe = doc.body.appendChild(doc.createElement('i'))
    probe.style.color = `var(${name})`
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }
  const ring = (name: string) => `${ink(name)} 0px 0px 0px 2px`
  const rings = () => all('.film').map(node => getComputedStyle(node.querySelector('.mini')!).boxShadow)
  // Once each has eased into its ring.
  await expect.poll(() => rings().slice(1)).toEqual([ring('--gone-ink'), ring('--edit-ink'), ring('--edit-ink'), ring('--mark-ink')])
  await expect.poll(() => rings()[0]).toMatch(/ 0px 0px 0px 2px, .+ 0px 0px 0px 5px$/)
  expect(rings()[0].startsWith(`${ring('--link')}, `)).toBe(true)
  expect(all('#outline [data-touched]')).toEqual([])
})

it('steps from slide to slide with a navigator at the foot of the frame, counting the slides there will be', async () => {
  const deck: Deck = { saved: listed('One', 'Two', 'Three', 'Four'), drawings: {} }
  const { doc, film, refresh } = await draw(deck)
  const pager = doc.getElementById('pager')!
  const [previous, next] = [...pager.querySelectorAll('button')]
  const reading = () => pager.getAttribute('aria-label')

  // What the pill shows, and what it is called, as a document's page navigator has them.
  expect(pager.hidden).toBe(false)
  expect(pager.textContent).toBe('Slide1 / 4')
  expect(reading()).toBe('Slide 1 of 4')
  expect([previous.disabled, next.disabled]).toEqual([true, false])
  expect(pager.classList.contains('lifted')).toBe(false)

  // Two steps go two slides on, though the first is still under way.
  next.click()
  next.click()
  await expect.poll(reading).toBe('Slide 3 of 4')
  // The filmstrip marks the slide the navigator is on.
  expect(film('s3').getAttribute('aria-current')).toBe('true')
  previous.click()
  await expect.poll(reading).toBe('Slide 2 of 4')

  // A slide to be deleted is stepped to where the filmstrip lists it, and is not counted.
  await refresh({
    slides: [deck.saved[0], ...deck.saved.slice(2)].map((info, index) => ({ ...info, index })),
    changes: [{ id: 1, type: 'deleteSlide', slideIds: ['s2'], slideId: 's2' }],
    drawings: { s2: { drawing: null, saved: slide([box('b', 20, 20, 'Two')]) } },
  })
  await expect.poll(reading).toBe('Deleted slide, after slide 1 of 3')
  expect(pager.querySelector('.count')!.textContent).toBe('– / 3')
  // It stands clear of the Workshop's card for the change, where that lies across the foot.
  expect(pager.classList.contains('lifted')).toBe(true)
  next.click()
  await expect.poll(reading).toBe('Slide 2 of 3')
})

it('steps to the last slide in a pane tall enough to show several', async () => {
  const { doc } = await draw({ saved: listed('One', 'Two', 'Three', 'Four'), drawings: {} }, 490, 900)
  const pager = doc.getElementById('pager')!
  const next = pager.querySelectorAll('button')[1]
  const reading = () => pager.getAttribute('aria-label')

  for (const slide of ['Slide 2 of 4', 'Slide 3 of 4', 'Slide 4 of 4']) {
    expect(next.disabled).toBe(false)
    next.click()
    await expect.poll(reading).toBe(slide)
  }
  await expect.poll(() => next.disabled).toBe(true)
})

it('draws 50 slides, the changed ones and their neighbours first, and lists the rest by title', async () => {
  const saved = listed(...Array.from({ length: 64 }, (_, n) => `Slide ${n + 1}`))
  const { all, called, card, text } = await draw({
    saved,
    changes: [edit(1, 's60', 's60-title')],
    drawings: { s60: retitled('s60') },
  })

  const batches = called('readSlideDrawings').map(([ids]) => ids as string[])
  expect(batches.every(ids => ids.length <= 10)).toBe(true)
  const read = batches.flat()
  expect(read).toHaveLength(50)
  expect(read[0]).toBe('s60')
  expect(new Set(read)).toEqual(new Set([...saved.slice(0, 47).map(({ id }) => id), 's59', 's60', 's61']))
  expect(all('.card.listed')).toHaveLength(14)
  expect(card('s48').querySelector('.title')!.textContent).toBe('Slide 48')
  expect(card('s48').querySelector<HTMLElement>('.frame')!.hidden).toBe(true)
  expect(text('.limit')).toEqual(['50 of 64 slides are drawn, starting with the ones that change. The others are listed by title.'])
})

it('draws a slide again in full, notes and all, once it is back among the 50', async () => {
  const saved = listed(...Array.from({ length: 64 }, (_, n) => `Slide ${n + 1}`))
  saved[48].hasSpeakerNotes = true
  const deck: Deck = { saved, drawings: { s49: { drawing: slide([box('s49-title', 20, 20, 's49')], 'Mind the gap') } } }
  const { card, refresh } = await draw(deck)
  const notes = () => card('s49').querySelector('.notes')?.textContent
  expect(notes()).toBe('Speaker notesMind the gap')

  // A change far down the deck takes its place among the slides drawn, and gives it back.
  await refresh({ changes: [edit(1, 's60', 's60-title')], drawings: { ...deck.drawings, s60: retitled('s60') } })
  expect(card('s49').classList.contains('listed')).toBe(true)
  await refresh({ changes: [] })
  expect(card('s49').classList.contains('listed')).toBe(false)
  expect(notes()).toBe('Speaker notesMind the gap')
})

it('asks for the fonts its slides are set in, and draws without one it cannot have', async () => {
  const { called, card } = await draw({
    saved: listed('Fonts'),
    fonts: ['Poppins', 'Lora'],
    drawings: { s1: { drawing: slide([{
      ...box('t', 20, 20), text: [{ runs: [run('Bold', { fontFamily: 'Poppins', fontWeight: 700 }), run('Plain'), run('Unlisted', { fontFamily: 'Oswald' })] }],
    }]) } },
  })

  expect(called('listFonts')).toHaveLength(1)
  // Arial is the browser's own, and a family the session did not list is not asked for. A weight
  // that is not served falls back to the family's regular.
  expect(called('readFont')).toEqual([['Poppins', 700, false], ['Poppins', 400, false]])
  expect(card('s1').querySelector<HTMLElement>('[data-id="t"] span')!.style.fontFamily).toContain('Poppins')
})

it('asks for a font a pending change names only once the change is saved, when the session lists it', async () => {
  const set = (id: string) => slide([{ ...box('t', 20, 20), text: [{ runs: [run(id, { fontFamily: 'Poppins' })] }] }])
  const { called, refresh } = await draw({
    saved: listed('Fonts'),
    changes: [edit(1, 's1', 't')],
    drawings: { s1: { drawing: set('new'), saved: slide([box('t', 20, 20, 'old')]) } },
  })
  expect(called('readFont')).toEqual([])

  await refresh({ changes: [], fonts: ['Poppins'], drawings: { s1: { drawing: set('new') } } })
  expect(called('readFont')).toContainEqual(['Poppins', 400, false])
})

it('asks which fonts there are once for a deck read in parts, and counts only fonts that arrive against its limit', async () => {
  const families = Array.from({ length: 30 }, (_, n) => `Family ${'abcdefghijklmnopqrstuvwxyzABCD'[n]}`)
  const { called } = await draw({
    saved: listed(...families),
    fonts: families.slice(0, 28),
    drawings: Object.fromEntries(families.map((fontFamily, n) =>
      [`s${n + 1}`, { drawing: slide([{ ...box('t', 20, 20), text: [{ runs: [run('Text', { fontFamily })] }] }]) }])),
  })

  // Three reads of ten slides, each naming families the others do not, two of them unlisted.
  expect(called('readSlideDrawings')).toHaveLength(3)
  expect(called('listFonts')).toHaveLength(1)
  // None arrives, so the 28th is asked for as the first was: 24 are the most that are held.
  expect(called('readFont').map(([family]) => family)).toEqual(families.slice(0, 28))
})

it('asks again on a refresh for a picture that could not be read', async () => {
  const photo: Piece = { id: 'photo', bounds: { x: 500, y: 200, width: 100, height: 100 }, kind: 'picture', of: 'image', pictureId: 'photo' }
  const { called, refresh, pictured } = await draw({ saved: listed('One'), noPictures: true, drawings: { s1: { drawing: slide([photo]) } } })
  await expect.poll(() => called('readPicture')).toHaveLength(1)

  await refresh({ noPictures: false })

  await pictured('photo')
  expect(called('readPicture')).toHaveLength(2)
})

it('reads a picture a master puts behind its slides once, for every slide and copy that shows it', async () => {
  const logo: Piece = { id: 'logo', from: 'master', bounds: { x: 600, y: 10, width: 80, height: 40 }, kind: 'picture', of: 'image', pictureId: 'logo' }
  const own = (id: string, words: string, more: object = {}) => ({ ...slide([box(`${id}-title`, 20, 20, words, more)]), behind: [0] })
  const { called, all, card, refresh, pictured } = await draw({
    saved: listed('One', 'Two', 'Three'),
    shared: [[logo]],
    changes: [edit(1, 's2', 's2-title')],
    drawings: {
      s1: { drawing: own('s1', 'One') },
      s2: { drawing: own('s2', 'Edited', { changes: [{ id: 1, op: 'editText' }] }), saved: own('s2', 'Two') },
      s3: { drawing: own('s3', 'Three') },
    },
  })

  await pictured('logo')
  // Behind the slide's own, on the three slides and in the filmstrip.
  expect(all('img[data-picture="logo"]').length).toBeGreaterThanOrEqual(6)
  expect(card('s2').querySelector('.sheet .stage')!.firstElementChild!.querySelector('img[data-picture="logo"]')).not.toBeNull()
  expect(called('readPicture')).toHaveLength(1)

  // A slide read again keeps the picture it shares with the others.
  await refresh({ changes: [], drawings: { s1: { drawing: own('s1', 'One') }, s2: { drawing: own('s2', 'Two') }, s3: { drawing: own('s3', 'Three') } } })
  await pictured('logo')
  expect(called('readPicture')).toHaveLength(1)
})

it('leaves no mark of a change that was withdrawn while its slide was being read', async () => {
  const deck: Deck = { saved: listed('One', 'Two'), drawings: {} }
  const { ask, refresh, card, film, all, doc } = await draw(deck)
  const held = Promise.withResolvers<void>()

  // The change is queued and its slide asked for, and before that answers the change is rejected.
  await ask({
    hold: held.promise,
    changes: [edit(1, 's2', 's2-title')],
    drawings: { s2: retitled('s2') },
  })
  const rejected = refresh({ hold: undefined, changes: [], drawings: {} })
  held.resolve()
  await rejected

  expect(all('.spot, .change')).toEqual([])
  expect(card('s2').querySelector('.sheet [data-id="s2-title"]')!.textContent).toBe('s2')
  expect(card('s2').querySelector('.views')).toBeNull()
  expect(film('s2').classList.contains('changed')).toBe(false)
  expect(doc.getElementById('nav')!.hidden).toBe(true)
})

it('draws a table\'s rows as tall as Slides does, whatever its borders weigh, and a connector through its turns', async () => {
  const edge = { color: '#000000', weight: 6 }
  const cell = (words: string) => ({ text: [{ runs: [run(words)] }] })
  const line = (id: string, category: string, via: object[]): Piece => ({
    id, bounds: { x: 0, y: 0, width: 100, height: 60 }, kind: 'line', category, start: { x: 10, y: 10 }, end: { x: 110, y: 70 }, via, stroke: { color: '#000000', weight: 1 },
  })
  const { card } = await draw({
    saved: listed('Table'),
    drawings: { s1: { drawing: slide([
      { id: 'table', bounds: { x: 20, y: 100, width: 400, height: 20 }, kind: 'table', columnWidths: [200, 200], rowHeights: [10, 10],
        cells: [[cell('A'), cell('B')], [cell('C'), cell('D')]],
        horizontalBorders: [[edge, edge], [edge, edge], [edge, edge]], verticalBorders: [[edge, edge, edge], [edge, edge, edge]] },
      line('corner', 'bent', [{ x: 110, y: 10 }]),
      line('elbow', 'bent', [{ x: 60, y: 10 }, { x: 60, y: 70 }]),
      line('sweep', 'curved', [{ x: 60, y: 10 }, { x: 60, y: 70 }]),
      line('direct', 'bent', []),
      { ...line('clear', 'bent', []), stroke: undefined },
      { id: 'mixed', bounds: { x: 20, y: 300, width: 400, height: 40 }, kind: 'shape', shapeType: 'TEXT_BOX',
        text: [{ runs: [run('slanted', { italic: true }), run('upright')] }] },
    ]) } },
  })

  const stage = card('s1').querySelector('.sheet > .stage')!
  // 18pt text is set on lines 21.75pt apart, with 7.2pt above and below it: 36pt, as Slides draws.
  const heights = [...stage.querySelectorAll<HTMLElement>('[data-id="table"] .cell')].map(node => Math.round(node.offsetHeight))
  expect(heights).toEqual([36, 36, 36, 36])
  const path = (id: string) => stage.querySelector(`svg[data-id="${id}"] path`)!.getAttribute('d')
  expect(path('corner')).toBe('M10 10L110 10 110 70')
  expect(path('elbow')).toBe('M10 10L60 10 60 70 110 70')
  expect(path('sweep')).toBe('M10 10C60 10 60 70 110 70')
  expect(path('direct')).toBe('M10 10L110 70')
  // A line with no stroke is transparent, and a run is upright in a paragraph that starts italic.
  expect(stage.querySelector('svg[data-id="clear"] path')).toBeNull()
  const upright = [...stage.querySelectorAll<HTMLElement>('[data-id="mixed"] span')].find(node => node.textContent === 'upright')!
  expect(getComputedStyle(upright).fontStyle).toBe('normal')
})

it('keeps its floating buttons off the slides in a narrow pane', async () => {
  const { card, doc } = await draw({
    saved: listed('One', 'Two'),
    changes: [edit(1, 's1', 's1-title')],
    drawings: { s1: retitled('s1') },
  }, 380)

  const sheet = card('s1').querySelector('.sheet')!.getBoundingClientRect()
  for (const id of ['outline-toggle', 'bar']) expect(doc.getElementById(id)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(sheet.top)
  // Scrolled, a slide passes under the strip the buttons float on, not under the buttons bare.
  const strip = frame!.contentWindow!.getComputedStyle(doc.body, '::before')
  expect([strip.position, strip.height]).toEqual(['fixed', '52px'])
  expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(380)
})

it('follows a link only from a slide no pending change touches', async () => {
  const linked = (more: object = {}) => ({ ...box('t', 20, 20), text: [{ runs: [run('site', { link: 'https://example.com/' }), run('script', { link: 'javascript:alert(1)' })] }], ...more })
  const { card } = await draw({
    saved: listed('Saved', 'Changed'),
    changes: [edit(1, 's2', 'other')],
    drawings: {
      s1: { drawing: slide([linked()]) },
      s2: { drawing: slide([linked(), box('other', 20, 200, 'New', { changes: [{ id: 1, op: 'editText' }] })]), saved: slide([linked(), box('other', 20, 200, 'Old')]) },
    },
  })

  const links = (id: string) => [...card(id).querySelectorAll<HTMLAnchorElement>('.sheet a')].map(link => [link.textContent, link.href, link.target, link.rel])
  expect(links('s1')).toEqual([['site', 'https://example.com/', '_blank', 'noopener noreferrer']])
  expect(links('s2')).toEqual([])
})

it('draws a freeform shape from the path found for it, and hatches the box of one with none', async () => {
  const freeform = (id: string, x: number, more: object = {}): Piece =>
    ({ id, bounds: { x, y: 100, width: 100, height: 50 }, kind: 'shape', shapeType: 'CUSTOM', fill: { color: '#6885cc' }, ...more })
  const path = (more: object = {}) => ({ width: 200, height: 200, ops: 'MLCZ', points: [0, 200, 100, 0, 120, 40, 180, 160, 200, 200], ...more })
  const { card, called } = await draw({
    saved: listed('Freeforms'),
    drawings: { s1: { drawing: slide([
      freeform('drawn', 0, { outline: { color: '#000000', weight: 1 }, paths: [path(), path({ filled: false }), path({ stroked: false })] }),
      freeform('bare', 120),
      // What is no path of numbers is not drawn, whatever else the shape holds.
      freeform('markup', 240, { paths: [path(), path({ ops: 'M"/><script>', points: [0, 0] })] }),
      freeform('words', 360, { paths: [path({ points: [0, 200, 100, 0, 120, 40, 180, '160" onload="x', 200, 200] })] }),
      freeform('short', 480, { paths: [path({ points: [0, 200, 100] })] }),
      freeform('sized', 600, { paths: [path({ width: 0 })] }),
    ]) } },
  })

  const node = (id: string) => card('s1').querySelector<HTMLElement>(`.sheet [data-id="${id}"]`)!
  const drawn = [...node('drawn').querySelectorAll('path')]
  // Scaled from the path's own box of 200 by 200 to the shape's 100 by 50.
  expect(drawn.map(found => found.getAttribute('d'))).toEqual(Array(3).fill('M0 50 L50 0 C60 10 90 40 100 50 Z'))
  expect(drawn.map(found => found.getAttribute('fill'))).toEqual(['#6885cc', 'none', '#6885cc'])
  expect(drawn.map(found => found.getAttribute('stroke') ?? 'none')).toEqual(['#000000', '#000000', 'none'])
  expect(node('drawn').classList.contains('custom')).toBe(false)
  for (const id of ['bare', 'markup', 'words', 'short', 'sized']) {
    expect([id, node(id).classList.contains('custom')]).toEqual([id, true])
    expect(node(id).title).toBe('A freeform shape, which is not drawn here')
    expect([id, node(id).querySelector('path')]).toEqual([id, null])
  }
  expect(card('s1').querySelector('script')).toBeNull()
  // Nothing of Google's own picture of the slide is read for them.
  expect(called('getSlideThumbnail')).toEqual([])
})

it('draws a preset shape with the handles found for it', async () => {
  const arc = (id: string, more: object = {}): Piece =>
    ({ id, bounds: { x: 0, y: 0, width: 100, height: 100 }, kind: 'shape', shapeType: 'BLOCK_ARC', fill: { color: '#6885cc' }, ...more })
  const { card } = await draw({
    saved: listed('Arcs'),
    drawings: { s1: { drawing: slide([arc('moved', { adjust: [10_800_000, 16_200_000, 10_000] }), arc('unmoved'), arc('odd', { adjust: 'M0 0' })]) } },
  })

  const d = (id: string) => card('s1').querySelector(`.sheet [data-id="${id}"] path`)!.getAttribute('d')
  expect(d('moved')).toBe('M0,50 A50,50 0 0 1 50,0 L50,10 A40,40 0 0 0 10,50 Z')
  expect(d('unmoved')).toBe('M0,50 A50,50 0 0 1 50,0 A50,50 0 0 1 100,50 L75,50 A25,25 0 0 0 50,25 A25,25 0 0 0 25,50 Z')
  expect(d('odd')).toBe(d('unmoved'))
})

it('reads slides too large to read together a few at a time, and only names one too large to read at all', async () => {
  const deck: Deck = { saved: listed('One', 'Two', 'Huge', 'Four', 'Five'), drawings: {}, weights: { s3: 4 } }
  const { doc, card, called, text, refresh } = await draw(deck)

  // Halved until each read is small enough: the slide that is too large alone is asked for last by itself.
  expect(called('readSlideDrawings').map(([ids]) => (ids as string[]).join())).toEqual(['s1,s2,s3,s4,s5', 's1,s2', 's3,s4,s5', 's3', 's4,s5'])
  expect(doc.getElementById('error')).toBeNull()
  for (const id of ['s1', 's2', 's4', 's5']) expect(card(id).querySelector('.sheet [data-id]')!.textContent).toBe(id)
  expect(card('s3').classList.contains('listed')).toBe(true)
  expect(card('s3').querySelector<HTMLElement>('.frame')!.hidden).toBe(true)
  expect(card('s3').querySelector('header')!.textContent).toBe('3HugeToo large to draw')
  expect(text('.film.listed')).toEqual(['3Huge'])

  // Not asked for again until the slide changes, and drawn once it can be read.
  await refresh({})
  expect(called('readSlideDrawings')).toHaveLength(5)
  await refresh({ saved: listed('One', 'Two', 'Smaller', 'Four', 'Five'), weights: {} })
  expect(called('readSlideDrawings').slice(5)).toEqual([[['s3']]])
  expect(card('s3').classList.contains('listed')).toBe(false)
  expect(card('s3').querySelector('header')!.textContent).toBe('3Smaller')
})

// A freeform's outline comes from an export Google may be slow to make: the read says so, and the
// slides it says it of are read again shortly.
describe('shapes whose outlines are still on their way', () => {
  const PATH = { width: 100, height: 50, ops: 'MLLZ', points: [0, 50, 50, 0, 100, 50] }
  const freeform = (paths?: object[]): Piece =>
    ({ id: 'f', bounds: { x: 300, y: 100, width: 100, height: 50 }, kind: 'shape', shapeType: 'CUSTOM', fill: { color: '#6885cc' }, ...(paths ? { paths } : {}) })
  const label = (words: string, more: object = {}) => box('label', 20, 300, words, more)
  const edited = (paths?: object[]) => ({
    drawing: slide([freeform(paths), label('New', { changes: [{ id: 1, op: 'editText' }] })]), saved: slide([freeform(paths), label('Old')]),
  })
  const waiting = (): Deck => ({
    saved: listed('Shapes', 'Other'), changes: [edit(1, 's1', 'label')], drawings: { s1: { ...edited(), outlinesPending: true } },
  })
  const reads = (called: (name: string) => unknown[][]) => called('readSlideDrawings').map(([ids]) => (ids as string[]).join())

  it('shows them as loading, then draws them from a second read of just their slides, with the view and the places as they were', async () => {
    const deck = waiting()
    const { card, called, doc } = await draw(deck)
    const shape = () => card('s1').querySelector<HTMLElement>('.sheet [data-id="f"]')!
    expect([shape().classList.contains('wait'), shape().classList.contains('custom'), shape().title]).toEqual([true, false, 'Loading this shape'])
    card('s1').querySelector<HTMLElement>('.views [data-view="before"]')!.click()
    // Opening scrolls to the first change: where that leaves the page is where it should stay.
    await new Promise(resolve => setTimeout(resolve, 800))
    const [spot, chip, top] = [card('s1').querySelector('.spot'), card('s1').querySelector('.change'), doc.scrollingElement!.scrollTop]
    const stops = doc.getElementById('nav')!.getAttribute('aria-label')

    deck.drawings.s1 = edited([PATH])
    await expect.poll(() => shape().querySelector('path')?.getAttribute('d'), { timeout: 6000 }).toBe('M0 50 L50 0 L100 50 Z')

    expect(reads(called)).toEqual(['s1,s2', 's1'])
    expect(shape().classList.contains('wait')).toBe(false)
    expect(card('s1').querySelector('.views [aria-pressed="true"]')!.textContent).toBe('As saved')
    expect(card('s1').querySelector('.sheet [data-id="label"]')!.textContent).toBe('Old')
    expect([card('s1').querySelector('.spot'), card('s1').querySelector('.change'), doc.scrollingElement!.scrollTop]).toEqual([spot, chip, top])
    expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe(stops)
    expect(card('s1').querySelector('.sheet .first')).toBeNull()
  })

  it('asks three times more, then draws them as shapes with no outline', async () => {
    const { card, called } = await draw(waiting())
    const shape = () => card('s1').querySelector<HTMLElement>('.sheet [data-id="f"]')!

    await expect.poll(() => shape().classList.contains('custom'), { timeout: 20_000, interval: 250 }).toBe(true)

    expect(reads(called)).toEqual(['s1,s2', 's1', 's1', 's1'])
    expect([shape().classList.contains('wait'), shape().title]).toEqual([false, 'A freeform shape, which is not drawn here'])
  }, 30_000)

  it('reads them again as few at a time as it first read them, however many wait', async () => {
    const ids = Array.from({ length: 12 }, (_slide, n) => `s${n + 1}`)
    const all = (paths?: object[]) => Object.fromEntries(ids.map(id =>
      [id, { drawing: slide([freeform(paths)]), ...(paths ? {} : { outlinesPending: true as const }) }]))
    const deck: Deck = { saved: listed(...ids), drawings: all() }
    const { card, called } = await draw(deck)

    deck.drawings = all([PATH])
    await expect.poll(() => card('s12').querySelector('.sheet [data-id="f"] path'), { timeout: 6000 }).not.toBeNull()

    const [first, rest] = [ids.slice(0, 10).join(), ids.slice(10).join()]
    expect(reads(called)).toEqual([first, rest, first, rest])
    expect(card('s1').querySelector('.sheet [data-id="f"] path')).not.toBeNull()
  })

  it('leaves off asking when the presentation is read afresh, which reads them itself', async () => {
    const deck = waiting()
    const { card, called, refresh } = await draw(deck)

    await refresh({ drawings: { s1: edited([PATH]) } })
    expect(reads(called)).toEqual(['s1,s2', 's1'])
    expect(card('s1').querySelector('.sheet [data-id="f"] path')).not.toBeNull()
    await new Promise(resolve => setTimeout(resolve, 2600))

    expect(reads(called)).toEqual(['s1,s2', 's1'])
  })
})

it('reads again only the slides a change touches, now or before', async () => {
  const deck: Deck = { saved: listed('One', 'Two', 'Three'), drawings: {} }
  const { called, refresh, card, doc } = await draw(deck)
  expect(called('readSlideDrawings')).toEqual([[['s1', 's2', 's3']]])

  await refresh({
    changes: [edit(1, 's2', 's2-title')],
    drawings: { s2: retitled('s2') },
  })
  expect(called('readSlideDrawings').slice(1)).toEqual([[['s2']]])
  expect(card('s2').querySelector('.spot')!.classList.contains('fresh')).toBe(true)
  expect(doc.getElementById('nav')!.getAttribute('aria-label')).toBe('1 changed place')

  // Once the change is gone the slide is read once more, as it now is saved.
  await refresh({ changes: [], drawings: {} })
  expect(called('readSlideDrawings').slice(2)).toEqual([[['s2']]])
  expect(card('s2').querySelector('.spot')).toBeNull()
  expect(doc.getElementById('nav')!.hidden).toBe(true)
})

it('says so when a presentation has no slides, and offers to try again when it cannot be read', async () => {
  const { text, doc } = await draw({ saved: [], drawings: {} })
  expect(text('.empty')).toEqual(['This presentation has no slides.'])
  expect(doc.getElementById('outline')!.hidden).toBe(true)
  frame!.remove()

  const deck: Deck = { saved: listed('One'), drawings: {}, broken: true }
  const failed = await draw(deck)
  const error = failed.doc.querySelector<HTMLElement>('#error[role=alert]')!
  expect(error.textContent).toContain('The presentation is gone')
  expect(failed.all('.card')).toHaveLength(0)
  deck.broken = false
  error.querySelector('button')!.click()
  await expect.poll(() => failed.card('s1')?.querySelector('.sheet [data-id="s1-title"]')?.textContent).toBe('s1')
  expect(failed.doc.getElementById('error')).toBeNull()
})
