import { describe, expect, it } from 'vitest'
import { buildCodeTree, foldersOf, matchPath, matchPaths } from './codeTree'

const files = (...paths: string[]) => paths.map((path) => ({ path }))
const names = (nodes: ReturnType<typeof buildCodeTree>): unknown[] =>
  nodes.map((node) => (node.kind === 'folder' ? { [node.name]: names(node.children) } : node.name))

describe('buildCodeTree', () => {
  it('keeps the root’s files in the order given, then its folders, and within a folder its folders first, each by name', () => {
    const tree = buildCodeTree(files('client.ts', 'server.ts', 'README.md', 'lib/zeta.ts', 'lib/alpha.ts', 'lib/deep/x.ts', 'assets/logo.svg'))
    expect(names(tree)).toEqual([
      'client.ts', 'server.ts', 'README.md',
      { assets: ['logo.svg'] },
      { lib: [{ deep: ['x.ts'] }, 'alpha.ts', 'zeta.ts'] },
    ])
  })

  it('names each folder by its whole path', () => {
    const [folder] = buildCodeTree(files('a/b/c.ts'))
    expect(folder).toMatchObject({ kind: 'folder', path: 'a', children: [{ kind: 'folder', path: 'a/b' }] })
  })

  it('orders numbered names as people count', () => {
    expect(names(buildCodeTree(files('s/step10.ts', 's/step2.ts')))).toEqual([{ s: ['step2.ts', 'step10.ts'] }])
  })
})

describe('foldersOf', () => {
  it('lists the folders a path is in, outermost first', () => {
    expect(foldersOf('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(foldersOf('c.ts')).toEqual([])
  })
})

describe('matchPath', () => {
  it('finds the characters typed in order, anywhere, and nothing otherwise', () => {
    expect(matchPath('srv', 'server.ts')).toBeDefined()
    expect(matchPath('xyz', 'server.ts')).toBeUndefined()
    expect(matchPath('', 'server.ts')).toEqual({ score: 0, indices: [] })
  })

  it('marks where each fits, starting words where it can', () => {
    expect(matchPath('ps', 'lib/protocol-server.ts')?.indices).toEqual([4, 13])
    expect(matchPath('cli', 'client.ts')?.indices).toEqual([0, 1, 2])
  })

  it('takes case and spaces as they come', () => {
    expect(matchPath('Clie NT', 'client.ts')?.indices).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('matchPaths', () => {
  it('puts a file whose own name fits before one where only its folders do', () => {
    const found = matchPaths('srv', files('lib/services/view.ts', 'server.ts'))
    expect(found.map(({ file }) => file.path)).toEqual(['server.ts', 'lib/services/view.ts'])
  })

  it('puts a run of what was typed before the same letters scattered', () => {
    const found = matchPaths('chart', files('lib/c-h-a-r-t.ts', 'chart.ts'))
    expect(found[0]?.file.path).toBe('chart.ts')
  })

  it('keeps to as many as asked', () => {
    expect(matchPaths('a', files('a1', 'a2', 'a3'), 2)).toHaveLength(2)
  })
})
