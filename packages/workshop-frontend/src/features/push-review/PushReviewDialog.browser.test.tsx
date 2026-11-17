/* eslint-disable react/react-in-jsx-scope */

// The push review in Chromium, for what jsdom does not model: where focus goes, the keyboard in
// the list, how the dialog lays out at a wide and a narrow width, and that the real diff editor
// leaves nothing the push sends off screen. What the review shows and when it can be approved
// are tested in its jsdom suite.

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, FileAtCommit, Overseer, PushReview, PushReviewEntry, TreeNode,
} from '@gadgets/workshop-shared/api'
import { ThemeProvider } from '../../ThemeContext'
import { PushReviewDialog } from './PushReviewDialog'
import '../../styles.css'

const oid = (name: string) => name.padEnd(40, '0')
const A = oid('a1')
const B = oid('b2')

const LONG_VALUE = 'x'.repeat(1500)
const LONG_PATH = `${Array.from({ length: 30 }, (_, index) => `directory-${index}`).join('/')}/file.txt`
const LONG_REQUEST = `Push commit ${'c'.repeat(600)} to branch main. ${'Force push. '.repeat(60)}`
// A line with no space to break at, and one whose end hides behind three hundred spaces.
const WIDE_TEXT = `${'w'.repeat(5000)}\nok = true;${' '.repeat(300)}tail\n`

const commitText = (headers: string, message: string) =>
  `tree ${oid('f')}\nauthor Ada <ada@example.com> 1700000000 +0100\n` +
  `committer Bob <bob@example.com> 1700000050 -0700\n${headers}\n${message}`
const FIRST = commitText(`gpgsig ${LONG_VALUE}\n`, `Add the widget\n\n${'A paragraph of the message. '.repeat(80)}\n`)
const SECOND = commitText('', 'Tune the widget\n')

const ENTRIES: PushReviewEntry[] = [
  { kind: 'commit', oid: A, parents: [], size: FIRST.length, text: FIRST },
  { kind: 'path', commit: A, path: '', entry: { kind: 'dir', oid: oid('d1') }, parents: [], sent: { kind: 'dir', size: 90 } },
  { kind: 'path', commit: A, path: 'README.md', entry: { kind: 'file', oid: oid('e1') }, parents: [], sent: { kind: 'text', size: 12 } },
  // Each directory on the way to the long path is sent, and is a row before what is under it.
  ...LONG_PATH.split('/').slice(0, -1).map((_, depth, names): PushReviewEntry => ({
    kind: 'path', commit: A, path: names.slice(0, depth + 1).join('/'), entry: { kind: 'dir', oid: oid(`t${depth}-`) },
    parents: [], sent: { kind: 'dir', size: 40 },
  })),
  { kind: 'path', commit: A, path: LONG_PATH, entry: { kind: 'file', oid: oid('e2') }, parents: [], sent: { kind: 'text', size: 3 } },
  { kind: 'path', commit: A, path: 'wide.txt', entry: { kind: 'file', oid: oid('e3') }, parents: [], sent: { kind: 'text', size: WIDE_TEXT.length } },
  { kind: 'commit', oid: B, parents: [A], size: SECOND.length, text: SECOND },
  {
    kind: 'path', commit: B, path: '', entry: { kind: 'dir', oid: oid('d2') },
    parents: [{ kind: 'dir', oid: oid('d1') }], sent: { kind: 'dir', size: 90 },
  },
  {
    kind: 'path', commit: B, path: 'README.md', entry: { kind: 'file', oid: oid('e4') },
    parents: [{ kind: 'file', oid: oid('e1') }], sent: { kind: 'text', size: 18 },
  },
]

const FILES: Record<string, string> = {
  [`${A}:README.md`]: 'hello\nworld\n',
  [`${A}:${LONG_PATH}`]: 'hi\n',
  [`${A}:wide.txt`]: WIDE_TEXT,
  [`${B}:README.md`]: 'hello\nbrave new world\n',
}

const overseer = {
  getPushReview: async (): Promise<PushReview> => ({ entries: ENTRIES, objectCount: 38, stackedOn: [] }),
  readFilesAtCommit: async (commitId: string, paths: string[]) =>
    paths.map((at): [string, FileAtCommit] => {
      const text = FILES[`${commitId}:${at}`]
      return [at, text === undefined ? { kind: 'absent' } : { kind: 'text', text }]
    }),
  // What the commit's rows say it holds: each path with an entry, under its directories.
  listTree: async (commitId: string): Promise<TreeNode[]> => {
    const tree: TreeNode[] = []
    for (const row of ENTRIES) {
      if (row.kind !== 'path' || row.commit !== commitId || !row.entry || row.path === '') continue
      let nodes = tree
      for (const name of row.path.split('/')) {
        let node = nodes.find(child => child.name === name)
        if (!node) nodes.push(node = row.entry.kind === 'dir' ? { name, kind: 'dir', children: [] } : { name, kind: 'file' })
        if (node.kind === 'dir') nodes = node.children
      }
    }
    return tree
  },
} as unknown as RpcStub<Overseer>

const RECORD = {
  id: 7,
  gatekeeperId: 1,
  resourceTitle: 'acme/widgets',
  createdAt: new Date(1700000000000),
  state: 'pending',
  type: 'action',
  description: {
    title: 'Push to acme/widgets',
    description: LONG_REQUEST,
    implementsRevert: false,
    autoApprovable: false,
    pushedCommits: [B],
    fields: [{ label: 'Branch', kind: 'inline', value: 'main' }],
  },
} as ActionLogEntry

// The dialog as a host holds it: opened from a button, and unmounted when it closes.
const Host = ({ restricted }: { restricted: boolean }) => {
  const [open, setOpen] = useState(false)
  return (
    <ThemeProvider>
      <button type="button" onClick={() => setOpen(true)}>Review commits</button>
      {open && (
        <PushReviewDialog
          overseer={overseer}
          record={RECORD}
          restricted={restricted}
          processing={false}
          onApprove={() => {}}
          onReject={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </ThemeProvider>
  )
}

/** Runs a browser interaction inside act(), so React has committed before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })
/** Lets the reads, the editor's frames and the layout settle. */
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })

let host: HTMLDivElement | undefined
let root: Root | undefined
let previousViewport: { width: number, height: number } | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  if (previousViewport) {
    await page.viewport(previousViewport.width, previousViewport.height)
    previousViewport = undefined
  }
})

const openReview = async ({ restricted = false, width = 1400, height = 900 } = {}) => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(width, height)
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root!.render(<Host restricted={restricted} />))
  await input(() => userEvent.click(opener()))
  await settle()
}

const opener = () => host!.querySelector<HTMLButtonElement>('button')!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const rows = () => [...dialog().querySelectorAll<HTMLButtonElement>('ul[aria-label="Commits and files of this push"] button')]
const row = (label: string) => rows().find(item => item.textContent?.includes(label))!
const pane = () => dialog().querySelector<HTMLElement>('section[aria-label="The selected commit or file"]')!
const decision = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!
const selected = () => rows().findIndex(item => item.getAttribute('aria-current') === 'true')
const within = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1

it('puts focus in the list on open, and moves the selection with the keyboard', async () => {
  await openReview()
  expect(selected()).toBe(0)
  expect(document.activeElement).toBe(rows()[0])
  expect(pane().textContent).toContain('Add the widget')

  await input(() => userEvent.keyboard('{ArrowDown}'))
  expect(selected()).toBe(1)
  expect(document.activeElement).toBe(rows()[1])
  await settle()
  expect(pane().textContent).toContain('(root directory)')

  await input(() => userEvent.keyboard('{End}'))
  expect(selected()).toBe(rows().length - 1)
  expect(document.activeElement).toBe(rows().at(-1))
  await input(() => userEvent.keyboard('{ArrowUp}'))
  expect(selected()).toBe(rows().length - 2)
  // The row above the last commit's one file is that commit's root directory.
  await settle()
  expect(pane().textContent).toContain('Entries of this directory, as sent')
  expect(pane().querySelectorAll('tbody tr')).toHaveLength(1)
  await input(() => userEvent.keyboard('{Home}'))
  expect(selected()).toBe(0)
  expect(document.activeElement).toBe(rows()[0])

  // The list is one tab stop: only the selected row takes Tab.
  expect(rows().filter(item => item.tabIndex === 0)).toHaveLength(1)
})

it('reaches the pane, Deny and Approve with Tab under the mark', async () => {
  await openReview({ restricted: true })
  expect(decision('Approve').disabled).toBe(false)
  const reached = new Set<Element | null>()
  for (let presses = 0; presses < 8; presses++) {
    await input(() => userEvent.tab())
    reached.add(document.activeElement)
  }
  expect(reached.has(pane())).toBe(true)
  expect(reached.has(decision('Deny'))).toBe(true)
  expect(reached.has(decision('Approve'))).toBe(true)
  // Focus stays inside the dialog.
  expect([...reached].every(element => dialog().contains(element))).toBe(true)
})

it('closes on Escape and returns focus to what opened it', async () => {
  await openReview()
  await input(() => userEvent.keyboard('{Escape}'))
  await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener())
})

it('keeps the header in view while a long commit scrolls, and wraps rather than widens', async () => {
  await openReview({ restricted: true })
  const box = dialog().getBoundingClientRect()
  // The signature, the message and the request are longer than the dialog is wide.
  expect(dialog().scrollWidth).toBeLessThanOrEqual(dialog().clientWidth)
  expect(pane().scrollWidth).toBeLessThanOrEqual(pane().clientWidth)
  expect(pane().scrollHeight).toBeGreaterThan(pane().clientHeight)

  pane().scrollTop = pane().scrollHeight
  await settle()
  expect(within(decision('Approve').getBoundingClientRect(), box)).toBe(true)
  expect(within(decision('Deny').getBoundingClientRect(), box)).toBe(true)
  expect(within(pane().getBoundingClientRect(), box)).toBe(true)

  // A path of thirty directories wraps in the list and in the pane.
  await input(() => userEvent.click(row('directory-29')))
  await settle()
  const listPane = row('directory-29').closest('.overflow-y-auto')!
  expect(listPane.scrollWidth).toBeLessThanOrEqual(listPane.clientWidth)
  expect(pane().scrollWidth).toBeLessThanOrEqual(pane().clientWidth)
  expect(row('directory-29').getBoundingClientRect().height).toBeGreaterThan(40)
})

it('stacks the panes at a narrow width, with nothing past the dialog', async () => {
  await openReview({ restricted: true, width: 420, height: 800 })
  const box = dialog().getBoundingClientRect()
  expect(box.right).toBeLessThanOrEqual(420)
  expect(dialog().scrollWidth).toBeLessThanOrEqual(dialog().clientWidth)
  const listPane = rows()[0].closest('.overflow-y-auto')!.getBoundingClientRect()
  expect(listPane.bottom).toBeLessThanOrEqual(pane().getBoundingClientRect().top + 1)
  expect(within(pane().getBoundingClientRect(), box)).toBe(true)
  expect(within(decision('Approve').getBoundingClientRect(), box)).toBe(true)
})

it('mounts the diff editor with room to show an added file and a changed one', async () => {
  await openReview()
  await input(() => userEvent.click(row('README.md')))
  await settle()
  expect(pane().querySelector('.cm-editor')!.getBoundingClientRect().height).toBeGreaterThan(100)
  expect(pane().querySelector('.cm-content')!.textContent).toContain('hello')
  expect(pane().textContent).toContain('Added')

  // The same path in the next commit is a diff against its parent's version.
  await input(() => userEvent.click(rows().findLast(item => item.textContent?.includes('README.md'))!))
  await settle()
  expect(pane().querySelector('.cm-editor')!.getBoundingClientRect().height).toBeGreaterThan(100)
  expect(pane().querySelector('.gadgets-diff-line-add')!.textContent).toBe('brave new world')
  expect(pane().querySelector('.gadgets-deleted-code-zone')!.textContent).toBe('world')
})

for (const width of [1400, 420]) {
  it(`leaves no part of an added line off screen at ${width}px`, async () => {
    await openReview({ width })
    await input(() => userEvent.click(row('wide.txt')))
    await settle()
    const scroller = pane().querySelector<HTMLElement>('.cm-scroller')!
    const edge = scroller.getBoundingClientRect()
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)
    const lines = [...scroller.querySelectorAll<HTMLElement>('.cm-line')]
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(edge.right + 1)
    // The line with no space in it wraps onto many rows, none of them under the editor's toolbar.
    expect(lines[0].getBoundingClientRect().height).toBeGreaterThan(40)
    const toolbar = pane().querySelector('[data-diff-toolbar]')!.getBoundingClientRect()
    expect(toolbar.height).toBeGreaterThan(0)
    expect(lines[0].getBoundingClientRect().top).toBeGreaterThanOrEqual(toolbar.bottom)
    expect(pane().querySelector('.cm-editor')!.getBoundingClientRect().top).toBeGreaterThanOrEqual(toolbar.bottom)

    // The end of the second line: its run of spaces is drawn, and the word after it is in view.
    scroller.scrollTop = scroller.scrollHeight
    await settle()
    expect(scroller.querySelector('.cm-highlightSpace')).not.toBeNull()
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT)
    let tail: DOMRect | undefined
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf('tail') ?? -1
      if (at === -1) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 4)
      tail = range.getBoundingClientRect()
    }
    expect(tail).toBeDefined()
    expect(tail!.width).toBeGreaterThan(0)
    expect(tail!.left).toBeGreaterThanOrEqual(edge.left)
    expect(tail!.right).toBeLessThanOrEqual(edge.right + 1)
  })
}
