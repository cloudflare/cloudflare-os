import { describe, expect, it } from 'vitest'
import {
  PUSH_REVIEW_PAGE_SIZE, READ_FILES_RESPONSE_BUDGET,
  type PushReviewEntry, type PushReviewParentEntry, type PushReviewSent, type PushReviewTreeEntry,
} from '@gadgets/workshop-shared/api'
import {
  MAX_RESTRICTED_PUSH_COMMITS, MAX_RESTRICTED_PUSH_FILES, MAX_RESTRICTED_PUSH_PATHS,
  MAX_RESTRICTED_PUSH_TEXT_SIZE,
} from '@gadgets/workshop-shared/gatekeeper'
import {
  MAX_WHOLE_REVIEW_ENTRIES, ROOT_LABEL, commitSubject, comparableParent, entryKey, expectsText, formatCommitText,
  groupPushReview, listedPaths, notShownAsText, parseCommitText, pathChange, pathNotes,
  reviewItems, reviewReadiness, reviewTooLarge, sentObjectCount,
  type CommitRow, type FilesProgress, type PathRow, type ReviewProgress,
} from './pushReviewModel'

const oid = (name: string) => name.padEnd(40, '0')
const C1 = oid('c1')
const C2 = oid('c2')

const NONE: PushReviewParentEntry = { kind: 'none' }
const UNKNOWN: PushReviewParentEntry = { kind: 'unknown' }
const entry = (kind: PushReviewTreeEntry['kind'], name: string): PushReviewTreeEntry => ({ kind, oid: oid(name) })
const text = (size = 10): PushReviewSent => ({ kind: 'text', size })
const dir = (size = 30): PushReviewSent => ({ kind: 'dir', size })

const commit = (id: string, over: Partial<CommitRow> = {}): CommitRow =>
  ({ kind: 'commit', oid: id, parents: [], size: 200, text: 'tree 0\n\nmessage\n', ...over })
const path = (id: string, at: string, over: Partial<Omit<PathRow, 'kind' | 'commit' | 'path'>> = {}): PathRow =>
  ({ kind: 'path', commit: id, path: at, parents: [NONE], ...over })
/** A directory the review opens: sent, and a directory (or nothing) in its parent. */
const opened = (id: string, at: string, parents: PushReviewParentEntry[] = [entry('dir', `old-${at}`)]): PathRow =>
  path(id, at, { entry: entry('dir', `tree-${id}-${at}`), parents, sent: dir() })
const added = (id: string, at: string): PathRow =>
  path(id, at, { entry: entry('file', `blob-${at}`), sent: text() })
const emptyDir = (id: string, at: string): PathRow =>
  path(id, at, { entry: entry('dir', 'empty-tree'), sent: dir(0) })

const listed = (rows: PathRow[]) => listedPaths({ commit: commit(rows[0].commit), paths: rows }).map(row => row.path)

describe('parseCommitText', () => {
  it('reads the headers in order and the message', () => {
    expect(parseCommitText(
      'tree aaa\nparent bbb\nauthor A U Thor <a@example.com> 1700000000 +0100\n' +
      'committer C <c@example.com> 1700000001 -0700\n\nSubject\n\nBody\n',
    )).toEqual({
      headers: [
        { name: 'tree', value: 'aaa' },
        { name: 'parent', value: 'bbb' },
        { name: 'author', value: 'A U Thor <a@example.com> 1700000000 +0100' },
        { name: 'committer', value: 'C <c@example.com> 1700000001 -0700' },
      ],
      message: 'Subject\n\nBody\n',
      terminated: true,
    })
  })

  it('joins a signature with its continuation lines, and keeps a header it does not know', () => {
    const parsed = parseCommitText(
      'tree aaa\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n' +
      'encoding ISO-8859-1\n\nm',
    )
    expect(parsed.headers).toEqual([
      { name: 'tree', value: 'aaa' },
      { name: 'gpgsig', value: '-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----' },
      { name: 'encoding', value: 'ISO-8859-1' },
    ])
    expect(parsed.message).toBe('m')
  })

  it('keeps a message as written: carriage returns, leading and trailing line breaks', () => {
    expect(parseCommitText('tree aaa\n\n\n\nSubject\r\nBody\r\n\n').message).toBe('\n\nSubject\r\nBody\r\n\n')
  })

  it('says when the headers never end, and when nothing follows them', () => {
    expect(parseCommitText('tree aaa')).toEqual({ headers: [{ name: 'tree', value: 'aaa' }], terminated: false })
    expect(parseCommitText('tree aaa\n')).toEqual({ headers: [{ name: 'tree', value: 'aaa' }], terminated: true })
    expect(parseCommitText('tree aaa\n\n')).toEqual({
      headers: [{ name: 'tree', value: 'aaa' }], message: '', terminated: true,
    })
  })

  it('keeps a line that is not a header as it is, and lets nothing continue it', () => {
    expect(parseCommitText(' first\nnospace\n after raw\ntree aaa\n more').headers).toEqual([
      { raw: ' first' },
      { raw: 'nospace' },
      { raw: ' after raw' },
      { name: 'tree', value: 'aaa\nmore' },
    ])
  })

  it.each([
    ['plain', 'tree aaa\nauthor A <a@b> 1 +0000\n\nSubject\n'],
    ['no blank line', 'tree aaa\nauthor A'],
    ['no blank line, trailing newline', 'tree aaa\nauthor A\n'],
    ['a header line with no space', 'tree aaa\nnospace\n\nm'],
    ['a first line starting with a space', ' leading\ntree aaa\n\nm'],
    ['a continuation after a raw line', 'tree aaa\nraw\n continued\n again\n\nm'],
    ['a continuation that is a single space', 'gpgsig a\n \n b\n\nm'],
    ['a header with an empty value', 'tree \n\nm'],
    ['the empty string', ''],
    ['a blank first line', '\ntree aaa\n\nm'],
    ['an empty message', 'tree aaa\n\n'],
    ['a message of blank lines', 'tree aaa\n\n\n\n'],
    ['carriage returns', 'tree aaa\r\nauthor A\r\n\r\nSubject\r\n'],
    ['a line of one space', ' \n\nm'],
  ])('gives the text back exactly: %s', (_name, original) => {
    expect(formatCommitText(parseCommitText(original))).toBe(original)
    // The list row's subject is the first line of the message the commit view shows.
    expect(commitSubject(original)).toBe(parseCommitText(original).message?.split('\n')[0])
  })
})

describe('groupPushReview', () => {
  it('keeps each commit with its paths across a page boundary, and the objects apart', () => {
    const first: PushReviewEntry[] = [commit(C1), added(C1, 'a.txt'), commit(C2)]
    const second: PushReviewEntry[] = [
      added(C2, 'b.txt'), added(C2, 'c.txt'), { kind: 'object', oid: oid('f'), type: 'blob', size: 3 },
    ]
    const { commits, objects } = groupPushReview([...first, ...second])
    expect(commits.map(reviewed => [reviewed.commit.oid, reviewed.paths.map(row => row.path)])).toEqual([
      [C1, ['a.txt']],
      [C2, ['b.txt', 'c.txt']],
    ])
    expect(objects.map(row => row.oid)).toEqual([oid('f')])
  })

  it('drops no path row whose commit is missing', () => {
    const { commits } = groupPushReview([added(C1, 'a.txt')])
    expect(commits).toHaveLength(1)
    expect(commits[0].commit).toEqual({ kind: 'commit', oid: C1, parents: [] })
    expect(commits[0].paths).toHaveLength(1)
  })
})

describe('listedPaths', () => {
  it('folds an opened directory that has a listed row beneath it', () => {
    expect(listed([opened(C1, ''), opened(C1, 'src'), added(C1, 'src/a.ts'), added(C1, 'b.ts')]))
      .toEqual(['src/a.ts', 'b.ts'])
  })

  it('keeps a directory that replaces a file: the removed file shows there', () => {
    expect(listed([
      opened(C1, ''), opened(C1, 'lib', [entry('file', 'old-lib')]), added(C1, 'lib/a.ts'),
    ])).toEqual(['lib', 'lib/a.ts'])
  })

  it('keeps an added empty directory beside a changed file', () => {
    expect(listed([opened(C1, ''), added(C1, 'a.txt'), emptyDir(C1, 'empty')])).toEqual(['a.txt', 'empty'])
  })

  it('keeps four hundred empty directories by name, and folds the root above them', () => {
    const names = Array.from({ length: 400 }, (_, index) => `d${index}`)
    expect(listed([opened(C1, '', [NONE]), ...names.map(name => emptyDir(C1, name))])).toEqual(names)
  })

  it('keeps only the innermost of a chain of directories ending in an empty one', () => {
    expect(listed([
      opened(C1, ''), opened(C1, 'a', [NONE]), opened(C1, 'a/b', [NONE]), emptyDir(C1, 'a/b/c'),
    ])).toEqual(['a/b/c'])
  })

  it('keeps a sent directory whose parent is unknown and that has no row beneath it', () => {
    expect(listed([opened(C1, '', [UNKNOWN]), opened(C1, 'vendor', [UNKNOWN])])).toEqual(['vendor'])
  })

  it('keeps a directory of a merge whose every entry comes from one side or the other', () => {
    expect(listed([
      opened(C1, '', [entry('dir', 'ours'), entry('dir', 'theirs')]),
      opened(C1, 'mixed', [entry('dir', 'ours-mixed'), entry('dir', 'theirs-mixed')]),
    ])).toEqual(['mixed'])
  })

  it('keeps the root of a root commit whose tree is empty', () => {
    expect(listed([path(C1, '', { entry: entry('dir', 'empty-tree'), parents: [], sent: dir(0) })])).toEqual([''])
    expect(ROOT_LABEL).toBe('(root directory)')
  })

  it('judges the same directory name per commit', () => {
    const { commits } = groupPushReview([
      commit(C1), opened(C1, ''), opened(C1, 'docs'), added(C1, 'docs/a.md'),
      commit(C2, { parents: [C1] }), opened(C2, ''), opened(C2, 'docs'),
    ])
    expect(commits.map(reviewed => listedPaths(reviewed).map(row => row.path))).toEqual([['docs/a.md'], ['docs']])
  })

  it('shows a directory until the rows beneath it arrive', () => {
    expect(listed([opened(C1, ''), opened(C1, 'src')])).toEqual(['src'])
    expect(listed([opened(C1, ''), opened(C1, 'src'), added(C1, 'src/a.ts')])).toEqual(['src/a.ts'])
  })
})

describe('reviewItems', () => {
  it('lists each commit, the paths it keeps, then the objects without a path', () => {
    const items = reviewItems(groupPushReview([
      commit(C1), opened(C1, ''), added(C1, 'a.txt'),
      commit(C2, { parents: [C1] }), opened(C2, ''), added(C2, 'a.txt'),
      { kind: 'object', oid: oid('f'), type: 'blob' },
    ]))
    expect(items.map(item => item.key)).toEqual([
      `commit:${C1}`, `path:${C1}:a.txt`, `commit:${C2}`, `path:${C2}:a.txt`, `object:${oid('f')}`,
    ])
  })
})

describe('entryKey and sentObjectCount', () => {
  it('tells apart a commit, an object and a path of the same oid, and one path under two commits', () => {
    const keys = [
      entryKey(commit(C1)),
      entryKey({ kind: 'object', oid: C1, type: 'commit' }),
      entryKey(path(C1, C1)),
      entryKey(path(C2, C1)),
    ]
    expect(new Set(keys).size).toBe(4)
  })

  it('counts each object once, and nothing for an entry that sends none', () => {
    const blob = entry('file', 'shared')
    const entries: PushReviewEntry[] = [
      commit(C1),
      opened(C1, ''),
      path(C1, 'a.txt', { entry: blob, sent: text() }),
      path(C1, 'copy.txt', { entry: blob, sent: text() }),
      // Not what its entry says: the object is a commit of this push, counted once.
      path(C1, 'odd', { entry: { kind: 'file', oid: C1 }, sent: { kind: 'mistyped', type: 'commit', size: 200 } }),
      path(C1, 'already.txt', { entry: entry('file', 'remote-has') }),
      path(C1, 'gone.txt', { parents: [entry('file', 'gone')] }),
      { kind: 'object', oid: oid('f'), type: 'tree' },
    ]
    // The commit, the root tree, the shared blob and the object without a path.
    expect(sentObjectCount(entries)).toBe(4)
  })
})

const commits = (count: number) => Array.from({ length: count }, (_, index) => commit(oid(`c${index}x`), { size: 1 }))

describe('reviewTooLarge', () => {
  it('is false at the limit and true one past it, for objects and for entries', () => {
    expect(MAX_WHOLE_REVIEW_ENTRIES).toBe(6 * PUSH_REVIEW_PAGE_SIZE)
    expect(reviewTooLarge(commits(MAX_WHOLE_REVIEW_ENTRIES), MAX_WHOLE_REVIEW_ENTRIES)).toBe(false)
    expect(reviewTooLarge([], MAX_WHOLE_REVIEW_ENTRIES + 1)).toBe(true)
    expect(reviewTooLarge(commits(MAX_WHOLE_REVIEW_ENTRIES + 1), 10)).toBe(true)
  })

  it('is true once the commits, the paths and the distinct text files pass the read budget', () => {
    const half = READ_FILES_RESPONSE_BUDGET / 2
    const blob = entry('file', 'big')
    const twice: PushReviewEntry[] = [
      commit(C1, { size: 0 }),
      path(C1, 'a', { entry: blob, sent: text(half) }),
      path(C1, 'b', { entry: blob, sent: text(half) }),
    ]
    // One file at two paths is held once.
    expect(reviewTooLarge(twice, 3)).toBe(false)
    expect(reviewTooLarge([...twice, path(C1, 'c', { entry: entry('file', 'other'), sent: text(half) })], 4)).toBe(true)
    expect(reviewTooLarge([commit(C1, { size: READ_FILES_RESPONSE_BUDGET + 1 })], 1)).toBe(true)
  })

  it('does not count a large file, which is never read unasked', () => {
    expect(reviewTooLarge([
      commit(C1),
      path(C1, 'huge.bin', { entry: entry('file', 'huge'), sent: { kind: 'large', size: 10 * READ_FILES_RESPONSE_BUDGET } }),
    ], 2)).toBe(false)
  })

  it('loads whole every push a restricted workspace may queue', () => {
    expect(MAX_RESTRICTED_PUSH_COMMITS + MAX_RESTRICTED_PUSH_PATHS).toBeLessThanOrEqual(MAX_WHOLE_REVIEW_ENTRIES)
    expect(MAX_RESTRICTED_PUSH_TEXT_SIZE).toBeLessThanOrEqual(READ_FILES_RESPONSE_BUDGET)

    // The largest review the kernel accepts: as many commits, paths and files as it allows, and
    // as much text, the paths' own bytes included.
    const fileSize = Math.floor(MAX_RESTRICTED_PUSH_TEXT_SIZE / (2 * MAX_RESTRICTED_PUSH_FILES))
    const paths = Array.from({ length: MAX_RESTRICTED_PUSH_PATHS }, (_, index) =>
      path(oid(`b${index % MAX_RESTRICTED_PUSH_COMMITS}x`), `f${index}`, {
        entry: entry('file', `f${index % MAX_RESTRICTED_PUSH_FILES}x`), sent: text(fileSize),
      }))
    const used = MAX_RESTRICTED_PUSH_FILES * fileSize + paths.reduce((sum, row) => sum + row.path.length, 0)
    const atBounds: PushReviewEntry[] = [
      ...Array.from({ length: MAX_RESTRICTED_PUSH_COMMITS }, (_, index) =>
        commit(oid(`b${index}x`), { size: index === 0 ? MAX_RESTRICTED_PUSH_TEXT_SIZE - used : 0 })),
      ...paths,
    ]
    expect(atBounds).toHaveLength(MAX_RESTRICTED_PUSH_COMMITS + MAX_RESTRICTED_PUSH_PATHS)
    expect(reviewTooLarge(atBounds, atBounds.length)).toBe(false)
  })
})

describe('pathChange, comparableParent and expectsText', () => {
  it.each<[string, PathRow, ReturnType<typeof pathChange>]>([
    ['a file with no parent version', added(C1, 'a'), 'added'],
    ['a file in a root commit', path(C1, 'a', { entry: entry('file', 'a'), parents: [], sent: text() }), 'added'],
    ['a file a merge adds to both sides', path(C1, 'a', { entry: entry('file', 'a'), parents: [NONE, NONE] }), 'added'],
    ['a changed file', path(C1, 'a', { entry: entry('file', 'new'), parents: [entry('file', 'old')], sent: text() }), 'modified'],
    ['a deleted file', path(C1, 'a', { parents: [entry('file', 'old')] }), 'deleted'],
    ['a deleted directory', path(C1, 'a', { parents: [entry('dir', 'old')] }), 'deleted'],
    ['a mode change alone', path(C1, 'a', { entry: entry('executable', 'same'), parents: [entry('file', 'same')] }), 'mode'],
    ['a file whose parent is unknown', path(C1, 'a', { entry: entry('file', 'a'), parents: [UNKNOWN], sent: text() }), 'modified'],
    ['a file over a directory', path(C1, 'a', { entry: entry('file', 'a'), parents: [entry('dir', 'old')], sent: text() }), 'modified'],
  ])('%s', (_name, row, change) => {
    expect(pathChange(row)).toBe(change)
  })

  it('compares with the first parent that has a file or a link there', () => {
    expect(comparableParent(added(C1, 'a'))).toBeUndefined()
    expect(comparableParent(path(C1, 'a', { parents: [entry('dir', 'd')] }))).toBeUndefined()
    expect(comparableParent(path(C1, 'a', { parents: [NONE, entry('executable', 'x'), entry('file', 'y')] }))).toBe(1)
    expect(comparableParent(path(C1, 'a', { parents: [entry('symlink', 'l')] }))).toBe(0)
  })

  it('expects text of a sent file listed as text, and of nothing else', () => {
    expect(expectsText(added(C1, 'a'))).toBe(true)
    expect(expectsText(path(C1, 'a', { entry: entry('executable', 'x'), sent: text() }))).toBe(true)
    expect(expectsText(path(C1, 'a', { entry: entry('symlink', 'l'), sent: text() }))).toBe(false)
    expect(expectsText(path(C1, 'a', { entry: entry('file', 'x'), sent: { kind: 'large', size: 5 } }))).toBe(false)
    expect(expectsText(path(C1, 'a', { entry: entry('file', 'x') }))).toBe(false)
    expect(expectsText(opened(C1, 'a'))).toBe(false)
  })
})

describe('pathNotes', () => {
  const SENT = 'Sent by this push.'
  const NOT_SENT = 'Not sent: the remote already has this content.'

  it.each<[string, PathRow, string[]]>([
    ['an added file', added(C1, 'a'), [SENT]],
    ['a modified file', path(C1, 'a', { entry: entry('file', 'new'), parents: [entry('file', 'old')], sent: text() }), [SENT]],
    ['a deleted file', path(C1, 'a', { parents: [entry('file', 'old')] }), []],
    ['a deleted directory', path(C1, 'a', { parents: [entry('dir', 'old')] }),
      ['A directory: everything under it is removed with it, and is not listed here.']],
    ['a mode change alone', path(C1, 'a', { entry: entry('executable', 'same'), parents: [entry('file', 'same')] }),
      [NOT_SENT, 'Mode changed: file to executable.']],
    ['the reverse mode change', path(C1, 'a', { entry: entry('file', 'same'), parents: [entry('executable', 'same')] }),
      [NOT_SENT, 'Mode changed: executable to file.']],
    ['an added executable', path(C1, 'a', { entry: entry('executable', 'a'), sent: text() }),
      [SENT, 'Executable file.']],
    ['a changed executable', path(C1, 'a', { entry: entry('executable', 'new'), parents: [entry('executable', 'old')], sent: text() }),
      [SENT, 'Executable file.']],
    ['a file changed and made executable', path(C1, 'a', { entry: entry('executable', 'new'), parents: [entry('file', 'old')], sent: text() }),
      [SENT, 'Mode changed: file to executable.']],
    ['an executable changed and made a plain file', path(C1, 'a', { entry: entry('file', 'new'), parents: [entry('executable', 'old')], sent: text() }),
      [SENT, 'Mode changed: executable to file.']],
    ['a file where a symbolic link was', path(C1, 'a', { entry: entry('file', 'new'), parents: [entry('symlink', 'l')], sent: text() }),
      [SENT, 'Mode changed: symbolic link to file.']],
    ['a symbolic link where a file was', path(C1, 'a', { entry: entry('symlink', 'l'), parents: [entry('file', 'old')], sent: text() }),
      [SENT, 'Mode changed: file to symbolic link.', 'Symbolic link.']],
    ['a merge whose parents have the path under two other modes',
      path(C1, 'a', {
        entry: entry('executable', 'new'), sent: text(),
        parents: [entry('file', 'one'), entry('executable', 'two'), entry('symlink', 'l'), entry('file', 'three')],
      }),
      [SENT, 'Mode changed: file to executable.', 'Mode changed: symbolic link to executable.']],
    ['an executable over a directory', path(C1, 'a', { entry: entry('executable', 'a'), parents: [entry('dir', 'old')], sent: text() }),
      [SENT, 'Executable file.', 'Replaces a directory.']],
    ['a symbolic link whose target is sent', path(C1, 'a', { entry: entry('symlink', 'l'), sent: text() }),
      [SENT, 'Symbolic link.']],
    ['a symbolic link to content the remote has', path(C1, 'a', { entry: entry('symlink', 'l') }),
      [NOT_SENT, 'Symbolic link.']],
    ['an added submodule entry', path(C1, 'a', { entry: entry('submodule', 's1') }),
      [`Submodule entry: commit ${oid('s1')}.`]],
    ['a changed submodule entry', path(C1, 'a', { entry: entry('submodule', 's2'), parents: [entry('submodule', 's1')] }),
      [`Submodule entry: commit ${oid('s2')}, was ${oid('s1')}.`]],
    ['a directory the remote already has', path(C1, 'a', { entry: entry('dir', 'd') }),
      [NOT_SENT, 'Directory the remote already has.']],
    ['the root, already at the remote', path(C1, '', { entry: entry('dir', 'd'), parents: [entry('dir', 'e')] }),
      [NOT_SENT, 'Directory the remote already has.']],
    ['an empty directory', emptyDir(C1, 'a'), [SENT, 'Empty directory.']],
    ['a directory with nothing changed in it', opened(C1, 'a'),
      [SENT, 'Directory with no changed entry: a parent already has each of its entries.']],
    ['a directory over a file', opened(C1, 'a', [entry('file', 'old')]),
      [SENT, 'Directory with no changed entry: a parent already has each of its entries.', 'Replaces a file.']],
    ['a file over a directory', path(C1, 'a', { entry: entry('file', 'a'), parents: [entry('dir', 'old')], sent: text() }),
      [SENT, 'Replaces a directory.']],
    ['a file that is not text', path(C1, 'a', { entry: entry('file', 'a'), sent: { kind: 'binary', size: 2048 } }),
      [SENT, 'Not text: 2.0 KB (2048 bytes). Its content cannot be shown.']],
    ['a file too large to have been checked', path(C1, 'a', { entry: entry('file', 'a'), sent: { kind: 'large', size: 2097152 } }),
      [SENT, '2.0 MB (2097152 bytes): over the size checked as text, so it is not read until you ask.']],
    ['a file the workspace does not hold', path(C1, 'a', { entry: entry('file', 'a'), sent: { kind: 'absent' } }),
      [SENT, 'Not in this workspace yet, so it cannot be shown.']],
    ['a directory the workspace does not hold', path(C1, 'a', { entry: entry('dir', 'a'), sent: { kind: 'absent' } }),
      [SENT, 'Not in this workspace yet, so it cannot be shown.']],
    ['a directory git would not write', path(C1, 'a', { entry: entry('dir', 'a'), sent: { kind: 'unlistable', size: 70 } }),
      [SENT, 'A directory that is not in the form git writes (a name that is not valid UTF-8, is repeated, is out of ' +
        'order or is not a single path segment): 70 bytes. Its entries cannot be listed; what the push sends ' +
        "under it is under 'Sent without a path'."]],
    ['a file entry over a tree', path(C1, 'a', { entry: entry('file', 'a'), sent: { kind: 'mistyped', type: 'tree', size: 30 } }),
      [SENT, 'This entry says file, but the object is a tree: 30 bytes. It cannot be shown here.']],
    ['a directory entry over a blob', path(C1, 'a', { entry: entry('dir', 'a'), sent: { kind: 'mistyped', type: 'blob', size: 1 } }),
      [SENT, 'This entry says directory, but the object is a blob: 1 byte. It cannot be shown here.']],
    ['a directory entry over a commit', path(C1, 'a', { entry: entry('dir', 'a'), sent: { kind: 'mistyped', type: 'commit', size: 9 } }),
      [SENT, 'This entry says directory, but the object is a commit: 9 bytes. It cannot be shown here.']],
  ])('%s', (_name, row, notes) => {
    expect(pathNotes(row)).toEqual(notes)
  })

  it('names the parent that is not in the workspace', () => {
    const row = path(C1, 'a', { entry: entry('file', 'a'), parents: [entry('file', 'old'), UNKNOWN], sent: text() })
    expect(pathNotes(row, { parents: [oid('aaaa'), oid('bbbbccccdddd')] })).toEqual([
      'Sent by this push.',
      'Parent bbbbccccdddd is not in this workspace, so there is nothing to compare with.',
    ])
    expect(pathNotes(row).at(-1)).toBe('Parent 2 is not in this workspace, so there is nothing to compare with.')
  })

  it('says what a directory that stays listed holds', () => {
    const replaced = opened(C1, 'a', [entry('file', 'old')])
    expect(pathNotes(replaced, { beneath: 'listed' })[1]).toBe('Directory: what it changes is listed beneath it.')
    expect(pathNotes(replaced, { beneath: 'loading' })[1]).toBe('Directory: what it changes is still loading.')
  })
})

describe('notShownAsText', () => {
  it('counts what the push sends that is not shown as text', () => {
    expect(notShownAsText([
      commit(C1),
      commit(C2, { text: undefined }),
      commit(oid('c3'), { text: undefined, size: undefined }),
      opened(C1, ''),
      added(C1, 'a.txt'),
      path(C1, 'link', { entry: entry('symlink', 'l'), sent: text() }),
      path(C1, 'already', { entry: entry('file', 'x') }),
      path(C1, 'gone', { parents: [entry('file', 'y')] }),
      path(C1, 'bin', { entry: entry('file', 'b'), sent: { kind: 'binary', size: 1 } }),
      path(C1, 'big', { entry: entry('file', 'g'), sent: { kind: 'large', size: 1 } }),
      path(C1, 'missing', { entry: entry('file', 'm'), sent: { kind: 'absent' } }),
      path(C1, 'odd', { entry: entry('dir', 'o'), sent: { kind: 'unlistable', size: 1 } }),
      path(C1, 'wrong', { entry: entry('file', 'w'), sent: { kind: 'mistyped', type: 'tree', size: 1 } }),
      { kind: 'object', oid: oid('f'), type: 'blob' },
    ])).toBe(8)
  })
})

describe('reviewReadiness', () => {
  const WHOLE: ReviewProgress = { entries: 12, done: true, loading: false, failed: false }
  const READ: FilesProgress = { total: 3, loaded: 3, pending: 0, failed: 0, mismatched: 0, eager: true }
  // Every later reason is true as well, so each case shows that the one before it wins.
  const EVERYTHING_WRONG: FilesProgress = { total: 3, loaded: 0, pending: 1, failed: 1, mismatched: 1, eager: true }

  it('waits for a loading page before anything else', () => {
    expect(reviewReadiness({ ...WHOLE, done: false, loading: true, failed: true }, EVERYTHING_WRONG))
      .toEqual({ ready: false, reason: 'Loading the review.' })
  })

  it('reports a failed page, to be retried', () => {
    expect(reviewReadiness({ ...WHOLE, done: false, failed: true }, EVERYTHING_WRONG))
      .toEqual({ ready: false, reason: 'The review could not be loaded.', retry: 'review' })
  })

  it('asks for the pages that are still to be loaded before looking at any file', () => {
    expect(reviewReadiness({ ...WHOLE, entries: 601, done: false }, EVERYTHING_WRONG)).toEqual({
      ready: false,
      reason: 'This push is too large to load by itself: 601 entries loaded so far. Load the rest of it to approve it.',
      load: 'review',
    })
  })

  it('reports a file that did not come back as listed before one that failed', () => {
    expect(reviewReadiness(WHOLE, EVERYTHING_WRONG)).toEqual({
      ready: false,
      reason: '1 file did not come back as the review lists it, so this push cannot be approved here.',
    })
    expect(reviewReadiness(WHOLE, { ...READ, mismatched: 2 })).toEqual({
      ready: false,
      reason: '2 files did not come back as the review lists them, so this push cannot be approved here.',
    })
  })

  it('reports files that could not be read, to be retried', () => {
    expect(reviewReadiness(WHOLE, { ...EVERYTHING_WRONG, mismatched: 0 }))
      .toEqual({ ready: false, reason: '1 file could not be read.', retry: 'files' })
  })

  it('counts the files while they load', () => {
    expect(reviewReadiness(WHOLE, { ...READ, loaded: 1, pending: 2 }))
      .toEqual({ ready: false, reason: 'Loading files: 1 of 3.' })
    // Read by the dialog itself, and not started yet.
    expect(reviewReadiness(WHOLE, { ...READ, loaded: 0 }))
      .toEqual({ ready: false, reason: 'Loading files: 0 of 3.' })
    // Asked for by hand, and in flight.
    expect(reviewReadiness(WHOLE, { ...READ, loaded: 1, pending: 2, eager: false }))
      .toEqual({ ready: false, reason: 'Loading files: 1 of 3.' })
  })

  it('waits for a read in flight when every file listed as text is in', () => {
    // A symbolic link, or a file too large to have been checked that the approver asked to see.
    expect(reviewReadiness(WHOLE, { ...READ, pending: 1 })).toEqual({ ready: false, reason: 'Loading 1 file.' })
    expect(reviewReadiness(WHOLE, { ...READ, total: 0, loaded: 0, pending: 2, eager: false }))
      .toEqual({ ready: false, reason: 'Loading 2 files.' })
  })

  it('reports a failed read when every file listed as text is in', () => {
    expect(reviewReadiness(WHOLE, { ...READ, total: 0, loaded: 0, failed: 1 }))
      .toEqual({ ready: false, reason: '1 file could not be read.', retry: 'files' })
  })

  it('asks for the files a review too large to read by itself still lacks', () => {
    expect(reviewReadiness(WHOLE, { ...READ, loaded: 1, eager: false })).toEqual({
      ready: false,
      reason: '1 of 3 files loaded. Load the rest to approve this push.',
      load: 'files',
    })
  })

  it('is ready once every page is in and every file is read, however large the review', () => {
    expect(reviewReadiness(WHOLE, READ)).toEqual({ ready: true })
    expect(reviewReadiness({ ...WHOLE, entries: 5000 }, { ...READ, total: 900, loaded: 900, eager: false }))
      .toEqual({ ready: true })
    // A push that sends no file at all.
    expect(reviewReadiness({ ...WHOLE, entries: 0 }, { ...READ, total: 0, loaded: 0 })).toEqual({ ready: true })
  })
})
