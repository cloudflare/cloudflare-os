/* eslint-disable react/react-in-jsx-scope */

// SPIKE: a connection preview in Chromium. The frame is the real gadget UI frame and its `gadget`
// stub is a connection session reached over Cap'n Web, so this is what shows the two work
// together: jsdom runs neither the sandbox nor the frame's module.

import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Toasty } from '@cloudflare/kumo'
import { RpcStub, RpcTarget } from 'capnweb'
import type { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { ConnectionPreview } from './connectionPreview'
import { ConnectionPreviewPane } from './ConnectionPreviewPane'
import { DOCS_PREVIEW_BUNDLE } from './docsPreviewBundle'
import '../../styles.css'

const DOC_ID = 7
const SAVED = [
  '# Paul Pierce',
  '## Why LeBron is better',
  '- **Four championships** with three different franchises \\(Miami, Cleveland and the Lakers\\).',
  '- **Durability**: still playing at an All\\-Star level into his 40s.',
  '<table>',
  '  <tr>',
  '    <td><p>Season</p></td>',
  '    <td><p><a href="https://example.com/stats">Points</a></p></td>',
  '  </tr>',
  '</table>',
  'See [the record](https://example.com/record) for more.',
  '\\[Image\\]',
].join('\n')
const DURABILITY = '- **Durability**: still playing at an All\\-Star level into his 40s.'
const LONGEVITY = '- **Longevity**: 21 seasons and counting.'
const DRAFTED = '- **Playoff résumé**: the all\\-time leader in playoff points.'

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

type Doc = { saved: string, markdown: string, changes: object[], calls: string[] }

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
    return [{ id: 't.0', title: 'Tab 1', index: 0, nestingLevel: 0 }]
  }

  getContent() {
    this.doc.calls.push('getContent')
    return this.doc.markdown
  }

  getPendingChanges() {
    this.doc.calls.push('getPendingChanges')
    const { saved, markdown, changes } = this.doc
    return { savedMarkdown: saved, markdown, changes }
  }

  getStyles() {
    this.doc.calls.push('getStyles')
    return { named: { HEADING_1: { color: '#4a86e8', alignment: 'center' } }, paragraphs: [{ line: 0, style: 'TITLE' }] }
  }

  listImages() {
    this.doc.calls.push('listImages')
    return [{ id: 'photo', width: 120, height: 80, readable: true }]
  }

  readImage(id: string) {
    this.doc.calls.push(`readImage ${id}`)
    const bytes = Uint8Array.from(atob(PIXEL), character => character.charCodeAt(0))
    return { mimeType: 'image/png', bytes }
  }

  replaceText() {
    this.doc.calls.push('replaceText')
  }
}

class DocConnection extends RpcTarget {
  constructor(private doc: Doc) {
    super()
  }

  openSession() {
    return new DocSession(this.doc)
  }

  getPreviewUi() {
    return DOCS_PREVIEW_BUNDLE
  }
}

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  root?.unmount()
  container?.remove()
})

const renderPane = (pending: ActionLogEntry[]) => {
  // One change is already pending when the pane opens: a bullet reworded.
  const doc: Doc = {
    saved: SAVED,
    markdown: SAVED.replace(DURABILITY, LONGEVITY),
    changes: [{ id: 11, type: 'replaceText', oldMarkdown: DURABILITY, newMarkdown: LONGEVITY }],
    calls: [],
  }
  const resolved: string[] = []
  const created: ConnectionPreview[] = []
  let subscriber: ActionsSubscriber | undefined
  const resolve = (decision: string) => async (id: number) => {
    resolved.push(`${decision} ${id}`)
  }
  const overseer = {
    getGatekeeperById: () => new RpcStub(new DocConnection(doc)),
    subscribeToActions: async (target: ActionsSubscriber) => {
      subscriber = target
      return { [Symbol.dispose]: () => {} }
    },
    listActions: async () => ({ entries: pending }),
    approveAction: resolve('approve'),
    rejectAction: resolve('reject'),
  } as unknown as RpcStub<Overseer>

  container = document.body.appendChild(document.createElement('div'))
  container.style.height = '700px'
  root = createRoot(container)
  flushSync(() => root!.render(
    <Toasty>
      <ConnectionPreviewPane
        overseer={overseer}
        preview={{ gatekeeperId: DOC_ID, title: 'Paul Pierce' }}
        restricted={false}
        onCreated={preview => created.push(preview)}
      />
    </Toasty>,
  ))
  return { doc, resolved, created, emit: (entry: ActionLogEntry) => subscriber!.entry(entry) }
}

// The frame's origin is opaque, so its DOM is out of this page's reach and the session's call log
// is what the test can see of it.

it('reads the document through the connection session and redraws when an action is queued', async () => {
  await page.viewport(1100, 800)
  const { doc, resolved, emit } = renderPane([action(1)])

  // One read gives the frame the saved tab, the tab with its pending changes, and the changes.
  // The tab's styles and images are read once, through the session.
  const opened = ['listTabs', 'getPendingChanges', 'getStyles', 'listImages', 'readImage photo']
  await expect.poll(() => doc.calls).toEqual(opened)
  await expect.element(page.getByText('1 change waiting')).toBeVisible()

  // The agent queues another edit: the session now simulates it, and the log says so.
  doc.markdown = `${doc.markdown}\n${DRAFTED}`
  doc.changes = [...doc.changes, { id: 12, type: 'appendText', markdown: DRAFTED }]
  emit(action(2))
  await expect.poll(() => doc.calls).toEqual([...opened, 'listTabs', 'getPendingChanges'])
  // The card holds the oldest, and says it is one of several.
  await expect.element(page.getByText('1 of 2 changes waiting')).toBeVisible()

  // The preview's own reads come back as observations on this connection, and must not redraw it.
  emit(action(3, { type: 'observation' } as Partial<ActionLogEntry>))
  await new Promise(done => setTimeout(done, 600))
  expect(doc.calls).toEqual([...opened, 'listTabs', 'getPendingChanges'])

  // Apply is the Workshop's, outside the frame, and takes the oldest change first.
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => resolved).toEqual(['approve 1'])
  expect(doc.calls).not.toContain('replaceText')
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
  expect(created).toEqual([{ gatekeeperId: DOC_ID, title: 'Made', url }])
})
