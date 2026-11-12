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
import { ConnectionPreviewPane } from './ConnectionPreviewPane'
import DOCS_PREVIEW_CLIENT from '../../../../gatekeeper-google/src/docs-preview-client.txt?raw'
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
    return { jsCode: DOCS_PREVIEW_CLIENT }
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
      />
    </Toasty>,
  ))
  return { doc, resolved, emit: (entry: ActionLogEntry) => subscriber!.entry(entry) }
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
  await expect.poll(() => doc.calls).toEqual([...opened, 'getPendingChanges'])
  await expect.element(page.getByText('2 changes waiting')).toBeVisible()

  // The preview's own reads come back as observations on this connection, and must not redraw it.
  emit(action(3, { type: 'observation' } as Partial<ActionLogEntry>))
  await new Promise(done => setTimeout(done, 600))
  expect(doc.calls).toEqual([...opened, 'getPendingChanges'])

  // Apply is the Workshop's, outside the frame, and takes the oldest change first.
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => resolved).toEqual(['approve 1'])
  expect(doc.calls).not.toContain('replaceText')
})
