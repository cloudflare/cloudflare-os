import { useState } from 'react'
import { ENOUGH, narrowList, type ArrangedGroup, type ListControls, type ListFilter, type ListOrder, type ListViewMode } from '@/components/listView'
import { listViewPrefs, type ListViewPrefs } from '@/prefs/listView'

export type ListViewSpec<T, Order extends ListOrder<T>> = {
  /** The orders the list can be put in. The first is the one it starts in. */
  orders: Order[]
  /** What the list can be narrowed to, if anything. */
  filters?: ListFilter<T>[]
  /** The ids of the filters that are on to start with, for a list that leaves something out until it is asked for. */
  startsNarrowedTo?: string[]
  /** The filters that are on are kept on this device, as the order is, rather than for the visit. */
  keepsFilters?: boolean
  /** The facets whose filters have a menu of their own, by what it is called (see `ListControls`). */
  facetMenus?: Record<string, string>
  /**
   * How the list can be grouped, apart from its order, which then orders each group: the first is
   * how it starts. The list groups it itself (`ListView`'s `grouping`); the choice is kept as the
   * order is.
   */
  groupings?: Array<{ id: string; label: string }>
  /** What a search looks through for an item: its title, and whatever else it may be known by. */
  searchText: (item: T) => string
  /** How it is drawn until the user chooses: as rows, unless it says cards. */
  startsAs?: ListViewMode
  /** What it is searched for to start with, such as what a link to it asked for. */
  startsSearchedFor?: string
}

export type ListView<T, Order extends ListOrder<T>> = {
  mode: ListViewMode
  order: Order
  /** The id of how it is grouped, where it can be. */
  grouping?: string
  /** Whether a search or a filter is leaving things out. */
  narrowed: boolean
  /** The items the search and the filters leave. */
  narrow: (items: T[]) => T[]
  /** The items in the order chosen, in its groups, as fine as the view has a use for. */
  arrange: (items: T[]) => ArrangedGroup<T>[]
  /** Drops the search and the filters, so that everything is listed again. */
  showAll: () => void
  /** What `ListToolbar` draws: leave one out for a list that has no use for it. */
  controls: Required<ListControls>
}

/**
 * How one list is looked at: as rows or cards and in which order, both kept on this device under
 * `name`, and what it is searched for and narrowed to, which last for the visit, unless the list
 * keeps its filters too (`keepsFilters`). `name` says which list it is and must not change.
 */
export const useListView = <T, Order extends ListOrder<T> = ListOrder<T>>(name: string, spec: ListViewSpec<T, Order>): ListView<T, Order> => {
  const [prefs, setPrefs] = useState(() => listViewPrefs(name, spec.startsAs).read())
  const [query, setQuery] = useState(spec.startsSearchedFor ?? '')
  // Those kept from before, where the list keeps them, or else those it starts with.
  const [filtersOn, setFiltersOn] = useState<string[]>(() => (spec.keepsFilters ? prefs.filters : undefined) ?? spec.startsNarrowedTo ?? [])

  const keep = (next: ListViewPrefs) => {
    setPrefs(next)
    listViewPrefs(name, spec.startsAs).write(next)
  }
  const narrowTo = (ids: string[]) => {
    setFiltersOn(ids)
    if (spec.keepsFilters) keep({ ...prefs, filters: ids })
  }
  // One kept from before may be gone since.
  const order = spec.orders.find(({ id }) => id === prefs.order) ?? spec.orders[0]
  const grouping = spec.groupings && (spec.groupings.find(({ id }) => id === prefs.group) ?? spec.groupings[0]).id
  const filters = spec.filters ?? []
  const on = filters.filter(({ id }) => filtersOn.includes(id))

  return {
    mode: prefs.mode,
    order,
    grouping,
    narrowed: query.trim() !== '' || on.length > 0,
    narrow: (items) => narrowList(items, { query, searchText: spec.searchText, filters: on }),
    arrange: (items) => order.arrange(items, ENOUGH[prefs.mode]),
    showAll: () => {
      setQuery('')
      narrowTo([])
    },
    controls: {
      search: { value: query, onChange: setQuery },
      view: { value: prefs.mode, onChange: (mode) => keep({ ...prefs, mode }) },
      order: {
        value: order.id,
        options: spec.orders.map(({ id, label }) => ({ id, label })),
        onChange: (id) => keep({ ...prefs, order: id }),
        groups: spec.groupings && grouping !== undefined ? { value: grouping, options: spec.groupings, onChange: (id) => keep({ ...prefs, group: id }) } : undefined,
      },
      filter: {
        value: on.map(({ id }) => id),
        options: filters.map(({ id, label, facet, icon }) => ({ id, label, facet, icon })),
        facetMenus: spec.facetMenus,
        onChange: narrowTo,
      },
    },
  }
}
