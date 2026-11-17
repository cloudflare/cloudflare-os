import { describe, expect, it } from 'vitest'
import { fileKind, fileSize, formatFileSize, readUploadFiles } from './skillFiles'

const chosen = (path: string, text: string, type = '') =>
  ({ name: path.split('/').at(-1), webkitRelativePath: path.includes('/') ? path : '', type, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as File

describe('readUploadFiles', () => {
  it('keeps a file at its path in the folder it was chosen with, and leaves out hidden files and folders', async () => {
    const files = await readUploadFiles([
      chosen('templates/report.md', '# Report'),
      chosen('templates/data/rows.csv', 'a,b'),
      chosen('templates/.DS_Store', 'x'),
      chosen('templates/.git/config', 'x'),
      chosen('notes.txt', 'Notes'),
    ])
    expect(files.map(({ path, contentType }) => [path, contentType])).toEqual([
      ['templates/report.md', 'text/markdown'],
      ['templates/data/rows.csv', 'text/csv'],
      ['notes.txt', 'text/plain'],
    ])
  })
})

describe('what is said of a file', () => {
  it('says what it is and how big', () => {
    const file = { path: 'notes.txt', contentType: 'text/plain', body: 'Notes' }
    expect(fileKind(file)).toBe('TXT text')
    expect(fileSize(file)).toBe(5)
    expect(formatFileSize(1536)).toBe('1.5 KB')
  })
})
