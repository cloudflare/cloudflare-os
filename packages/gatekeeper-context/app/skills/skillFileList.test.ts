import { describe, expect, it } from 'vitest'
import { narrowList } from '@gadgets/ui'
import { skillFileList } from './skillFileList'
import type { SkillFile } from './skillFiles'

const FILES: SkillFile[] = [
  { path: 'templates/report.md', contentType: 'text/markdown', body: 'A longer template than the rest' },
  { path: 'SKILL.md', contentType: 'text/markdown', body: 'Short' },
  { path: 'logo.png', contentType: 'image/png', body: 'AAAA' },
  { path: 'examples/notes.txt', contentType: 'text/plain', body: 'Some notes' },
]
const paths = (id: string) => skillFileList.orders.find((order) => order.id === id)!.arrange(FILES, 2).flatMap(({ entries }) => entries.map(({ value }) => value.path))

const found = (query: string) => narrowList(FILES, { query, searchText: skillFileList.searchText, filters: [] }).map(({ path }) => path)

describe('skillFileList', () => {
  it('puts SKILL.md first by name and by type, and the biggest first by size, all in one group', () => {
    expect(paths('name')).toEqual(['SKILL.md', 'examples/notes.txt', 'logo.png', 'templates/report.md'])
    expect(paths('type')).toEqual(['SKILL.md', 'logo.png', 'templates/report.md', 'examples/notes.txt'])
    expect(paths('size')).toEqual(['templates/report.md', 'examples/notes.txt', 'SKILL.md', 'logo.png'])
    expect(skillFileList.orders[0].arrange(FILES, 2)).toHaveLength(1)
  })

  it('finds a file by its path or by what it is', () => {
    expect(found('templates')).toEqual(['templates/report.md'])
    expect(found('image')).toEqual(['logo.png'])
  })
})
