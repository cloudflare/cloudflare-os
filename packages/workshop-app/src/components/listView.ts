import type { ReactNode } from 'react'

/** How a list is drawn: a row each, or a card each. */
export type ListViewMode = 'list' | 'cards'

/**
 * How few make a group of their own in each view, which an order folds smaller ones up to. Two rows
 * are a group; cards run on along a line, and a group of fewer than fill most of one leaves the
 * page full of holes.
 */
export const ENOUGH: Record<ListViewMode, number> = { list: 2, cards: 4 }

/** What an order makes of a list: its items in groups, each group and each item in order. */
export type ArrangedGroup<T> = {
  /** Which group it is, from one render to the next. */
  key: string
  /** What its items have in common: "Today", "A – C", "Documents". */
  label: string
  /** Each with when it was, where the order is one by time and so has it to say. */
  entries: Array<{ value: T; time?: string }>
}

/**
 * A way to put a list in order, which is also how it is grouped: by when (stretches of time), by
 * name (letters), by kind, or by anything else `arrange` makes of the items.
 */
export type ListOrder<T> = {
  id: string
  /** What it orders by, as the menu puts it: "Last active", "Name". */
  label: string
  /** `enough` is how few make a group of their own: one with fewer is folded into its neighbour. */
  arrange: (items: T[], enough: number) => ArrangedGroup<T>[]
}

/** Something a list can be narrowed to. */
export type ListFilter<T> = {
  id: string
  /** What is left when it is on, as the menu puts it: "Starred", "Shared with me". */
  label: string
  /**
   * What it is a choice of. Filters of one facet are alternatives, so an item need only pass one of
   * those that are on; a filter with no facet stands alone. An item has to pass in every facet.
   */
  facet?: string
  /** What it is drawn with in a menu of its facet's own, such as a person's picture. */
  icon?: ReactNode
  test: (item: T) => boolean
}

/** A filter as a menu lists it: all but how it tests. */
export type ListFilterOption = Omit<ListFilter<never>, 'test'>

/**
 * The controls a list has, each with what it is set to and the way to set it. One that is left out
 * is not drawn.
 */
export type ListControls = {
  search?: { value: string; onChange: (query: string) => void }
  view?: { value: ListViewMode; onChange: (mode: ListViewMode) => void }
  order?: {
    value: string
    options: Array<{ id: string; label: string }>
    onChange: (id: string) => void
    /** How the list can be grouped, for one that can be, chosen in the same menu, before the order. */
    groups?: { value: string; options: Array<{ id: string; label: string }>; onChange: (id: string) => void }
  }
  filter?: {
    /** The ids of the filters that are on. */
    value: string[]
    options: ListFilterOption[]
    /**
     * The facets that have a menu of their own, by what it is called: "Members". For one with more
     * alternatives than are easily read through, or that come and go, such as people: its menu has
     * a field to find one by.
     */
    facetMenus?: Record<string, string>
    onChange: (ids: string[]) => void
    /**
     * Choices the list keeps itself, each one of a few to pick under its name, as "Agent runs:
     * Needing you, All, None". One set other than its `default` counts as a filter set.
     */
    choices?: Array<{ id: string; label: string; options: Array<{ id: string; label: string }>; value: string; default: string; onChange: (id: string) => void }>
  }
}

// Without case or accents, so that "resume" finds "Résumé".
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Whether `text` has every word of `query` in it, in any order. An empty query matches everything. */
export const matchesSearch = (text: string, query: string) => {
  const within = plain(text)
  return plain(query).split(/\s+/).every((word) => within.includes(word))
}

/** Whether `item` passes the filters that are on: one of each facet's, and each that stands alone. */
export const passesFilters = <T>(item: T, on: ListFilter<T>[]) => {
  const facets = new Map<string, ListFilter<T>[]>()
  for (const filter of on) {
    const facet = filter.facet ?? `only:${filter.id}`
    facets.set(facet, [...(facets.get(facet) ?? []), filter])
  }
  return [...facets.values()].every((alternatives) => alternatives.some(({ test }) => test(item)))
}

/** The items a search and the filters that are on leave, in the order they were in. */
export const narrowList = <T>(items: T[], { query, searchText, filters }: { query: string; searchText: (item: T) => string; filters: ListFilter<T>[] }) =>
  items.filter((item) => matchesSearch(searchText(item), query) && passesFilters(item, filters))
