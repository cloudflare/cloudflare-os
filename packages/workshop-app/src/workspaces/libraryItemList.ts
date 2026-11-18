import { createElement } from 'react'
import type { AsideItem } from '@/aside/asideItems'
import { groupByTime } from '@/chat/timeGroups'
import { FormatIcon } from '@/components/FormatIcon'
import type { ListFilter, ListOrder } from '@/components/listView'
import { groupByName } from '@/components/nameGroups'
import type { ListViewSpec } from '@/hooks/useListView'
import { APP } from '@/library/libraryList'

/** What an item is: the format an output was made as, or an app. */
const typeOf = (item: AsideItem) => (item.kind === 'output' && item.output.format) || { noun: APP.noun, icon: APP.icon }

const ORDERS: ListOrder<AsideItem>[] = [
  {
    id: 'active',
    label: 'Last active',
    arrange: (items, enough) =>
      groupByTime(items.toSorted((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0)).map((item) => ({ value: item, at: item.at })), new Date(), enough),
  },
  { id: 'name', label: 'Name', arrange: (items, enough) => groupByName(items, ({ title }) => title, enough) },
]

/**
 * How what a workspace has made can be ordered, narrowed and searched: by title, by whether it asks
 * anything of the viewer (`waiting`), and by what it is, once it is more than one kind.
 */
export const libraryItemList = (items: AsideItem[], waiting: (item: AsideItem) => boolean): ListViewSpec<AsideItem, ListOrder<AsideItem>> => {
  const types = new Map(items.map((item) => [typeOf(item).noun, typeOf(item)]))
  const typeFilters: ListFilter<AsideItem>[] =
    types.size < 2
      ? []
      : [...types.values()]
          .toSorted((a, b) => a.noun.localeCompare(b.noun))
          .map(({ noun, icon }) => ({
            id: `type:${noun}`,
            label: noun,
            facet: 'type',
            icon: createElement(FormatIcon, { name: icon, className: 'size-4' }),
            test: (item) => typeOf(item).noun === noun,
          }))
  return {
    orders: ORDERS,
    filters: [{ id: 'waiting', label: 'Waiting on you', test: waiting }, ...typeFilters],
    searchText: ({ title }) => title,
  }
}
