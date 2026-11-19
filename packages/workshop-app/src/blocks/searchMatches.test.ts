import { describe, expect, it } from 'vitest'
import { carriedInto, searchMatches } from './searchMatches'

const entries = [
  { title: 'Garden planning' },
  { title: 'Weekly plan' },
  { title: 'Explaining things' },
  { title: 'Plants to water' },
  { title: 'Library', keywords: ['gadgets', 'files'] },
]
const titles = (query: string) => searchMatches(query, entries).map(({ title }) => title)

describe('searchMatches', () => {
  it('finds everything, as it came, for nothing typed', () => {
    expect(titles('  ')).toEqual(entries.map(({ title }) => title))
  })

  it('puts a title that starts with it first, then a word that does, then anywhere', () => {
    expect(titles('pla')).toEqual(['Plants to water', 'Garden planning', 'Weekly plan', 'Explaining things'])
  })

  it('finds a single letter only where a word starts with it', () => {
    expect(titles('w')).toEqual(['Weekly plan', 'Plants to water'])
  })

  it('needs every word typed, in any order', () => {
    expect(titles('planning garden')).toEqual(['Garden planning'])
    expect(titles('garden weekly')).toEqual([])
  })

  it('finds by keyword, below any title that has it', () => {
    expect(titles('files')).toEqual(['Library'])
  })

  it('ignores case and punctuation', () => {
    expect(titles('GARDEN, plan!')).toEqual(['Garden planning'])
  })

  it('keeps the order equals came in', () => {
    const same = [{ title: 'Notes b' }, { title: 'Notes a' }]
    expect(searchMatches('notes', same)).toEqual(same)
  })
})

describe('carriedInto', () => {
  const options = [{ title: 'Light' }, { title: 'Dark' }, { title: 'System' }]

  it('keeps what still finds some of the entries, so that it goes on narrowing them', () => {
    expect(carriedInto('dark', options)).toBe('dark')
  })

  it('drops what only led there and finds none of them', () => {
    expect(carriedInto('theme', options)).toBe('')
    // Every word has to be found, as in search itself.
    expect(carriedInto('dark theme', options)).toBe('')
  })

  it('carries nothing when nothing was typed', () => {
    expect(carriedInto('  ', options)).toBe('')
  })
})
