import { describe, expect, it } from 'vitest'
import { matchesSearch, narrowList, passesFilters, type ListFilter } from './listView'

type Item = { name: string; mine: boolean; starred: boolean }

const mine: ListFilter<Item> = { id: 'mine', label: 'Mine', facet: 'owner', test: (item) => item.mine }
const shared: ListFilter<Item> = { id: 'shared', label: 'Shared with me', facet: 'owner', test: (item) => !item.mine }
const starred: ListFilter<Item> = { id: 'starred', label: 'Starred', test: (item) => item.starred }

const ITEMS: Item[] = [
  { name: 'Jira dashboard', mine: true, starred: true },
  { name: 'Paris slides', mine: false, starred: true },
  { name: 'Résumé', mine: true, starred: false },
]
const names = (items: Item[]) => items.map(({ name }) => name)

describe('matchesSearch', () => {
  it('finds every word, in any order, whatever the case or accents', () => {
    expect(matchesSearch('Jira dashboard', 'dash JIRA')).toBe(true)
    expect(matchesSearch('Résumé', 'resume')).toBe(true)
    expect(matchesSearch('Jira dashboard', 'jira slides')).toBe(false)
  })

  it('matches everything with nothing typed', () => {
    expect(matchesSearch('Jira dashboard', '')).toBe(true)
    expect(matchesSearch('Jira dashboard', '  ')).toBe(true)
  })
})

describe('passesFilters', () => {
  it('takes filters of one facet as alternatives', () => {
    expect(names(ITEMS.filter((item) => passesFilters(item, [mine])))).toEqual(['Jira dashboard', 'Résumé'])
    expect(names(ITEMS.filter((item) => passesFilters(item, [mine, shared])))).toEqual(names(ITEMS))
  })

  it('asks for every facet, and each filter that stands alone', () => {
    expect(names(ITEMS.filter((item) => passesFilters(item, [mine, starred])))).toEqual(['Jira dashboard'])
    expect(names(ITEMS.filter((item) => passesFilters(item, [])))).toEqual(names(ITEMS))
  })
})

describe('narrowList', () => {
  it('leaves what both the search and the filters let through, in order', () => {
    expect(names(narrowList(ITEMS, { query: 's', searchText: ({ name }) => name, filters: [starred] }))).toEqual(['Jira dashboard', 'Paris slides'])
    expect(names(narrowList(ITEMS, { query: 'paris', searchText: ({ name }) => name, filters: [mine] }))).toEqual([])
  })
})
