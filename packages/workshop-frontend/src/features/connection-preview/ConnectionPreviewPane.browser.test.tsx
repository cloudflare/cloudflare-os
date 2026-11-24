/* eslint-disable react/react-in-jsx-scope */

// SPIKE: a connection preview in Chromium. The frame is the real gadget UI frame and its `gadget`
// stub is a connection session reached over Cap'n Web, so this is what shows the two work
// together: jsdom runs neither the sandbox nor the frame's module.

import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Toasty } from '@cloudflare/kumo'
import { RpcStub, RpcTarget } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, GadgetFocus, Overseer } from '@gadgets/workshop-shared/api'
import type { ConnectionPreview } from './connectionPreview'
import { ConnectionPreviewPane } from './ConnectionPreviewPane'
import { DOCS_PREVIEW_BUNDLE } from './docsPreviewBundle'
import { DRIVE_PREVIEW_BUNDLE } from './drivePreviewBundle'
import '../../styles.css'

const DOC_ID = 7

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type Change = { id: number, type: 'replaceText' | 'appendText', oldMarkdown?: string, newMarkdown?: string, markdown?: string }
type Doc = { changes: Change[], calls: string[], folder?: true, tabs?: string[], away?: true }

const NAMED_STYLES = ['NORMAL_TEXT', 'TITLE', 'SUBTITLE', ...Array.from({ length: 6 }, (_, level) => `HEADING_${level + 1}`)]
/** A paragraph of `text`, as a drawing and a pending drawing both tell one. */
const paragraph = (text: string) => ({ type: 'paragraph', style: 'NORMAL_TEXT', look: 0, end: 0, runs: [{ look: 0, text }] })

const action = (id: number, over: Partial<ActionLogEntry> = {}) => ({
  id,
  gatekeeperId: DOC_ID,
  resourceTitle: 'Paul Pierce',
  resourceUrl: 'https://docs.google.com/document/d/abc/edit',
  createdAt: new Date(1_700_000_000_000 + id * 60_000),
  state: 'pending',
  type: 'action',
  description: {
    title: 'Edit Google Doc', description: `Change ${id}`, implementsRevert: false, autoApprovable: true,
  },
  ...over,
}) as ActionLogEntry

/** The connection's session, as GoogleDocSession offers it, counting what the frame calls. */
class DocSession extends RpcTarget {
  constructor(private doc: Doc) {
    super()
  }

  listTabs() {
    this.doc.calls.push('listTabs')
    return (this.doc.tabs ?? ['t.0']).map((id, index) => ({
      id, title: `Tab ${index + 1}`, index, nestingLevel: 0, ...this.doc.changes.length ? { pending: true } : {},
    }))
  }

  getPendingChanges(tabId: string) {
    this.doc.calls.push('getPendingChanges')
    return { tabId, changes: this.doc.changes }
  }

  // What the pending changes put in the saved tab's place: an edit for each one listed, which
  // rewords the tab's first paragraph or writes one after its last.
  readPendingDrawing(tabId: string) {
    this.doc.calls.push('readPendingDrawing')
    const edits = this.doc.changes.map(change => change.type === 'replaceText'
      ? { start: 1, end: 12, blocks: [paragraph(change.newMarkdown!)] }
      : { start: 14, end: 14, blocks: [paragraph(change.markdown!)] })
    return { tabId, version: 'v1', edits, paragraphLooks: [{}], textLooks: [{}], lists: {} }
  }

  // The tab as Google Docs draws it: here a paragraph of text, and one that holds an image.
  readDrawing() {
    this.doc.calls.push('readDrawing')
    return {
      version: 'v1',
      page: { width: 612, height: 792 },
      sections: [{ margins: { top: 72, right: 72, bottom: 72, left: 72, header: 36, footer: 36 } }],
      blocks: [
        { ...paragraph('Durability'), range: { start: 1, end: 12 } },
        { ...paragraph(''), range: { start: 12, end: 14 }, runs: [{ look: 0, object: 'photo' }] },
      ],
      headers: {}, footers: {}, footnotes: {}, lists: {},
      objects: { photo: { width: 120, height: 80, readable: true } },
      paragraphLooks: [{ lineSpacing: 1.15 }],
      textLooks: [{ fontFamily: 'Arial', fontSize: 11, weight: 400 }],
      named: Object.fromEntries(NAMED_STYLES.map(name => [name, { paragraph: 0, text: 0 }])),
    }
  }

  readImage(id: string) {
    this.doc.calls.push(`readImage ${id}`)
    const bytes = Uint8Array.from(atob(PIXEL), character => character.charCodeAt(0))
    return { mimeType: 'image/png', content: new Blob([bytes]).stream() }
  }

  replaceText() {
    this.doc.calls.push('replaceText')
  }
}

/** The session of a connection that reaches several documents, as GoogleDriveSession opens them. */
class FolderSession extends RpcTarget {
  constructor(private doc: Doc) {
    super()
  }

  openFolder(id: string) {
    this.doc.calls.push(`openFolder ${id}`)
    return new FolderSession(this.doc)
  }

  openGoogleDoc(fileId: string) {
    this.doc.calls.push(`openGoogleDoc ${fileId}`)
    if (this.doc.away) throw new Error('Google is away')
    return new DocSession(this.doc)
  }
}

class DocConnection extends RpcTarget {
  constructor(private doc: Doc) {
    super()
  }

  connectToGadget() {
    return this.doc.folder ? new FolderSession(this.doc) : new DocSession(this.doc)
  }

  getUiBundle() {
    return this.doc.folder ? DRIVE_PREVIEW_BUNDLE : DOCS_PREVIEW_BUNDLE
  }
}

/** The Workshop's answer for a connection: its client, once `ready`. */
class Clients extends RpcTarget {
  constructor(private doc: Doc, private ready?: Promise<void>) {
    super()
  }

  async open() {
    await this.ready
    return new DocConnection(this.doc)
  }
}

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  root?.unmount()
  container?.remove()
})

/**
 * Renders the pane on a document, or on the `item` of a connection that reaches several. Its frame
 * is sent to `at`, the spot a preview was left at, or else to the item.
 */
const renderPane = (
  pending: ActionLogEntry[], item?: string,
  { at = item, tabs, refused, listed, away }: { at?: string, tabs?: string[], refused?: true, listed?: Promise<void>, away?: true } = {},
) => {
  // One change is already pending when the pane opens: a bullet reworded.
  const doc: Doc = {
    changes: [{ id: 11, type: 'replaceText', oldMarkdown: 'Durability', newMarkdown: 'Longevity' }],
    calls: [],
    tabs,
    away,
    ...(item === undefined ? {} : { folder: true }),
  }
  const said: (GadgetFocus | null)[] = []
  const resolved: string[] = []
  const created: ConnectionPreview[] = []
  let subscriber: ActionsSubscriber | undefined
  const resolve = (decision: string) => async (id: number) => {
    resolved.push(`${decision} ${id}`)
    if (refused) throw new Error('The document has changed.')
  }
  // Each a new connection to the Workshop, as a reconnect makes one: its client is a promise, as
  // the Workshop's is, which answers once what `hold()` returned is called.
  let held: Promise<void> | undefined
  const hold = () => {
    const { promise, resolve: release } = Promise.withResolvers<void>()
    held = promise
    return release
  }
  const connect = () => ({
    getGatekeeperById: () => new RpcStub(new Clients(doc, held)).open(),
    subscribeToActions: async (target: ActionsSubscriber) => {
      subscriber = target
      return { [Symbol.dispose]: () => {} }
    },
    listActions: async () => {
      await listed
      return { entries: pending }
    },
    approveAction: resolve('approve'),
    rejectAction: resolve('reject'),
  }) as unknown as RpcStub<Overseer>

  container = document.body.appendChild(document.createElement('div'))
  container.style.height = '700px'
  root = createRoot(container)
  const show = () => flushSync(() => root!.render(
    <Toasty>
      <ConnectionPreviewPane
        overseer={connect()}
        preview={{ gatekeeperId: DOC_ID, item, title: 'Paul Pierce' }}
        restricted={false}
        focus={{ anchor: at, latestAnchor: () => at, navigation: 0, onFocusChange: focus => said.push(focus) }}
        onCreated={preview => created.push(preview)}
      />
    </Toasty>,
  ))
  show()
  return { doc, resolved, created, said, reconnect: show, hold, emit: (entry: ActionLogEntry) => subscriber!.entry(entry) }
}

// The frame's origin is opaque, so its DOM is out of this page's reach and the session's call log
// is what the test can see of it.

it('reads the document through the connection session and redraws when an action is queued', async () => {
  await page.viewport(1100, 800)
  const { doc, resolved, emit } = renderPane([action(1)])

  // The frame reads the changes, what they put in the saved tab's place, and the saved tab's
  // drawing and images, all through the session.
  const again = ['listTabs', 'getPendingChanges', 'readPendingDrawing']
  const opened = [...again, 'readDrawing', 'readImage photo']
  await expect.poll(() => doc.calls).toEqual(opened)
  await expect.element(page.getByText('1 change waiting')).toBeVisible()

  // The agent queues another edit, and the log says so: the changes are read again, and the
  // saved tab's drawing, which Google Docs still names the same, is not.
  doc.changes = [...doc.changes, { id: 12, type: 'appendText', markdown: 'Playoff résumé' }]
  emit(action(2))
  await expect.poll(() => doc.calls).toEqual([...opened, ...again])
  // The card holds the oldest, and says it is one of several.
  await expect.element(page.getByText('1 of 2 changes waiting')).toBeVisible()

  // The preview's own reads come back as observations on this connection, and must not redraw it.
  emit(action(3, { type: 'observation' } as Partial<ActionLogEntry>))
  await new Promise(done => setTimeout(done, 600))
  expect(doc.calls).toEqual([...opened, ...again])

  // Apply is the Workshop's, outside the frame, and takes the oldest change first.
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => resolved).toEqual(['approve 1'])
  expect(doc.calls).not.toContain('replaceText')
})

it('reads again after an Apply the connection refuses, which may have left the change stale', async () => {
  await page.viewport(1100, 800)
  const { doc } = renderPane([action(1)], undefined, { refused: true })
  await expect.poll(() => doc.calls).toContain('readImage photo')
  const reads = doc.calls.length

  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => doc.calls.slice(reads)).toEqual(['listTabs', 'getPendingChanges', 'readPendingDrawing'])
})

it('holds Apply and Discard until every waiting change is listed, since they act on the oldest', async () => {
  await page.viewport(1100, 800)
  let list!: () => void
  const { emit } = renderPane([action(1)], undefined, { listed: new Promise(done => { list = done }) })

  // A change queued as the pane opens arrives before the older ones are listed.
  await vi.waitFor(() => emit(action(2)))
  await expect.element(page.getByText('1 change waiting')).toBeVisible()
  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await expect.element(page.getByRole('button', { name: 'Discard' })).toBeDisabled()

  list()
  await expect.element(page.getByText('1 of 2 changes waiting')).toBeVisible()
  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeEnabled()
})

it('names the waiting action in two lines, and shows everything it sends, which the frame may not draw, when asked', async () => {
  await page.viewport(1100, 800)
  renderPane([action(1, {
    description: {
      title: 'Comment on a Google Doc', description: 'Add a comment.', implementsRevert: false, autoApprovable: true,
      fields: [{ label: 'Comment', kind: 'text', value: 'Please cut this paragraph' }],
    },
  } as Partial<ActionLogEntry>)])

  const card = page.getByRole('region', { name: 'Changes waiting' })
  await expect.element(card.getByText('Add a comment.')).toBeVisible()
  expect(card.getByText('Please cut this paragraph').query()).toBeNull()
  // Its gatekeeper did not mark the description complete, which the approver is told either way.
  await expect.element(card.getByRole('note')).toBeVisible()

  await card.getByRole('button', { name: 'More detail' }).click()
  await expect.element(card.getByText('Please cut this paragraph')).toBeVisible()
  await card.getByRole('button', { name: 'Less detail' }).click()
  expect(card.getByText('Please cut this paragraph').query()).toBeNull()
})

it('gives a short value a line beside its label, a longer one a block, and draws the names in its prose as values', async () => {
  await page.viewport(1100, 800)
  renderPane([action(1, {
    description: {
      title: 'Change slide 2', description: 'On slide 2, edit the text of shape `i0`.',
      implementsRevert: false, autoApprovable: true, descriptionIsComplete: true,
      fields: [
        { label: 'Find', kind: 'inline', value: '75%' },
        { label: 'Replace with', kind: 'inline', value: '80%' },
        { label: 'Notes', kind: 'text', value: 'One\nTwo' },
      ],
    },
  } as Partial<ActionLogEntry>)])

  const card = page.getByRole('region', { name: 'Changes waiting' })
  await card.getByRole('button', { name: 'More detail' }).click()
  const box = (text: string) => card.getByText(text, { exact: true }).element().getBoundingClientRect()
  // The label and its value share a line, and the next pair is on the line below.
  expect(Math.abs(box('Find').top - box('75%').top)).toBeLessThanOrEqual(4)
  expect(box('75%').left).toBeGreaterThan(box('Find').right)
  expect(box('Replace with').top).toBeGreaterThan(box('Find').bottom - 1)
  // A value of several lines keeps the block every other surface gives it, under its label.
  expect(card.getByText('One\nTwo').element().tagName).toBe('PRE')
  expect(card.getByText('i0', { exact: true }).element().tagName).toBe('CODE')
})

it('keeps the card small over the foot of the document, and within the pane however much the waiting action sends', async () => {
  await page.viewport(1100, 800)
  renderPane([action(1, {
    description: {
      title: 'Append to a Google Doc', description: 'Add text.', implementsRevert: false, autoApprovable: true,
      fields: [{ label: 'Text', kind: 'text', value: Array.from({ length: 80 }, (_, line) => `Line ${line}`).join('\n') }],
    },
  } as Partial<ActionLogEntry>)])

  await expect.element(page.getByRole('button', { name: 'Apply' })).toBeVisible()
  const card = () => container!.querySelector('section')!.getBoundingClientRect()
  const frame = () => container!.querySelector('iframe')!.getBoundingClientRect()
  expect(card().height).toBeLessThanOrEqual(170)
  await page.getByRole('button', { name: 'More detail' }).click()
  await expect.element(page.getByRole('button', { name: 'Less detail' })).toBeVisible()
  // Opened, it scrolls inside half the pane, and its buttons stay in view.
  expect(card().height).toBeLessThanOrEqual(frame().height / 2 + 1)
  expect(card().bottom).toBeLessThanOrEqual(frame().bottom)
  expect(page.getByRole('button', { name: 'Apply' }).element().getBoundingClientRect().bottom).toBeLessThanOrEqual(card().bottom)
})

it('opens anew on the document a creation made, whose approval ends the session it was reading through', async () => {
  const { created, emit } = renderPane([])
  const url = 'https://docs.google.com/document/d/made/edit'

  emit(action(2, { creation: true, state: 'pending' }))
  expect(created).toEqual([])

  emit(action(2, { creation: true, state: 'approved', resourceTitle: 'Made', resourceUrl: url }))
  expect(created).toEqual([{ gatekeeperId: DOC_ID, title: 'Made', url, iconUrl: undefined }])
})

it('draws the item of a connection its frame is sent to, with only its changes on the card', async () => {
  await page.viewport(1100, 800)
  const on = (id: string, n: number) => ({
    description: {
      title: 'Edit Google Doc', description: `Change ${n}`, implementsRevert: false, autoApprovable: true,
      previewOf: { anchor: id, title: id },
    },
  } as Partial<ActionLogEntry>)
  const { doc, resolved, emit } = renderPane(
    [action(1, on('docs:other', 1)), action(2, on('docs:nested/file', 2))], 'docs:nested/file')

  // The frame holds the connection's session, and its code opens the item it is sent to as a
  // gadget would: through the folder the item's name gives.
  await expect.poll(() => doc.calls).toContain('getPendingChanges')
  expect(doc.calls.slice(0, 2)).toEqual(['openFolder nested', 'openGoogleDoc file'])
  await expect.element(page.getByText('1 change waiting')).toBeVisible()
  await expect.element(page.getByText('Change 2')).toBeVisible()

  // A change to another item of the connection is not this pane's to redraw for or to apply.
  await expect.poll(() => doc.calls).toContain('readImage photo')
  const reads = doc.calls.length
  emit(action(3, on('docs:other', 3)))
  await new Promise(done => setTimeout(done, 600))
  expect(doc.calls).toHaveLength(reads)
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => resolved).toEqual(['approve 2'])
})

it('reads an item again once a change to its connection is approved, which may have moved it out of reach', async () => {
  await page.viewport(1100, 800)
  const { doc, emit } = renderPane([], 'docs:file')
  await expect.poll(() => doc.calls).toContain('readImage photo')
  const reads = doc.calls.length

  // A move names no item. Queued, it has changed nothing yet.
  emit(action(1, { state: 'pending' }))
  await new Promise(done => setTimeout(done, 600))
  expect(doc.calls).toHaveLength(reads)

  emit(action(1, { state: 'approved' }))
  await expect.poll(() => doc.calls.length).toBeGreaterThan(reads)
})

it('starts an item\'s frame again on a new connection to the Workshop, which the session of its file does not outlive', async () => {
  const { doc, reconnect } = renderPane([], 'docs:file')
  const opens = () => doc.calls.filter(call => call === 'openGoogleDoc file')
  await expect.poll(() => doc.calls).toContain('readImage photo')
  expect(opens()).toHaveLength(1)

  reconnect()
  await expect.poll(opens).toHaveLength(2)
})

it('keeps an item\'s frame until the client of the new connection answers, however long the Workshop was away', async () => {
  const { doc, reconnect, hold } = renderPane([], 'docs:file')
  const opens = () => doc.calls.filter(call => call === 'openGoogleDoc file')
  const frame = () => container!.querySelector('iframe')
  await expect.poll(() => doc.calls).toContain('readImage photo')
  const drawn = frame()

  // Nothing is loaded against a client still on its way: a load has only so long to answer.
  const answer = hold()
  reconnect()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect([frame(), opens().length]).toEqual([drawn, 1])

  answer()
  await expect.poll(opens).toHaveLength(2)
  expect(frame()).not.toBe(drawn)
})

it('sends the frame to the spot its preview was left at, and hears from it where the reader is', async () => {
  const { said } = renderPane([], undefined, { at: '?tab=t.1', tabs: ['t.0', 't.1'] })

  // Sent nowhere it would open on the first tab.
  await expect.poll(() => said).toEqual([{ anchor: '?tab=t.1', label: 'Tab 2' }])
})

it('hears of a spot in an item by the item\'s name, which sends the frame back to both', async () => {
  const { doc, said } = renderPane([], 'docs:file', { at: 'docs:file ?tab=t.1', tabs: ['t.0', 't.1'] })

  // Nothing of the file alone first: its host would keep that in place of the spot it is sent to.
  await expect.poll(() => said).toEqual([{ anchor: 'docs:file ?tab=t.1', label: 'Document › Tab 2' }])
  expect(doc.calls[0]).toBe('openGoogleDoc file')
})

it('keeps the spot in an item whose file could not be opened this time', async () => {
  const { doc, said } = renderPane([], 'docs:file', { at: 'docs:file ?tab=t.1', tabs: ['t.0', 't.1'], away: true })

  await expect.poll(() => doc.calls).toEqual(['openGoogleDoc file'])
  // The frame says the file could not be loaded, and not that the spot is gone, which its host
  // would then forget.
  await new Promise(done => setTimeout(done, 500))
  expect(said).toEqual([])
})
