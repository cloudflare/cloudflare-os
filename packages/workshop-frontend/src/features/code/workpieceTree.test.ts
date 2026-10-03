import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@gadgets/workshop-shared/api'
import {
  ancestorDirs, browserTreePaths, buildBrowserTree, deriveChanges, fileChangeStatus,
  resolveRenamePath, type BrowserNode,
} from './workpieceTree'

const BASE: TreeNode[] = [
  { name: 'README.md', kind: 'file' },
  { name: 'bin', kind: 'dir', children: [{ name: 'run', kind: 'executable' }] },
  { name: 'src', kind: 'dir', children: [
    { name: 'a.ts', kind: 'file' },
    { name: 'lib', kind: 'dir', children: [{ name: 'util.ts', kind: 'file' }] },
    { name: 'link', kind: 'symlink' },
  ] },
  { name: 'vendor', kind: 'submodule' },
]

// A compact rendering of the tree for assertions: directories end in '/', children indented.
function render(nodes: readonly BrowserNode[], depth = 0): string[] {
  const out: string[] = []
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    if (node.kind === 'dir') {
      out.push(`${indent}${node.name}/`)
      out.push(...render(node.children, depth + 1))
    } else {
      out.push(`${indent}${node.name}${node.kind === 'file' ? '' : ` (${node.kind})`}`)
    }
  }
  return out
}

describe('buildBrowserTree', () => {
  it('lists the base with directories first, then leaves, each by name', () => {
    const tree = buildBrowserTree(BASE, [], new Set())
    expect(render(tree.roots)).toEqual([
      'bin/',
      '  run (executable)',
      'src/',
      '  lib/',
      '    util.ts',
      '  a.ts',
      '  link (symlink)',
      'README.md',
      'vendor (submodule)',
    ])
    expect(tree.leaves.get('bin/run')).toBe('executable')
    expect(tree.leaves.get('src/link')).toBe('symlink')
    expect(tree.leaves.get('vendor')).toBe('submodule')
    expect(tree.leaves.get('README.md')).toBe('file')
  })

  it('removes tombstoned leaves and drops directories left empty', () => {
    const tree = buildBrowserTree(BASE, [], new Set(['src/lib/util.ts', 'bin/run']))
    expect(render(tree.roots)).toEqual([
      'src/',
      '  a.ts',
      '  link (symlink)',
      'README.md',
      'vendor (submodule)',
    ])
    expect(tree.leaves.has('src/lib/util.ts')).toBe(false)
  })

  it('inserts overlay paths the base lacks, with virtual ancestors', () => {
    const tree = buildBrowserTree(BASE, ['docs/guide/intro.md', 'src/b.ts', 'zzz'], new Set())
    expect(render(tree.roots)).toEqual([
      'bin/',
      '  run (executable)',
      'docs/',
      '  guide/',
      '    intro.md',
      'src/',
      '  lib/',
      '    util.ts',
      '  a.ts',
      '  b.ts',
      '  link (symlink)',
      'README.md',
      'vendor (submodule)',
      'zzz',
    ])
    expect(tree.leaves.get('docs/guide/intro.md')).toBe('file')
  })

  it('keeps the base kind of a present path that names an existing leaf', () => {
    const tree = buildBrowserTree(BASE, ['bin/run'], new Set())
    expect(tree.leaves.get('bin/run')).toBe('executable')
  })

  it('a present path wins over a removal of the same path', () => {
    // The caller keeps these disjoint, but a set beats a tombstone if they ever overlap.
    const tree = buildBrowserTree(BASE, ['README.md'], new Set(['README.md']))
    expect(tree.leaves.has('README.md')).toBe(true)
  })

  it('is the overlay alone with no base', () => {
    const tree = buildBrowserTree(null, ['client.js', 'server.js'], new Set())
    expect(render(tree.roots)).toEqual(['client.js', 'server.js'])
  })

  it('ignores removals of paths the base lacks', () => {
    const tree = buildBrowserTree(BASE, [], new Set(['nope', 'src/nope/x']))
    expect(browserTreePaths(tree.roots)).toEqual(browserTreePaths(buildBrowserTree(BASE, [], new Set()).roots))
  })
})

describe('browserTreePaths', () => {
  it('flattens leaves in display order', () => {
    const tree = buildBrowserTree(BASE, [], new Set())
    expect(browserTreePaths(tree.roots)).toEqual([
      'bin/run', 'src/lib/util.ts', 'src/a.ts', 'src/link', 'README.md', 'vendor',
    ])
  })
})

describe('ancestorDirs', () => {
  it('names each directory above the path', () => {
    expect(ancestorDirs('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('top.ts')).toEqual([])
  })
})

describe('resolveRenamePath', () => {
  it('resolves the typed name against the file\'s own directory', () => {
    expect(resolveRenamePath('src/a.ts', 'b.ts')).toBe('src/b.ts')
    expect(resolveRenamePath('src/a.ts', 'sub/b.ts')).toBe('src/sub/b.ts')
    expect(resolveRenamePath('top.ts', 'b.ts')).toBe('b.ts')
  })

  it('moves up with `..` and anywhere with a leading slash', () => {
    expect(resolveRenamePath('src/a.ts', '../a.ts')).toBe('a.ts')
    expect(resolveRenamePath('src/deep/a.ts', '../other/./a.ts')).toBe('src/other/a.ts')
    expect(resolveRenamePath('src/deep/a.ts', '/lib/a.ts')).toBe('lib/a.ts')
  })

  it('rejects a destination above the root or with an empty segment', () => {
    expect(resolveRenamePath('src/a.ts', '../../a.ts')).toBeNull()
    expect(resolveRenamePath('top.ts', '..')).toBeNull()
    expect(resolveRenamePath('src/a.ts', 'sub//a.ts')).toBeNull()
    expect(resolveRenamePath('src/a.ts', 'dir/')).toBeNull()
  })
})

describe('fileChangeStatus', () => {
  it('is unknown while the review base read is in flight', () => {
    expect(fileChangeStatus('x', undefined, true)).toBeUndefined()
  })

  it('treats every displayed file as added when there is no review base', () => {
    expect(fileChangeStatus('x', undefined, false)).toBe('added')
    expect(fileChangeStatus(null, undefined, false)).toBe('unchanged')
  })

  it('compares against the review base', () => {
    expect(fileChangeStatus('x', { kind: 'absent' }, true)).toBe('added')
    expect(fileChangeStatus(null, { kind: 'absent' }, true)).toBe('unchanged')
    expect(fileChangeStatus(null, { kind: 'text', text: 'x' }, true)).toBe('deleted')
    expect(fileChangeStatus('y', { kind: 'text', text: 'x' }, true)).toBe('modified')
    expect(fileChangeStatus('x', { kind: 'text', text: 'x' }, true)).toBe('unchanged')
    expect(fileChangeStatus('x', { kind: 'unreadable', message: 'binary' }, true)).toBe('modified')
  })
})

describe('deriveChanges', () => {
  const display = new Map<string, string | null>([
    ['kept.ts', 'same'], ['edited.ts', 'new'], ['new.ts', 'x'], ['gone.ts', null], ['never.ts', null],
  ])
  const displayed = (path: string) => display.get(path)

  it('lists every status but unchanged, in path order', () => {
    const originals = new Map([
      ['kept.ts', { kind: 'text', text: 'same' }], ['edited.ts', { kind: 'text', text: 'old' }],
      ['new.ts', { kind: 'absent' }], ['gone.ts', { kind: 'text', text: 'was' }],
      ['never.ts', { kind: 'absent' }],
    ] as const)
    const { statuses, changes } = deriveChanges([...display.keys()], displayed, originals, true)
    expect(changes).toEqual([
      { path: 'edited.ts', status: 'modified' },
      { path: 'new.ts', status: 'added' },
      { path: 'gone.ts', status: 'deleted' },
    ])
    expect(statuses.get('kept.ts')).toBe('unchanged')
    expect(statuses.get('never.ts')).toBe('unchanged')
  })

  it('keeps an unresolved removal listed as pending, and nothing else unresolved', () => {
    // Nothing has loaded from the review base yet: a removed path is listed nowhere else, so
    // it must stay selectable here; present paths are in the tree and can wait for a status.
    const { statuses, changes } = deriveChanges([...display.keys()], displayed, new Map(), true)
    expect(changes).toEqual([
      { path: 'gone.ts', status: 'pending' },
      { path: 'never.ts', status: 'pending' },
    ])
    expect(statuses.size).toBe(0)
  })

  it('needs no review base for a pending gadget', () => {
    const { changes } = deriveChanges([...display.keys()], displayed, new Map(), false)
    expect(changes).toEqual([
      { path: 'kept.ts', status: 'added' },
      { path: 'edited.ts', status: 'added' },
      { path: 'new.ts', status: 'added' },
    ])
  })
})
