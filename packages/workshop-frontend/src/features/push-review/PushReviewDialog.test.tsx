// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  PUSH_REVIEW_PAGE_SIZE,
  type ActionLogEntry, type FileAtCommit, type Overseer, type PushReview, type PushReviewEntry,
  type PushReviewParentEntry, type PushReviewSent, type PushReviewTreeEntry, type TreeNode,
} from '@gadgets/workshop-shared/api'
import { MAX_BUFFERED_BLOB_SIZE } from '@gadgets/workshop-shared/gatekeeper'
import { RESTRICTED_APPROVAL_COPY } from '../../components/RestrictedApprovalNotice'
import { MAX_WHOLE_REVIEW_ENTRIES, sentObjectCount, type CommitRow, type PathRow } from './pushReviewModel'

type EditorProps = {
  filename: string | null, original: string | null, text?: string | null,
  readOnly?: boolean, showInvisibles?: boolean, wrapLines?: boolean,
}

// The diff editor is CodeMirror, tested where it lives. Here it records what it was given, and
// each mount gets a number, so a remount (another React key) shows.
const editors = vi.hoisted(() => ({ mounts: 0, props: new Map<number, unknown>() }))
vi.mock('../code/CodeDiffEditor', async () => {
  const { useState } = await import('react')
  return {
    default: (props: EditorProps) => {
      const [mount] = useState(() => ++editors.mounts)
      editors.props.set(mount, props)
      return <div data-editor={mount} />
    },
  }
})

import { PushReviewDialog } from './PushReviewDialog'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

// ---- fixtures ------------------------------------------------------------------------------------

// The commit file store is page-wide and keeps what it read, so each test names its own objects.
let salt = 0
const oid = (name: string) => `${name}-${salt}-`.padEnd(40, '0')

const NONE: PushReviewParentEntry = { kind: 'none' }
const UNKNOWN: PushReviewParentEntry = { kind: 'unknown' }
const entry = (kind: PushReviewTreeEntry['kind'], name: string): PushReviewTreeEntry => ({ kind, oid: oid(name) })
const text = (size = 10): PushReviewSent => ({ kind: 'text', size })
const dir = (size = 30): PushReviewSent => ({ kind: 'dir', size })

const commitText = (message: string, headers = '') =>
  `tree ${oid('tree')}\nauthor Ada <ada@example.com> 1700000000 +0100\n` +
  `committer Bob <bob@example.com> 1700000050 -0700\n${headers}\n${message}`

const commit = (name: string, over: Partial<CommitRow> = {}): CommitRow => {
  const body = commitText(`Subject of ${name}\n`)
  return { kind: 'commit', oid: oid(name), parents: [], size: body.length, text: body, ...over }
}
const path = (name: string, at: string, over: Partial<Omit<PathRow, 'kind' | 'commit' | 'path'>> = {}): PathRow =>
  ({ kind: 'path', commit: oid(name), path: at, parents: [NONE], ...over })
const root = (name: string, parents: PushReviewParentEntry[] = [NONE]): PathRow =>
  path(name, '', { entry: entry('dir', `root-${name}`), parents, sent: dir() })
const added = (name: string, at: string): PathRow =>
  path(name, at, { entry: entry('file', `blob-${name}-${at}`), sent: text() })
const modified = (name: string, at: string): PathRow =>
  path(name, at, {
    entry: entry('file', `blob-${name}-${at}`), parents: [entry('file', `old-${at}`)], sent: text(),
  })

const record = (over: Record<string, unknown> = {}): ActionLogEntry => ({
  id: 7,
  gatekeeperId: 1,
  resourceTitle: 'acme/widgets',
  createdAt: new Date(1700000000000),
  state: 'pending',
  type: 'action',
  description: {
    title: 'Push to acme/widgets',
    description: 'Push commit 1a2b3c4 to branch main',
    implementsRevert: false,
    autoApprovable: false,
    pushedCommits: [oid('head')],
    fields: [{ label: 'Branch', kind: 'inline', value: 'main' }],
    ...over,
  },
} as ActionLogEntry)

// ---- a fake Overseer -----------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type FileAnswer = FileAtCommit | Promise<FileAtCommit>
type Reads = {
  /** One page per call, by cursor and by how many calls came before. */
  page: (cursor: number | undefined, call: number) => PushReview | Promise<PushReview>
  /**
   * What reading a path at a commit returns, by `fileKey` or worked out per read; a path with no
   * answer is absent.
   */
  files?: Record<string, FileAnswer | (() => FileAnswer)> | ((commitId: string, at: string) => FileAnswer)
  blobs?: Record<string, Uint8Array>
  /**
   * What listing a commit returns. A commit with no answer lists what the review's rows say it
   * holds: every path of it that has an entry.
   */
  trees?: (commitId: string) => TreeNode[] | Promise<TreeNode[]> | undefined
  /** The paths at which a commit differs from a parent; none unless given. */
  changed?: (parent: string, commitId: string) => string[]
}

// Adds the paths of `entries` that have an entry to the tree of each row's commit. The fake
// learns a commit's tree from the pages as it serves them, so a tree it has handed out grows in
// place: what a real commit holds is all there from the first listing.
const growTrees = (trees: Map<string, TreeNode[]>, entries: readonly PushReviewEntry[]) => {
  for (const row of entries) {
    if (row.kind !== 'path' || !row.entry || row.path === '') continue
    let nodes = trees.get(row.commit)
    if (!nodes) trees.set(row.commit, nodes = [])
    const segments = row.path.split('/')
    for (const [index, name] of segments.entries()) {
      let node: TreeNode | undefined = nodes.find(child => child.name === name)
      if (!node) {
        node = index === segments.length - 1 && row.entry.kind !== 'dir'
          ? { name, kind: row.entry.kind }
          : { name, kind: 'dir', children: [] }
        nodes.push(node)
      }
      if (node.kind !== 'dir') break
      nodes = node.children
    }
  }
}

const fileKey = (name: string, at: string) => `${oid(name)}:${at}`

const fakeOverseer = (reads: Reads) => {
  let calls = 0
  const trees = new Map<string, TreeNode[]>()
  const getPushReview = vi.fn<Overseer['getPushReview']>(async (_actionId, cursor) => {
    const page = await reads.page(cursor, calls++)
    growTrees(trees, page.entries)
    return page
  })
  const listTree = vi.fn<Overseer['listTree']>(async commitId => {
    const given = await reads.trees?.(commitId)
    if (given) return given
    if (!trees.has(commitId)) trees.set(commitId, [])
    return trees.get(commitId)!
  })
  const listChangedPaths = vi.fn<Overseer['listChangedPaths']>(async (parent, commitId) =>
    reads.changed?.(parent, commitId) ?? [])
  const answer = (commitId: string, at: string): FileAnswer => {
    if (typeof reads.files === 'function') return reads.files(commitId, at)
    const given = reads.files?.[`${commitId}:${at}`]
    return typeof given === 'function' ? given() : given ?? { kind: 'absent' }
  }
  const readFilesAtCommit = vi.fn<Overseer['readFilesAtCommit']>(async (commitId, paths) =>
    Promise.all(paths.map(async (at): Promise<[string, FileAtCommit]> => [at, await answer(commitId, at)])))
  const readBlob = vi.fn<Overseer['readBlob']>(async (blobOid) => {
    const bytes = reads.blobs?.[blobOid]
    if (!bytes) throw new Error('no such blob')
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  })
  return {
    getPushReview, readFilesAtCommit, readBlob, listTree, listChangedPaths,
    stub: { getPushReview, readFilesAtCommit, readBlob, listTree, listChangedPaths } as unknown as RpcStub<Overseer>,
  }
}

/** A review served whole, or in pages of `size` entries. */
const serve = (entries: PushReviewEntry[], size = PUSH_REVIEW_PAGE_SIZE, stackedOn: number[] = []) =>
  (cursor = 0): PushReview => ({
    entries: entries.slice(cursor, cursor + size),
    objectCount: sentObjectCount(entries),
    stackedOn,
    ...(cursor + size < entries.length && { next: cursor + size }),
  })

// ---- rendering -----------------------------------------------------------------------------------

let host: HTMLDivElement | undefined
let reactRoot: Root | undefined
const onApprove = vi.fn<() => void>()
const onReject = vi.fn<() => void>()
const onClose = vi.fn<() => void>()

beforeEach(() => {
  salt++
  editors.props.clear()
  onApprove.mockClear()
  onReject.mockClear()
  onClose.mockClear()
})
afterEach(async () => {
  await act(async () => reactRoot?.unmount())
  host?.remove()
})

/** Lets pending promises and the store's batched reads settle. */
const settle = () => act(async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0))
})

type Shown = { restricted?: boolean, entryRecord?: ActionLogEntry }

/** Renders the dialog into the open root: again, with another record, to review another request. */
const show = async (
  overseer: ReturnType<typeof fakeOverseer>, { restricted = false, entryRecord = record() }: Shown = {},
) => {
  await act(async () => reactRoot!.render(
    <PushReviewDialog
      overseer={overseer.stub}
      record={entryRecord}
      restricted={restricted}
      processing={false}
      onApprove={onApprove}
      onReject={onReject}
      onClose={onClose}
    />,
  ))
  await settle()
}

const open = async (reads: Reads, options?: Shown) => {
  const overseer = fakeOverseer(reads)
  host = document.body.appendChild(document.createElement('div'))
  reactRoot = createRoot(host)
  await show(overseer, options)
  return overseer
}

const dialog = () => {
  const element = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!element) throw new Error('no dialog')
  return element
}
const shown = () => dialog().textContent ?? ''
const buttons = (name: string) =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.trim() === name)
const button = (name: string) => {
  const [first] = buttons(name)
  if (!first) throw new Error(`no button "${name}"`)
  return first
}
const press = async (target: HTMLElement) => {
  await act(async () => target.click())
  await settle()
}
const list = () => dialog().querySelector<HTMLElement>('ul[aria-label="Commits and files of this push"]')!
const rows = () => [...list().querySelectorAll<HTMLButtonElement>('button')]
/** The list row whose text holds `label`. */
const row = (label: string) => {
  const found = rows().find(item => item.textContent?.includes(label))
  if (!found) throw new Error(`no row "${label}"`)
  return found
}
const pane = () => dialog().querySelector<HTMLElement>('section[aria-label="The selected commit or file"]')!
const tokens = (within: HTMLElement) =>
  [...within.querySelectorAll('span[title^="U+"]')]
    .filter(span => span.getAttribute('title') !== 'U+0020')
    .map(span => span.textContent)
const spaceMarks = (within: HTMLElement) => within.querySelectorAll('span[title="U+0020"]').length
/** The diff editor in the right pane: what it was given, and which mount it is. */
const editor = () => {
  const element = pane().querySelector<HTMLElement>('[data-editor]')
  if (!element) return undefined
  const mount = Number(element.dataset.editor)
  return { mount, ...(editors.props.get(mount) as EditorProps) }
}
const readiness = () => dialog().querySelector('[role="status"]')?.textContent
const readPaths = (overseer: ReturnType<typeof fakeOverseer>) =>
  overseer.readFilesAtCommit.mock.calls.flatMap(([commitId, paths]) => paths.map(at => `${commitId}:${at}`))

// A merge that takes left.txt from its first parent and right.txt from its second, and whose
// directory `d` holds one file of each: only both.txt differs from every parent.
const mergeOfTwoSides = () => {
  const sides = [entry('dir', 'left-root'), entry('dir', 'right-root')]
  const file = (name: string): TreeNode => ({ name, kind: 'file' })
  return {
    entries: [
      commit('m', { parents: [oid('left'), oid('right')] }), root('m', sides),
      path('m', 'both.txt', {
        entry: entry('file', 'merged'), parents: [entry('file', 'ours'), entry('file', 'theirs')], sent: text(),
      }),
      path('m', 'd', { entry: entry('dir', 'd-merged'), parents: [entry('dir', 'd-left'), entry('dir', 'd-right')], sent: dir() }),
    ],
    trees: (): TreeNode[] => [
      file('README.md'), file('both.txt'), { name: 'd', kind: 'dir', children: [file('left.txt'), file('right.txt')] },
      file('left.txt'), file('right.txt'),
    ],
    changed: (parent: string) => parent === oid('left')
      ? ['both.txt', 'd/right.txt', 'right.txt']
      : ['both.txt', 'd/left.txt', 'left.txt'],
  }
}
/** The table of a directory's entries in the right pane: one line per entry, cells joined by ` | `. */
const entriesShown = () => [...pane().querySelectorAll('tbody tr')]
  .map(line => [...line.querySelectorAll('td')].map(cell => cell.textContent).join(' | '))

// ---- what the review shows -----------------------------------------------------------------------

describe('PushReviewDialog content', () => {
  it('shows every commit with every header line, and says when a commit cannot be read', async () => {
    const signed = commitText(
      'Fix the thing\n\nBody text\n',
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAAB\n -----END PGP SIGNATURE-----\n' +
      'encoding ISO-8859-1\nnospace\n')
    await open({
      page: serve([
        commit('a', { text: signed, size: signed.length }),
        commit('b', { text: undefined, size: 3000 }),
        commit('c', { text: undefined, size: undefined }),
      ]),
    })

    // The first commit is selected on open.
    expect(rows()[0].getAttribute('aria-current')).toBe('true')
    expect(rows()[0].textContent).toContain('Fix the thing')
    const names = [...pane().querySelectorAll('dt')].map(term => term.textContent)
    expect(names).toEqual(['tree', 'author', 'committer', 'gpgsig', 'encoding', 'Unrecognized header line'])
    const values = [...pane().querySelectorAll('dd')].map(value => value.textContent)
    expect(values).toEqual([
      oid('tree'),
      'Ada <ada@example.com> 1700000000 +0100',
      'Bob <bob@example.com> 1700000050 -0700',
      '-----BEGIN PGP SIGNATURE-----\n\niQEzBAAB\n-----END PGP SIGNATURE-----',
      'ISO-8859-1',
      'nospace',
    ])
    expect(pane().textContent).toContain(oid('a'))
    expect(pane().textContent).toContain('Fix the thing\n\nBody text\n')

    await press(row('Cannot be read as text'))
    expect(pane().textContent).toContain('This commit cannot be read as text: 2.9 KB (3000 bytes).')
    await press(row('Not in this workspace yet'))
    expect(pane().textContent).toContain('This commit is not in this workspace yet, so it cannot be shown.')
    expect(shown()).toContain('3 commits, 0 paths, 3 objects sent in all.')
  })

  it('says what a commit text lacks', async () => {
    await open({ page: serve([commit('a', { text: 'tree abc', size: 8 }), commit('b', { text: 'tree abc\n\n', size: 10 })]) })
    expect(pane().textContent).toContain('The commit text ends without a newline.')
    expect(pane().textContent).toContain('No message.')
    expect(rows()[0].textContent).toContain('No message')
    await press(rows()[1])
    expect(pane().textContent).toContain('The message is empty.')
  })

  it('shows an added file whole, a modified one against its parent, and a deletion as what is removed', async () => {
    const overseer = await open({
      page: serve([
        commit('a'), root('a'), added('a', 'notes.txt'),
        commit('b', { parents: [oid('a')] }), root('b', [entry('dir', 'root-a')]),
        path('b', 'notes.txt', { entry: entry('file', 'second'), parents: [entry('file', 'blob-a-notes.txt')], sent: text() }),
        path('b', 'old.txt', { parents: [entry('file', 'old')] }),
      ]),
      files: {
        [fileKey('a', 'notes.txt')]: { kind: 'text', text: 'first\n' },
        [fileKey('b', 'notes.txt')]: { kind: 'text', text: 'second\n' },
        [fileKey('a', 'old.txt')]: { kind: 'text', text: 'bye\n' },
      },
    })
    // Each commit's root directory is a row of its own, before the paths beneath it.
    expect(rows().map(item => item.textContent)).toEqual([
      expect.stringContaining('Subject of a'), '(root directory)Added · directory', 'notes.txtAdded',
      expect.stringContaining('Subject of b'), '(root directory)Modified · directory', 'notes.txtModified',
      'old.txtDeleted',
    ])
    // Outside the mark nothing is read until a row is opened.
    expect(overseer.readFilesAtCommit).not.toHaveBeenCalled()
    expect(overseer.listTree).not.toHaveBeenCalled()

    await press(rows()[2])
    const whole = editor()!
    expect(whole).toMatchObject({
      filename: 'notes.txt', original: null, text: 'first\n', readOnly: true, showInvisibles: true, wrapLines: true,
    })

    // The same path under the next commit is another editor, not the first one given new text.
    await press(rows()[5])
    const changed = editor()!
    expect(changed).toMatchObject({
      original: 'first\n', text: 'second\n', readOnly: true, showInvisibles: true, wrapLines: true,
    })
    expect(changed.mount).not.toBe(whole.mount)
    expect(pane().textContent).toContain("Removed lines are the earlier version's, not sent; long ones are cut at the edge.")

    await press(rows()[6])
    expect(editor()).toMatchObject({
      filename: 'old.txt', original: 'bye\n', text: '', readOnly: true, showInvisibles: true, wrapLines: true,
    })
    expect(pane().querySelector('h3')?.textContent).toBe('Deleted')
  })

  it('shows the file a directory replaces as what is removed', async () => {
    const overseer = await open({
      page: serve([
        commit('a', { parents: [oid('p')] }), root('a', [entry('dir', 'root-p')]),
        path('a', 'config', { entry: entry('dir', 'config-dir'), parents: [entry('file', 'old-config')], sent: dir() }),
        added('a', 'config/new.txt'),
      ]),
      files: {
        [fileKey('p', 'config')]: { kind: 'text', text: 'old config\n' },
        [fileKey('a', 'config/new.txt')]: { kind: 'text', text: 'new\n' },
      },
    })
    // The directory has a row of its own: the file it replaces has no other.
    await press(row('config'))
    expect(pane().textContent).toContain('Replaces a file.')
    expect(readPaths(overseer)).toContain(`${oid('p')}:config`)
    expect(editor()).toMatchObject({
      filename: 'config', original: 'old config\n', text: '', readOnly: true, showInvisibles: true, wrapLines: true,
    })
  })

  it('offers each parent of a merge, and compares with the one chosen in a fresh editor', async () => {
    await open({
      page: serve([
        commit('m', { parents: [oid('p1'), oid('p2')] }),
        root('m', [entry('dir', 'r1'), entry('dir', 'r2')]),
        path('m', 'f.txt', { entry: entry('file', 'merged'), parents: [entry('file', 'one'), entry('file', 'two')], sent: text() }),
      ]),
      files: {
        [fileKey('m', 'f.txt')]: { kind: 'text', text: 'merged\n' },
        [fileKey('p1', 'f.txt')]: { kind: 'text', text: 'one\n' },
        [fileKey('p2', 'f.txt')]: { kind: 'text', text: 'two\n' },
      },
    })
    await press(row('f.txt'))
    const first = editor()!
    expect(first).toMatchObject({ original: 'one\n', text: 'merged\n' })
    expect(button(`Against parent 1 ${oid('p1').slice(0, 12)}`).getAttribute('aria-pressed')).toBe('true')

    await press(button(`Against parent 2 ${oid('p2').slice(0, 12)}`))
    const second = editor()!
    expect(second).toMatchObject({ original: 'two\n', text: 'merged\n' })
    expect(second.mount).not.toBe(first.mount)

    // The first parent's text is already held, so nothing unmounts the editor in between: only
    // its key makes this one fresh.
    await act(async () => button(`Against parent 1 ${oid('p1').slice(0, 12)}`).click())
    const third = editor()!
    expect(third).toMatchObject({ original: 'one\n', text: 'merged\n' })
    expect(third.mount).not.toBe(second.mount)
    expect(third.mount).not.toBe(first.mount)
  })

  it('shows the file whole when the parent version is not text, and says when it could not be read', async () => {
    const failing = deferred<FileAtCommit>()
    failing.reject(new Error('The workspace is busy.'))
    failing.promise.catch(() => {})
    await open({
      page: serve([
        commit('b', { parents: [oid('a')] }), root('b', [entry('dir', 'r')]),
        modified('b', 'image.svg'), modified('b', 'flaky.txt'),
      ]),
      files: {
        [fileKey('b', 'image.svg')]: { kind: 'text', text: '<svg/>' },
        [fileKey('a', 'image.svg')]: { kind: 'blob', blob: { oid: oid('old-image.svg'), byteLength: 12 } },
        [fileKey('b', 'flaky.txt')]: { kind: 'text', text: 'new\n' },
        [fileKey('a', 'flaky.txt')]: failing.promise,
      },
    })
    await press(row('image.svg'))
    expect(editor()).toMatchObject({ original: null, text: '<svg/>' })
    expect(pane().textContent).toContain('The earlier version is not text, so the whole file is shown.')

    await press(row('flaky.txt'))
    expect(editor()).toMatchObject({ original: null, text: 'new\n' })
    expect(pane().textContent).toContain('The earlier version could not be read.')
    expect(buttons('Retry')).toHaveLength(1)
  })

  it('says what each thing it cannot show as text is, with no editor', async () => {
    const overseer = await open({
      page: serve([
        commit('a'), root('a'),
        path('a', 'data.bin', { entry: entry('file', 'bin'), sent: { kind: 'binary', size: 2048 } }),
        path('a', 'missing.txt', { entry: entry('file', 'gone'), sent: { kind: 'absent' } }),
        path('a', 'odd', { entry: entry('dir', 'odd'), sent: { kind: 'unlistable', size: 70 } }),
        path('a', 'wrong', { entry: entry('file', 'wrong'), sent: { kind: 'mistyped', type: 'tree', size: 30 } }),
        path('a', 'link', { entry: entry('symlink', 'link'), sent: text(9) }),
        path('a', 'vendor/lib', { entry: entry('submodule', 'sub'), parents: [entry('submodule', 'was')] }),
        { kind: 'object', oid: oid('orphan'), type: 'blob', size: 5 },
      ]),
      files: { [fileKey('a', 'link')]: { kind: 'unreadable', message: 'link is a symbolic link to ../target' } },
    })
    const says = async (label: string, statement: string) => {
      await press(row(label))
      expect(pane().textContent).toContain(statement)
      expect(editor()).toBeUndefined()
    }
    await says('data.bin', 'Not text: 2.0 KB (2048 bytes). Its content cannot be shown.')
    await says('missing.txt', 'Not in this workspace yet, so it cannot be shown.')
    await says('odd', "Its entries cannot be listed; what the push sends under it is under 'Sent without a path'.")
    await says('wrong', 'This entry says file, but the object is a tree: 30 bytes. It cannot be shown here.')
    await says('vendor/lib', `Submodule entry: commit ${oid('sub')}, was ${oid('was')}.`)
    // None of those is read: only the link, whose target the read names, is.
    expect(readPaths(overseer)).toEqual([])
    await says('link', 'link is a symbolic link to ../target')
    expect(readPaths(overseer)).toEqual([fileKey('a', 'link')])

    // What no path accounts for is listed apart, and says so.
    expect(list().textContent).toContain('Sent without a path')
    await says(`blob ${oid('orphan').slice(0, 12)}`, 'Sent, but no commit of this push shows it at a path.')
    expect(pane().textContent).toContain(`blob ${oid('orphan')}`)
    expect(pane().textContent).toContain('5 bytes')
  })

  it('reads a file too large to have been checked only when asked, then shows it', async () => {
    const size = MAX_BUFFERED_BLOB_SIZE + 1
    const big = entry('file', 'big')
    const overseer = await open({
      page: serve([commit('a'), root('a'), path('a', 'big.txt', { entry: big, sent: { kind: 'large', size } })]),
      files: { [fileKey('a', 'big.txt')]: { kind: 'blob', blob: { oid: big.oid, byteLength: size } } },
      blobs: { [big.oid]: new Uint8Array(size).fill(97) },
    })
    await press(row('big.txt'))
    expect(pane().textContent).toContain('over the size checked as text, so it is not read until you ask.')
    expect(overseer.readFilesAtCommit).not.toHaveBeenCalled()
    expect(editor()).toBeUndefined()

    await press(button('Show file'))
    expect(overseer.readBlob).toHaveBeenCalledWith(big.oid)
    expect(editor()).toMatchObject({ filename: 'big.txt', original: null, showInvisibles: true, wrapLines: true })
    expect(editor()!.text).toHaveLength(size)
  })

  it('reads a file the push does not send only when asked, and shows it read-only', async () => {
    const same = entry('executable', 'same')
    const overseer = await open({
      page: serve([
        commit('b', { parents: [oid('a')] }), root('b', [entry('dir', 'r')]),
        path('b', 'run.sh', { entry: same, parents: [{ kind: 'file', oid: same.oid }] }),
        path('b', 'bin', { parents: [entry('dir', 'bin')] }),
      ]),
      files: { [fileKey('b', 'run.sh')]: { kind: 'text', text: '#!/bin/sh\n' } },
    })
    await press(row('run.sh'))
    expect(row('run.sh').textContent).toContain('Mode')
    expect(row('run.sh').textContent).toContain('not sent')
    expect(pane().textContent).toContain('Mode changed: file to executable.')
    expect(overseer.readFilesAtCommit).not.toHaveBeenCalled()

    await press(button('Show file'))
    expect(overseer.readFilesAtCommit).toHaveBeenCalledTimes(1)
    expect(overseer.readFilesAtCommit).toHaveBeenCalledWith(oid('b'), ['run.sh'])
    expect(editor()).toMatchObject({ original: null, text: '#!/bin/sh\n', readOnly: true })

    // A deleted directory has no file to compare: its statement, and nothing read.
    await press(row('bin'))
    expect(pane().textContent).toContain('A directory: everything under it is removed with it, and is not listed here.')
    expect(editor()).toBeUndefined()
    expect(buttons('Show file')).toHaveLength(0)
    expect(overseer.readFilesAtCommit).toHaveBeenCalledTimes(1)
  })

  it('lists every directory the push sends by name, an empty one included', async () => {
    await open({
      page: serve([
        commit('a', { parents: [oid('p')] }), root('a', [UNKNOWN]),
        path('a', 'evil\u202Ecod', { entry: entry('dir', 'empty'), sent: dir(0) }),
        path('a', 'x', { entry: entry('dir', 'x'), sent: dir() }),
        path('a', 'x/y', { entry: entry('dir', 'y'), sent: dir() }),
        path('a', 'x/y/z', { entry: entry('dir', 'empty'), sent: dir(0) }),
        path('a', 'vendor', { entry: entry('dir', 'vendor'), parents: [UNKNOWN], sent: dir() }),
      ]),
    })
    // The commit, then the root and each directory under it, the outer ones of the chain too.
    expect(rows().slice(1).map(item => item.textContent?.replace(/(Added|Modified).*/, ''))).toEqual([
      '(root directory)', 'evilU+202Ecod', 'x', 'x/y', 'x/y/z', 'vendor',
    ])
    expect(tokens(row('evil'))).toEqual(['U+202E'])
    expect(shown()).toContain('1 commit, 6 paths, 6 objects sent in all.')

    await press(row('evil'))
    expect(tokens(pane())).toEqual(['U+202E'])
    expect(pane().textContent).toContain('Empty directory.')
    await press(row('x/y/z'))
    expect(pane().textContent).toContain('Empty directory.')
    await press(row('vendor'))
    expect(pane().textContent).toContain('Directory with no changed entry: a parent already has each of its entries.')
    expect(pane().textContent).toContain(`Parent ${oid('p').slice(0, 12)} is not in this workspace, so there is nothing to compare with.`)
  })

  it('shows what each directory a merge sends holds, and which parent each entry is taken from', async () => {
    const merge = mergeOfTwoSides()
    const overseer = await open({ page: serve(merge.entries), trees: merge.trees, changed: merge.changed })
    const [left, right] = [oid('left').slice(0, 12), oid('right').slice(0, 12)]

    // The merge changes one path, and sends two directories: each is a row that opens.
    expect(rows().slice(1).map(item => item.textContent)).toEqual([
      '(root directory)Modified · directory', 'both.txtModified', 'dModified · directory',
    ])
    expect(overseer.listTree).not.toHaveBeenCalled()

    await press(row('(root directory)'))
    expect(pane().textContent).toContain('Entries of this directory, as sent')
    expect(entriesShown()).toEqual([
      `README.md | file | 100644 | As in parents 1 ${left} and 2 ${right}.`,
      'both.txt | file | 100644 | Differs from every parent: listed as a row of its own.',
      'd | directory | 40000 | Differs from every parent: listed as a row of its own.',
      `left.txt | file | 100644 | As in parent 1 ${left}.`,
      `right.txt | file | 100644 | As in parent 2 ${right}.`,
    ])

    await press(row('dModified'))
    expect(entriesShown()).toEqual([
      `left.txt | file | 100644 | As in parent 1 ${left}.`,
      `right.txt | file | 100644 | As in parent 2 ${right}.`,
    ])
    // One listing of the commit and one comparison with each parent serve both directories.
    expect(overseer.listTree.mock.calls).toEqual([[oid('m')]])
    expect(overseer.listChangedPaths.mock.calls).toEqual([[oid('left'), oid('m')], [oid('right'), oid('m')]])
  })

  it('shows the entries of a directory with one parent without comparing, and its kinds and modes', async () => {
    const overseer = await open({
      page: serve([
        commit('a', { parents: [oid('p')] }), root('a', [entry('dir', 'root-p')]),
        path('a', 'run.sh', { entry: entry('executable', 'run'), parents: [entry('file', 'run')] }),
      ]),
      trees: () => [
        { name: 'docs', kind: 'dir', children: [] }, { name: 'link', kind: 'symlink' },
        { name: 'run.sh', kind: 'executable' }, { name: 'vendored', kind: 'submodule' },
      ],
    })
    await press(row('(root directory)'))
    const parent = oid('p').slice(0, 12)
    expect(entriesShown()).toEqual([
      `docs | directory | 40000 | As in parent 1 ${parent}.`,
      `link | symbolic link | 120000 | As in parent 1 ${parent}.`,
      'run.sh | executable | 100755 | Differs from every parent: listed as a row of its own.',
      `vendored | submodule entry | 160000 | As in parent 1 ${parent}.`,
    ])
    expect(overseer.listChangedPaths).not.toHaveBeenCalled()
  })

  it('shows a directory\'s entries only once the rows beneath it have loaded', async () => {
    const entries = [commit('a'), root('a'), added('a', 'one.txt'), added('a', 'two.txt'), commit('b'), root('b')]
    await open({ page: serve(entries, 3) })
    await press(row('(root directory)'))
    // The page ends beneath the root: an entry whose row is still to come would read as a parent's.
    expect(pane().textContent).toContain('Shown once the rows beneath this directory have loaded.')
    expect(entriesShown()).toEqual([])
    await press(button('Load more'))
    expect(entriesShown()).toEqual([
      'one.txt | file | 100644 | New: listed as a row of its own.',
      'two.txt | file | 100644 | New: listed as a row of its own.',
    ])
  })

  it('counts four hundred empty directories and the root above them as paths', async () => {
    const names = Array.from({ length: 400 }, (_, index) => `d${index}`)
    const entries = [commit('a'), root('a'), ...names.map(name => path('a', name, { entry: entry('dir', 'empty'), sent: dir(0) }))]
    const overseer = await open({ page: serve(entries) })
    // Outside the mark each page is asked for.
    for (let page = 1; page < 5; page++) await press(button('Load more'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(5)
    expect(rows()).toHaveLength(402)
    expect(shown()).toContain('1 commit, 401 paths, 3 objects sent in all.')
  })

  it('names the root directory', async () => {
    await open({ page: serve([commit('a'), path('a', '', { entry: entry('dir', 'empty'), parents: [], sent: dir(0) })]) })
    expect(rows()[1].textContent).toContain('(root directory)')
    await press(rows()[1])
    expect(pane().textContent).toContain('(root directory)')
    expect(pane().textContent).toContain('Empty directory.')
  })

  it('says which waiting requests the push is stacked on', async () => {
    await open({ page: serve([commit('a')], PUSH_REVIEW_PAGE_SIZE, [3]) })
    expect(shown()).toContain(
      'This push also sends what request #3 would send, which is still waiting. ' +
      'Denying that request takes nothing out of this push.')
  })

  it('names every request of a taller stack', async () => {
    await open({ page: serve([commit('a')], PUSH_REVIEW_PAGE_SIZE, [3, 5, 6]) })
    expect(shown()).toContain(
      'This push also sends what requests #3, #5 and #6 would send, which are still waiting. ' +
      'Denying those requests takes nothing out of this push.')
  })

  it('draws hard-to-see characters in a message, a path and a header name as tokens', async () => {
    const sneaky = commitText('Tidy\u202E up\n', 'x\u200Bkey value\n')
    await open({
      page: serve([
        commit('a', { text: sneaky, size: sneaky.length }), root('a'),
        path('a', 'docs/read\nme.md', { entry: entry('file', 'doc'), sent: text() }),
      ]),
      files: { [fileKey('a', 'docs/read\nme.md')]: { kind: 'text', text: 'hi\n' } },
    })
    expect(tokens(rows()[0])).toEqual(['U+202E'])
    expect(tokens(pane())).toEqual(['U+200B', 'U+202E'])
    expect(tokens(rows()[2])).toEqual(['U+000A'])
    await press(rows()[2])
    expect(tokens(pane())).toEqual(['U+000A'])
  })

  it('marks every trailing space of a message line, a header value and a path', async () => {
    const spaced = commitText('Subject   \nbody\n', 'note   \n')
    await open({
      page: serve([
        commit('a', { text: spaced, size: spaced.length }), root('a'),
        path('a', 'name ', { entry: entry('file', 'spaced'), sent: text() }),
      ]),
      files: { [fileKey('a', 'name ')]: { kind: 'text', text: 'x' } },
    })
    // The list row shows the subject's three spaces; the pane those and the header value's two
    // (its first space separates the name from the value).
    expect(spaceMarks(rows()[0])).toBe(3)
    expect(spaceMarks(pane())).toBe(5)
    expect(spaceMarks(rows()[2])).toBe(1)
    await press(rows()[2])
    expect(spaceMarks(pane())).toBe(1)
  })

  it('says a push that sends nothing only moves the branch', async () => {
    const overseer = await open({ page: () => ({ entries: [], objectCount: 0, stackedOn: [] }) })
    expect(shown()).toContain(
      `This push sends no objects: the remote already has ${oid('head').slice(0, 12)}. ` +
      'Approving it only moves the branch to that commit.')
    expect(overseer.getPushReview).toHaveBeenCalledWith(7, undefined)
    expect(buttons('Approve')).toHaveLength(0)
  })

  it('shows the request it reviews, and offers no decision outside the mark', async () => {
    await open({ page: serve([commit('a')]) })
    expect(shown()).toContain('Review commits')
    expect(shown()).toContain('Push to acme/widgets')
    expect(shown()).toContain('Push commit 1a2b3c4 to branch main')
    expect(shown()).toContain('Branch')
    expect(buttons('Approve')).toHaveLength(0)
    expect(buttons('Deny')).toHaveLength(0)
    expect(shown()).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(readiness()).toBeUndefined()
  })
})

// ---- where the push is approved ------------------------------------------------------------------

const approve = () => button('Approve')
const busy = () => Promise.reject(new Error('The workspace is busy.'))

describe('PushReviewDialog under the mark', () => {
  it('enables Approve once every page and file has loaded, whatever was opened', async () => {
    const secondPage = deferred<PushReview>()
    const late = deferred<FileAtCommit>()
    const entries = [
      commit('a'), root('a'), added('a', 'one.txt'),
      commit('b', { parents: [oid('a')] }), root('b', [entry('dir', 'root-a')]), added('b', 'two.txt'), added('b', 'three.txt'),
    ]
    const whole = serve(entries, 3)
    const overseer = await open({
      page: cursor => cursor === undefined ? whole() : secondPage.promise,
      files: {
        [fileKey('a', 'one.txt')]: { kind: 'text', text: 'one\n' },
        [fileKey('b', 'two.txt')]: late.promise,
        [fileKey('b', 'three.txt')]: late.promise,
      },
    }, { restricted: true })

    expect(shown()).toContain(RESTRICTED_APPROVAL_COPY)
    expect(readiness()).toBe('Loading the review.')
    expect(approve().disabled).toBe(true)
    expect(shown()).toContain('1 commit, 2 paths, 7 objects sent in all so far.')

    // The rest of the review arrives by itself, and its files are read without being opened.
    await act(async () => secondPage.resolve({ entries: entries.slice(3), objectCount: 7, stackedOn: [] }))
    await settle()
    expect(overseer.getPushReview.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, 3])
    expect(readiness()).toBe('Loading files: 1 of 3.')
    expect(approve().disabled).toBe(true)

    await act(async () => late.resolve({ kind: 'text', text: 'late\n' }))
    await settle()
    expect(readiness()).toBe('The whole review has loaded: 2 commits and 3 files.')
    expect(shown()).toContain('2 commits, 5 paths, 7 objects sent in all.')
    // Still on the first commit: nothing was selected on the way.
    expect(rows()[0].getAttribute('aria-current')).toBe('true')
    expect(approve().disabled).toBe(false)

    await press(approve())
    expect(onApprove).toHaveBeenCalledTimes(1)
    await press(button('Deny'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('waits for every directory the push sends to be listed as the review says', async () => {
    const merge = mergeOfTwoSides()
    const listing = deferred<TreeNode[]>()
    let listings = 0
    const overseer = await open({
      page: serve(merge.entries),
      files: textOfPath,
      // The first listing fails, and the second waits.
      trees: () => listings++ === 0 ? Promise.reject(new Error('The workspace is busy.')) : listing.promise,
      changed: merge.changed,
    }, { restricted: true })

    expect(readiness()).toBe('2 directories could not be listed.')
    expect(approve().disabled).toBe(true)
    expect(row('(root directory)').textContent).toContain('could not be read')
    await press(row('dModified'))
    expect(pane().textContent).toContain('The workspace is busy.')

    await press(button('Retry'))
    expect(readiness()).toBe('Listing directories: 0 of 2.')
    expect(approve().disabled).toBe(true)

    await act(async () => listing.resolve(merge.trees()))
    await settle()
    expect(overseer.listTree).toHaveBeenCalledTimes(2)
    expect(readiness()).toBe('The whole review has loaded: 1 commit and 1 file.')
    expect(entriesShown()).toHaveLength(2)
    expect(approve().disabled).toBe(false)
  })

  it('never approves a push whose directory lists otherwise than the review says', async () => {
    const merge = mergeOfTwoSides()
    await open({
      page: serve(merge.entries),
      files: textOfPath,
      trees: merge.trees,
      // right.txt differs from both parents, and the review has no row for it.
      changed: parent => [...merge.changed(parent), 'right.txt'],
    }, { restricted: true })
    expect(readiness()).toBe('1 directory did not list as the review says, so this push cannot be approved here.')
    expect(approve().disabled).toBe(true)
    expect(buttons('Retry')).toHaveLength(0)
    expect(row('(root directory)').textContent).toContain('not as listed')
    await press(row('(root directory)'))
    expect(pane().textContent).toContain(
      'The review lists no change at right.txt, but listing its commit shows it differs from every parent.')
  })

  it('lets Deny through while the review is still loading', async () => {
    await open({ page: () => new Promise<PushReview>(() => {}) }, { restricted: true })
    expect(approve().disabled).toBe(true)
    await press(button('Deny'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('names the notice, the request, the fields and the readiness line as what a decision rests on', async () => {
    await open({ page: serve([commit('a')]) }, { restricted: true })
    for (const decision of [approve(), button('Deny')]) {
      const described = decision.getAttribute('aria-describedby')!.split(' ')
        .map(id => document.getElementById(id)?.textContent)
      expect(described).toEqual([
        RESTRICTED_APPROVAL_COPY,
        'Push commit 1a2b3c4 to branch main',
        expect.stringContaining('Branch'),
        'The whole review has loaded: 1 commit and 0 files.',
      ])
    }
  })

  it('keeps Approve disabled on a failed page until a retry reads it', async () => {
    const whole = serve([commit('a'), root('a'), added('a', 'one.txt')])
    const overseer = await open({
      page: (_cursor, call) => call === 0 ? busy() : whole(),
      files: { [fileKey('a', 'one.txt')]: { kind: 'text', text: 'one\n' } },
    }, { restricted: true })
    expect(readiness()).toBe('The review could not be loaded.')
    expect(shown()).toContain('The workspace is busy.')
    expect(approve().disabled).toBe(true)
    expect(buttons('Retry')).toHaveLength(1)

    await press(button('Retry'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(2)
    expect(approve().disabled).toBe(false)
    expect(buttons('Retry')).toHaveLength(0)
  })

  it('keeps Approve disabled on failed file reads, says how many, and retries them', async () => {
    let attempts = 0
    const overseer = await open({
      page: serve([commit('a'), root('a'), added('a', 'one.txt'), added('a', 'two.txt')]),
      files: (_commitId, at) => at === 'two.txt' && attempts++ === 0 ? busy() : { kind: 'text', text: `${at}\n` },
    }, { restricted: true })
    // One read carries both paths, so both fail with it.
    expect(readiness()).toBe('2 files could not be read.')
    expect(approve().disabled).toBe(true)
    expect(row('one.txt').textContent).toContain('could not be read')

    await press(button('Retry'))
    expect(overseer.readFilesAtCommit).toHaveBeenCalledTimes(2)
    expect(readiness()).toBe('The whole review has loaded: 1 commit and 2 files.')
    expect(approve().disabled).toBe(false)
    expect(row('one.txt').textContent).not.toContain('could not be read')
  })

  it.each<[string, FileAtCommit, string]>([
    ['content that is not text', { kind: 'blob', blob: { oid: 'f'.repeat(40), byteLength: 4 } },
      'The review lists f.txt as text, but reading it returned content that is not text.'],
    ['nothing', { kind: 'absent' }, 'The review lists f.txt as text, but reading it returned nothing at that path.'],
    ['something that is not a file', { kind: 'unreadable', message: 'f.txt is a symbolic link' },
      'The review lists f.txt as text, but reading it returned something that is not a file.'],
  ])('refuses a file listed as text whose read returns %s', async (_name, file, sentence) => {
    await open({
      page: serve([commit('a'), root('a'), added('a', 'f.txt')]),
      files: { [fileKey('a', 'f.txt')]: file },
    }, { restricted: true })
    expect(readiness()).toBe('1 file did not come back as the review lists it, so this push cannot be approved here.')
    expect(approve().disabled).toBe(true)
    expect(buttons('Retry')).toHaveLength(0)
    expect(row('f.txt').textContent).toContain('not as listed')

    await press(row('f.txt'))
    expect(pane().textContent).toContain(sentence)
    expect(editor()).toBeUndefined()
    // No retry settles a read that disagrees with the review: the pane offers none either.
    expect(buttons('Retry')).toHaveLength(0)
    expect(approve().disabled).toBe(true)
  })

  it('keeps Approve disabled while a symbolic link is read and when its read fails, then retries it', async () => {
    const first = deferred<FileAtCommit>()
    let attempts = 0
    const overseer = await open({
      page: serve([commit('a'), root('a'), path('a', 'link', { entry: entry('symlink', 'l'), sent: text() })]),
      files: () => attempts++ === 0 ? first.promise : { kind: 'unreadable', message: 'link is a symbolic link to target' },
    }, { restricted: true })
    // The review promises text of no file here, and still waits for the read it started.
    expect(readiness()).toBe('Loading 1 file.')
    expect(approve().disabled).toBe(true)

    await act(async () => first.reject(new Error('The workspace is busy.')))
    await settle()
    expect(readiness()).toBe('1 file could not be read.')
    expect(approve().disabled).toBe(true)
    expect(row('link').textContent).toContain('could not be read')

    await press(button('Retry'))
    expect(overseer.readFilesAtCommit).toHaveBeenCalledTimes(2)
    expect(readiness()).toBe('The whole review has loaded: 1 commit and 0 files.')
    expect(approve().disabled).toBe(false)
    await press(row('link'))
    expect(pane().textContent).toContain('link is a symbolic link to target')
  })

  it('keeps Approve disabled when a large file the approver asked for cannot be read', async () => {
    let attempts = 0
    await open({
      page: serve([
        commit('a'), root('a'),
        path('a', 'big.txt', { entry: entry('file', 'big'), sent: { kind: 'large', size: MAX_BUFFERED_BLOB_SIZE + 1 } }),
      ]),
      files: () => attempts++ === 0 ? busy() : { kind: 'text', text: 'big\n' },
    }, { restricted: true })
    expect(approve().disabled).toBe(false)

    await press(row('big.txt'))
    await press(button('Show file'))
    expect(readiness()).toBe('1 file could not be read.')
    expect(approve().disabled).toBe(true)

    // The readiness line and the pane each offer the same retry.
    await press(button('Retry'))
    expect(editor()).toMatchObject({ original: null, text: 'big\n' })
    expect(approve().disabled).toBe(false)
  })

  it('refuses a large file whose read names another object', async () => {
    const size = MAX_BUFFERED_BLOB_SIZE + 1
    const other = oid('other')
    await open({
      page: serve([commit('a'), root('a'), path('a', 'big.bin', { entry: entry('file', 'big'), sent: { kind: 'large', size } })]),
      files: { [fileKey('a', 'big.bin')]: { kind: 'blob', blob: { oid: other, byteLength: size } } },
      blobs: { [other]: new Uint8Array(size) },
    }, { restricted: true })
    // A file that large was never promised to be text, so it does not hold Approve back unread.
    expect(approve().disabled).toBe(false)

    await press(row('big.bin'))
    await press(button('Show file'))
    expect(pane().textContent).toContain('The review lists big.bin as a large file, but reading it returned another object.')
    expect(approve().disabled).toBe(true)
  })

  it('does not hold Approve back when a parent version cannot be read', async () => {
    await open({
      page: serve([commit('b', { parents: [oid('a')] }), root('b', [entry('dir', 'r')]), modified('b', 'f.txt')]),
      files: (commitId, at) => commitId === oid('b') ? { kind: 'text', text: `${at}\n` } : busy(),
    }, { restricted: true })
    expect(approve().disabled).toBe(false)
    await press(row('f.txt'))
    expect(editor()).toMatchObject({ original: null, text: 'f.txt\n' })
    expect(pane().textContent).toContain('The earlier version could not be read.')
    expect(approve().disabled).toBe(false)
  })

  it('approves a push from before the mark once its text has loaded, and reads nothing else', async () => {
    const overseer = await open({
      page: serve([
        commit('a'), root('a'), added('a', 'ok.txt'),
        path('a', 'data.bin', { entry: entry('file', 'bin'), sent: { kind: 'binary', size: 2048 } }),
        path('a', 'big.txt', { entry: entry('file', 'big'), sent: { kind: 'large', size: MAX_BUFFERED_BLOB_SIZE + 1 } }),
        path('a', 'missing.txt', { entry: entry('file', 'gone'), sent: { kind: 'absent' } }),
        path('a', 'odd', { entry: entry('dir', 'odd'), sent: { kind: 'unlistable', size: 70 } }),
        { kind: 'object', oid: oid('orphan'), type: 'blob', size: 5 },
      ]),
      files: { [fileKey('a', 'ok.txt')]: { kind: 'text', text: 'ok\n' } },
    }, { restricted: true })
    expect(approve().disabled).toBe(false)
    expect(readPaths(overseer)).toEqual([fileKey('a', 'ok.txt')])
    expect(overseer.readBlob).not.toHaveBeenCalled()
    expect(shown()).toContain(
      '5 things this push sends are not shown as text; each says why. A push holds such things only ' +
      'when it was already waiting before this workspace read restricted data.')
  })

  it('approves a push that sends nothing once the empty review has loaded', async () => {
    await open({ page: () => ({ entries: [], objectCount: 0, stackedOn: [] }) }, { restricted: true })
    expect(shown()).toContain('This push sends no objects')
    expect(approve().disabled).toBe(false)
  })

  it('ignores a page that arrives for a request it no longer reviews', async () => {
    const stale = deferred<PushReview>()
    const overseer = await open({
      page: (_cursor, call) => call === 0 ? stale.promise : serve([commit('b')])(),
    }, { restricted: true })
    expect(readiness()).toBe('Loading the review.')

    // Another request takes the dialog while the first one's page is still on its way.
    await show(overseer, { restricted: true, entryRecord: { ...record(), id: 8 } })
    expect(rows().map(item => item.textContent)).toEqual([expect.stringContaining('Subject of b')])
    expect(approve().disabled).toBe(false)

    await act(async () => stale.resolve(serve([commit('a'), root('a'), added('a', 'one.txt')])()))
    await settle()
    expect(overseer.getPushReview.mock.calls).toEqual([[7, undefined], [8, undefined]])
    expect(rows().map(item => item.textContent)).toEqual([expect.stringContaining('Subject of b')])
    expect(readiness()).toBe('The whole review has loaded: 1 commit and 0 files.')
    expect(approve().disabled).toBe(false)
    expect(overseer.readFilesAtCommit).not.toHaveBeenCalled()
  })
})

// Outside the mark there is no readiness line, so a failed read carries its own Retry.
describe('PushReviewDialog outside the mark, when a read fails', () => {
  it('offers one Retry for a first page that failed, and reads it again', async () => {
    const whole = serve([commit('a'), root('a'), added('a', 'one.txt')])
    const overseer = await open({ page: (_cursor, call) => call === 0 ? busy() : whole() })
    expect(shown()).toContain('The workspace is busy.')
    expect(buttons('Retry')).toHaveLength(1)
    expect(readiness()).toBeUndefined()

    await press(button('Retry'))
    expect(overseer.getPushReview.mock.calls).toEqual([[7, undefined], [7, undefined]])
    expect(shown()).not.toContain('The workspace is busy.')
    expect(buttons('Retry')).toHaveLength(0)
    expect(rows().map(item => item.textContent)).toEqual([
      expect.stringContaining('Subject of a'), expect.stringContaining('(root directory)'),
      expect.stringContaining('one.txt'),
    ])
  })

  it('offers one Retry for a later page that failed, and reads that page again', async () => {
    const whole = serve([commit('a'), root('a'), added('a', 'one.txt'), added('a', 'two.txt')], 2)
    const overseer = await open({ page: (cursor, call) => call === 1 ? busy() : whole(cursor) })
    await press(button('Load more'))
    // What was read stays listed; the page that failed is the only thing left to ask for.
    expect(rows()[0].textContent).toContain('Subject of a')
    expect(shown()).toContain('The workspace is busy.')
    expect(buttons('Retry')).toHaveLength(1)
    expect(buttons('Load more')).toHaveLength(0)

    await press(button('Retry'))
    expect(overseer.getPushReview.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, 2, 2])
    expect(shown()).not.toContain('The workspace is busy.')
    expect(buttons('Retry')).toHaveLength(0)
    expect(rows().map(item => item.textContent)).toEqual([
      expect.stringContaining('Subject of a'), expect.stringContaining('(root directory)'),
      expect.stringContaining('one.txt'), expect.stringContaining('two.txt'),
    ])
    expect(shown()).toContain('1 commit, 3 paths, 4 objects sent in all.')
  })

  it('offers one Retry for a file read that failed, and reads the file again', async () => {
    let attempts = 0
    const overseer = await open({
      page: serve([commit('a'), root('a'), added('a', 'one.txt')]),
      files: () => attempts++ === 0 ? busy() : { kind: 'text', text: 'one\n' },
    })
    await press(row('one.txt'))
    expect(pane().textContent).toContain('The workspace is busy.')
    expect(buttons('Retry')).toHaveLength(1)
    expect(editor()).toBeUndefined()

    // Opening the row again does not read it: only Retry does.
    await press(rows()[0])
    await press(row('one.txt'))
    expect(overseer.readFilesAtCommit).toHaveBeenCalledTimes(1)

    await press(button('Retry'))
    expect(readPaths(overseer)).toEqual([fileKey('a', 'one.txt'), fileKey('a', 'one.txt')])
    expect(pane().textContent).not.toContain('The workspace is busy.')
    expect(buttons('Retry')).toHaveLength(0)
    expect(editor()).toMatchObject({ filename: 'one.txt', original: null, text: 'one\n' })
  })
})

// A push that was already waiting when the workspace became restricted, and sends more than the
// dialog loads unasked: 650 files, and with the commit and the root more objects than the limit.
const tooManyObjects = () => [
  commit('a'), root('a'), ...Array.from({ length: 650 }, (_, index) => added('a', `f${index}.txt`)),
]
const textOfPath = (_commitId: string, at: string): FileAtCommit => ({ kind: 'text', text: `${at}\n` })
// One commit whose pages never end: each lists a hundred paths that send nothing.
const endless = (cursor = 0): PushReview => ({
  entries: Array.from({ length: PUSH_REVIEW_PAGE_SIZE }, (_, index): PushReviewEntry =>
    cursor + index === 0 ? commit('a') : path('a', `p${cursor + index}`, { entry: entry('file', 'same') })),
  objectCount: 1,
  stackedOn: [],
  next: cursor + PUSH_REVIEW_PAGE_SIZE,
})

describe('PushReviewDialog with a review too large to load by itself', () => {
  it('loads nothing unasked, and approves once the approver has loaded all of it', async () => {
    const entries = tooManyObjects()
    expect(sentObjectCount(entries)).toBeGreaterThan(MAX_WHOLE_REVIEW_ENTRIES)
    const overseer = await open({ page: serve(entries), files: textOfPath }, { restricted: true })

    // One page, no file, and the reason on the readiness line.
    expect(overseer.getPushReview).toHaveBeenCalledTimes(1)
    expect(overseer.readFilesAtCommit).not.toHaveBeenCalled()
    expect(readiness()).toBe(
      'This push is too large to load by itself: 100 entries loaded so far. Load the rest of it to approve it.')
    expect(approve().disabled).toBe(true)
    expect(list().parentElement!.textContent).toContain('Showing the first 100 entries')
    await press(button('Deny'))
    expect(onReject).toHaveBeenCalledTimes(1)

    // A page per request, and a file when its row is opened.
    await press(button('Load more'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(2)
    expect(overseer.getPushReview).toHaveBeenLastCalledWith(7, 100)
    await press(row('f3.txt'))
    expect(readPaths(overseer)).toEqual([fileKey('a', 'f3.txt')])
    expect(editor()).toMatchObject({ text: 'f3.txt\n' })
    await press(rows()[0])

    // Every page in: what is left to load is the files, and the review says how many.
    while (buttons('Load more').length > 0) await press(button('Load more'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(7)
    expect(readiness()).toBe('1 of 650 files loaded. Load the rest to approve this push.')
    expect(approve().disabled).toBe(true)

    await press(button('Load files'))
    const batches = overseer.readFilesAtCommit.mock.calls.slice(1).map(([, paths]) => paths.length)
    expect(Math.max(...batches)).toBeLessThanOrEqual(64)
    expect(batches.reduce((sum, count) => sum + count, 0)).toBe(649)
    expect(readiness()).toBe('The whole review has loaded: 1 commit and 650 files.')
    expect(rows()[0].getAttribute('aria-current')).toBe('true')
    expect(approve().disabled).toBe(false)
    await press(approve())
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('stops reading by itself once the entries pass the limit, however few objects the push sends', async () => {
    const overseer = await open({ page: endless }, { restricted: true })
    expect(overseer.getPushReview).toHaveBeenCalledTimes(7)
    expect(readiness()).toBe(
      'This push is too large to load by itself: 700 entries loaded so far. Load the rest of it to approve it.')
    expect(approve().disabled).toBe(true)

    await press(button('Load more'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(8)
    await press(button('Deny'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('retries a page and files that fail on the way, and refuses a file that is not as listed', async () => {
    const entries = tooManyObjects()
    const whole = serve(entries, 400)
    const overseer = await open({
      page: (cursor, call) => call === 1 ? busy() : whole(cursor),
      files: (commitId, at) =>
        at === 'f649.txt' ? { kind: 'absent' } : at === 'f1.txt' ? busy() : textOfPath(commitId, at),
    }, { restricted: true })

    await press(button('Load more'))
    expect(readiness()).toBe('The review could not be loaded.')
    await press(button('Retry'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(3)
    expect(readiness()).toBe('0 of 650 files loaded. Load the rest to approve this push.')

    await press(button('Load files'))
    // The file that is not as listed is reported before the batch that failed.
    expect(readiness()).toBe('1 file did not come back as the review lists it, so this push cannot be approved here.')
    expect(approve().disabled).toBe(true)
    expect(buttons('Retry')).toHaveLength(0)
    expect(row('f1.txt').textContent).toContain('could not be read')
    expect(row('f649.txt').textContent).toContain('not as listed')
  })

  it('shows what a review cut short lists, says the push is too large to review whole, and reads no further', async () => {
    const entries = [commit('a'), root('a'), added('a', 'one.txt'), added('a', 'two.txt')]
    // The kernel listed three entries of a push that sends far more, and stopped.
    const cutShort = (): PushReview =>
      ({ entries: entries.slice(0, 3), objectCount: 90_000, stackedOn: [], truncated: true })
    const overseer = await open({ page: cutShort, files: textOfPath }, { restricted: true })

    expect(overseer.getPushReview).toHaveBeenCalledTimes(1)
    expect(row('Subject of a')).toBeDefined()
    expect(row('one.txt')).toBeDefined()
    expect(list().textContent).not.toContain('two.txt')
    expect(readiness()).toBe(
      'This push is too large to review whole: only its first 3 entries could be listed. It cannot be approved here.')
    expect(shown()).toContain('90000 objects sent in all.')
    // What it lists is shown as any review's is, and nothing enables Approve.
    await press(row('one.txt'))
    expect(editor()).toMatchObject({ text: 'one.txt\n' })
    expect(approve().disabled).toBe(true)
    expect(buttons('Load more')).toHaveLength(0)
    expect(buttons('Retry')).toHaveLength(0)
    await press(button('Deny'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('says so when a review cut short lists nothing, and offers nothing to load outside the mark', async () => {
    const overseer = await open({
      page: () => ({ entries: [], objectCount: 90_000, stackedOn: [], truncated: true }),
    })
    expect(overseer.getPushReview).toHaveBeenCalledTimes(1)
    expect(shown()).toContain('This push is too large to review whole: none of it could be listed.')
    expect(shown()).toContain('Listing this push takes more than one read of it may')
    expect(dialog().querySelector('[aria-label="Loading the review"]')).toBeNull()
    expect(buttons('Load more')).toHaveLength(0)
  })

  it('retries the files of a batch that failed, then approves', async () => {
    const entries = tooManyObjects()
    let failing = true
    await open({
      page: serve(entries, 700),
      files: (commitId, at) => at === 'f1.txt' && failing ? busy() : textOfPath(commitId, at),
    }, { restricted: true })
    await press(button('Load files'))
    expect(readiness()).toBe('64 files could not be read.')
    expect(approve().disabled).toBe(true)

    failing = false
    await press(button('Retry'))
    expect(readiness()).toBe('The whole review has loaded: 1 commit and 650 files.')
    expect(approve().disabled).toBe(false)
  })
})

describe('PushReviewDialog when the push changes while it is read', () => {
  it('starts over when a page reports another object count', async () => {
    const first = [
      commit('a'), root('a'), added('a', 'one.txt'), added('a', 'two.txt'), added('a', 'three.txt'), added('a', 'four.txt'),
    ]
    const second = [...first, added('a', 'five.txt')]
    const overseer = await open({
      page: (cursor, call) =>
        call === 0 ? serve(first, 2)(cursor)
          // The second page of three: the count alone says the push changed, with a page to come.
          : call === 1 ? { ...serve(first, 2)(cursor), objectCount: 7 }
            : serve(second, 2)(cursor),
    })
    await press(button('Load more'))
    // The read starts over there, without asking for the page after the one that disagreed.
    expect(overseer.getPushReview.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, 2, undefined])
    expect(shown()).toContain('This push changed while it was being read, so it was read again from the start.')

    while (buttons('Load more').length > 0) await press(button('Load more'))
    expect(overseer.getPushReview.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, 2, undefined, 2, 4, 6])
    expect(rows().map(item => item.textContent)).toEqual([
      expect.stringContaining('Subject of a'), expect.stringContaining('(root directory)'),
      expect.stringContaining('one.txt'), expect.stringContaining('two.txt'), expect.stringContaining('three.txt'),
      expect.stringContaining('four.txt'), expect.stringContaining('five.txt'),
    ])
    expect(shown()).toContain('1 commit, 6 paths, 7 objects sent in all.')
  })

  it('starts over when a page repeats an entry already held', async () => {
    const tail = [added('a', 'b.txt'), added('a', 'c.txt'), added('a', 'd.txt'), added('a', 'e.txt')]
    const before = [commit('a'), root('a'), ...tail]
    // An entry appeared before the cursor, and the rest moved down.
    const after = [commit('a'), root('a'), added('a', 'a.txt'), ...tail]
    const overseer = await open({
      page: (cursor, call) => call === 0
        ? { ...serve(before, 3)(cursor), objectCount: sentObjectCount(after) }
        : serve(after, 3)(cursor),
      files: textOfPath,
    }, { restricted: true })
    // The second page of three repeats b.txt and agrees on the count: the repeat alone starts
    // the read over, before the page after it is asked for.
    expect(overseer.getPushReview.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, 3, undefined, 3, 6])
    expect(shown()).toContain('This push changed while it was being read, so it was read again from the start.')
    expect(rows()).toHaveLength(7)
    expect(approve().disabled).toBe(false)
  })

  it('starts over when the last page leaves an object out, and never approves the pages that did', async () => {
    const orphanA = { kind: 'object', oid: oid('orphan-a'), type: 'blob', size: 1 } as const
    const orphanB = { kind: 'object', oid: oid('orphan-b'), type: 'blob', size: 1 } as const
    const before = [commit('a'), root('a'), added('a', 'x.txt'), orphanA, orphanB]
    // The first orphan has come to sit at a path, before the cursor: the page after it no
    // longer lists it, and nothing in that page repeats.
    const after = [
      commit('a'), root('a'),
      path('a', 'late.txt', { entry: { kind: 'file', oid: orphanA.oid }, sent: text() }),
      added('a', 'x.txt'), orphanB,
    ]
    const again = deferred<PushReview>()
    const overseer = await open({
      page: (cursor, call) =>
        call === 0 ? serve(before, 3)(cursor)
          : call === 1 ? { entries: [orphanB], objectCount: 5, stackedOn: [] }
            : call === 2 ? again.promise
              : serve(after, 3)(cursor),
      files: textOfPath,
    }, { restricted: true })

    // The two pages name four objects of five: the read starts over, and is not whole meanwhile.
    expect(overseer.getPushReview.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, 3, undefined])
    expect(readiness()).toBe('Loading the review.')
    expect(approve().disabled).toBe(true)

    await act(async () => again.resolve(serve(after, 3)()))
    await settle()
    expect(shown()).toContain('This push changed while it was being read, so it was read again from the start.')
    expect(rows().map(item => item.textContent)).toEqual([
      expect.stringContaining('Subject of a'), expect.stringContaining('(root directory)'),
      expect.stringContaining('late.txt'), expect.stringContaining('x.txt'), expect.stringContaining('blob'),
    ])
    expect(shown()).toContain('1 commit, 3 paths, 5 objects sent in all.')
    expect(approve().disabled).toBe(false)
  })

  it('gives up after three restarts, and reads again on Retry', async () => {
    const listing = [commit('a'), root('a'), added('a', 'one.txt'), added('a', 'two.txt')]
    let settled = false
    const overseer = await open({
      // The second page never agrees with the first about how much the push sends.
      page: cursor => cursor === undefined || settled
        ? serve(listing, 2)(cursor)
        : { ...serve(listing, 2)(cursor), objectCount: 9 },
      files: textOfPath,
    }, { restricted: true })
    // The first read and three more, two pages each.
    expect(overseer.getPushReview).toHaveBeenCalledTimes(8)
    expect(shown()).toContain('The push changed while it was being read.')
    expect(readiness()).toBe('The review could not be loaded.')
    expect(approve().disabled).toBe(true)

    settled = true
    await press(button('Retry'))
    expect(overseer.getPushReview).toHaveBeenCalledTimes(10)
    expect(approve().disabled).toBe(false)
  })
})
