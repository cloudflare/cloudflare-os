import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@gadgets/workshop-shared/api'
import { codeLanguage } from '@/files/codeLanguage'
import { highlightLines } from '@/components/highlightCode'
import { codeFiles, shownFile } from './gadgetCode'

const file = (name: string): TreeNode => ({ name, kind: 'file' })

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

describe('highlightLines', () => {
  it('keeps every character, line by line, and marks what each run is', () => {
    const text = 'const n = 1 // one\nconst s = "two"\n\n'
    const lines = highlightLines(text, 'javascript')
    expect(lines.map((line) => line.map(({ text: run }) => run).join('')).join('\n')).toBe(text)
    expect(lines[0]).toContainEqual({ text: 'const', kind: 'keyword' })
    expect(lines[0]).toContainEqual({ text: '1', kind: 'number' })
    expect(lines[0]).toContainEqual({ text: '// one', kind: 'comment' })
    expect(lines[1]).toContainEqual({ text: '"two"', kind: 'string' })
  })
})
