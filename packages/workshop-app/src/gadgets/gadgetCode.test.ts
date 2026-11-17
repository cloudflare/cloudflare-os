import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@gadgets/workshop-shared/api'
import { codeLanguage } from '@/files/codeLanguage'
import { changedFiles, codeFiles, commitsSince, shownFile } from './gadgetCode'

const file = (name: string): TreeNode => ({ name, kind: 'file' })
const commit = (oid: string) => ({ oid, parents: [], message: oid, author: { name: 'A', email: 'a@x' }, timestamp: new Date(0) })

describe('codeFiles', () => {
  it('lists the screen and server side first, then the README, the rest of the root, and folders', () => {
    const tree: TreeNode[] = [
      file('README.md'),
      file('blueprint.json'),
      { name: 'lib', kind: 'dir', children: [file('protocol.ts'), { name: 'deep', kind: 'dir', children: [file('a.ts')] }] },
      file('server.ts'),
      file('client.ts'),
      { name: 'link', kind: 'symlink' },
    ]
    expect(codeFiles(tree)).toEqual([
      { path: 'client.ts', kind: 'file', role: 'What it shows' },
      { path: 'server.ts', kind: 'file', role: 'What it keeps and does' },
      { path: 'README.md', kind: 'file', role: 'What it is' },
      { path: 'blueprint.json', kind: 'file' },
      { path: 'link', kind: 'symlink' },
      { path: 'lib/deep/a.ts', kind: 'file' },
      { path: 'lib/protocol.ts', kind: 'file' },
    ])
  })

  it('gives a role only to the files at the root', () => {
    expect(codeFiles([{ name: 'lib', kind: 'dir', children: [file('client.ts')] }])).toEqual([{ path: 'lib/client.ts', kind: 'file' }])
  })
})

describe('shownFile', () => {
  const files = codeFiles([file('client.js'), file('server.js')])
  it('shows the file asked for, else the first', () => {
    expect(shownFile(files, 'server.js')?.path).toBe('server.js')
    expect(shownFile(files, 'gone.js')?.path).toBe('client.js')
    expect(shownFile([], undefined)).toBeUndefined()
  })
})

describe('codeLanguage', () => {
  it('knows a language by the extension, whatever its case, and nothing else', () => {
    expect(codeLanguage('lib/protocol.TS')).toBe('typescript')
    expect(codeLanguage('client.jsx')).toBe('jsx')
    expect(codeLanguage('README.md')).toBe('markdown')
    expect(codeLanguage('Makefile')).toBeUndefined()
    expect(codeLanguage('.env')).toBeUndefined()
  })
})

describe('changedFiles', () => {
  it('lists what changed in the later commit’s order, marked added or changed, then what was taken away', () => {
    const before = codeFiles([file('server.ts'), file('client.ts'), file('old.ts'), file('same.ts')])
    const after = codeFiles([file('client.ts'), file('server.ts'), file('new.ts'), file('same.ts')])
    expect(changedFiles(after, before, ['new.ts', 'old.ts', 'server.ts'])).toEqual([
      { path: 'server.ts', kind: 'file', role: 'What it keeps and does', change: 'modified' },
      { path: 'new.ts', kind: 'file', change: 'added' },
      { path: 'old.ts', kind: 'file', change: 'removed' },
    ])
  })

  it('lists nothing where nothing changed', () => {
    const files = codeFiles([file('a.ts')])
    expect(changedFiles(files, files, [])).toEqual([])
  })
})

describe('commitsSince', () => {
  it('keeps the commits made after the base, leaving the base out', () => {
    expect(commitsSince([commit('c'), commit('b'), commit('a')], 'a').map(({ oid }) => oid)).toEqual(['c', 'b'])
    expect(commitsSince([commit('a')], 'a')).toEqual([])
  })
})
