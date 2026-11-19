import { describe, expect, it } from 'vitest'
import type { FileChange } from '@gadgets/workshop-shared/code-change'
import { chatCodeCommits, chatFileContent, chatFileList, chatFileOffers, needsBase, presentPaths } from './chatCodeFiles'
import { codeFileAt } from './gadgetCode'

const files = (...paths: string[]) => paths.map((path) => codeFileAt(path))
const changes = (entries: [string, FileChange][]) => new Map(entries)

describe('chatCodeCommits', () => {
  it('reads over the chat’s pin, compared with what it last brought in', () => {
    expect(chatCodeCommits({ base: 'pin', review: 'merged', files: new Map() }, 'head')).toEqual({ base: 'pin', review: 'merged' })
  })

  it('reads the head where the chat has not touched it', () => {
    expect(chatCodeCommits(undefined, 'head')).toEqual({ base: 'head', review: 'head' })
  })

  it('reads what the chat’s last keep made until the head says so, and the head once it has moved on', () => {
    const kept = { files: new Map(), kept: { commit: 'kept', over: 'old' } }
    expect(chatCodeCommits(kept, 'old')).toEqual({ base: 'kept', review: 'kept' })
    expect(chatCodeCommits(kept, 'later')).toEqual({ base: 'later', review: 'later' })
  })

  it('reads nothing for a gadget the chat made', () => {
    expect(chatCodeCommits({ files: new Map([['client.js', { set: '' }]]) }, undefined)).toEqual({ base: undefined, review: undefined })
  })
})

describe('chatFileContent', () => {
  it('applies what the chat does to the file', () => {
    expect(chatFileContent('let a = 1\n', { edit: [8, [1, '2'], 1] })).toBe('let a = 2\n')
    expect(chatFileContent(undefined, { set: 'new' })).toBe('new')
    expect(chatFileContent('gone', { remove: true })).toBeUndefined()
    expect(chatFileContent('same', undefined)).toBe('same')
  })

  it('needs what the file was only for an edit, or none', () => {
    expect(needsBase({ edit: [3] })).toBe(true)
    expect(needsBase(undefined)).toBe(true)
    expect(needsBase({ set: 'x' })).toBe(false)
    expect(needsBase({ remove: true })).toBe(false)
  })
})

describe('chatFileList', () => {
  const base = files('client.js', 'server.ts', 'README.md')

  it('marks what the chat changed, made and took away, in the order the Code tab lists them', () => {
    const present = presentPaths(changes([['client.js', { edit: [1] }], ['lib/new.ts', { set: '' }], ['README.md', { remove: true }]]))
    expect(chatFileList({ base, review: base, moved: [], present })).toEqual([
      { path: 'client.js', kind: 'file', change: 'modified' },
      { path: 'server.ts', kind: 'file' },
      { path: 'lib/new.ts', kind: 'file', change: 'added' },
      { path: 'README.md', kind: 'file', change: 'removed' },
    ])
  })

  it('lists nothing for a file it made and took away again', () => {
    const present = presentPaths(changes([['scratch.js', { remove: true }]]))
    expect(chatFileList({ base, review: base, moved: [], present }).map(({ path }) => path)).toEqual(['client.js', 'server.ts', 'README.md'])
  })

  it('marks what differs from what it is compared with, where the chat brought in what was kept elsewhere', () => {
    const review = files('client.js', 'server.ts', 'README.md', 'old.js')
    const listed = chatFileList({ base: files('client.js', 'server.ts', 'README.md', 'styles.css'), review, moved: ['styles.css', 'old.js', 'server.ts'], present: new Map() })
    expect(listed.filter(({ change }) => change)).toEqual([
      { path: 'server.ts', kind: 'file', change: 'modified' },
      { path: 'styles.css', kind: 'file', change: 'added' },
      { path: 'old.js', kind: 'file', change: 'removed' },
    ])
  })
})

describe('chatFileOffers', () => {
  it('puts back what the chat changed, and only puts back what it took away', () => {
    const listed = [{ ...codeFileAt('client.js'), change: 'modified' as const }, codeFileAt('server.ts'), { ...codeFileAt('README.md'), change: 'removed' as const }]
    expect(chatFileOffers(listed[0]!, listed, 'Tip jar', true)).toMatchObject({ rename: true, restore: true, caution: 'Tip jar stops working without this file.' })
    expect(chatFileOffers(listed[1]!, listed, 'Tip jar', true)).toMatchObject({ restore: false })
    expect(chatFileOffers(listed[2]!, listed, 'Tip jar', true)).toEqual({ rename: false, duplicate: false, delete: 'It’s deleted in this chat.', restore: true })
  })
})
