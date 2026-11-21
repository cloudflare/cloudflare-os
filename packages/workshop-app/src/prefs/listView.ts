import type { ListViewKeeper, ListViewPrefs } from '@gadgets/ui'
import { isRecord, stored } from './stored'

const parse = (value: unknown): ListViewPrefs | undefined =>
  isRecord(value) && (value.mode === 'list' || value.mode === 'cards')
    ? {
        mode: value.mode,
        order: typeof value.order === 'string' ? value.order : undefined,
        group: typeof value.group === 'string' ? value.group : undefined,
        filters: Array.isArray(value.filters) ? value.filters.filter((id): id is string => typeof id === 'string') : undefined,
      }
    : undefined

/**
 * Keeps how each list is looked at on this device, for `ListViewPrefsContext`. A search is not
 * kept, and for most lists filters are not either: they are for the visit, and a list that came
 * back narrowed would seem to have lost things. A list that is narrowed to start with keeps them, as
 * what it leaves out is then the user's to say (`useListView`).
 */
export const keepListViewOnDevice: ListViewKeeper = (name, mode) => stored<ListViewPrefs>(`workshop-app:list-view:${name}`, parse, { mode })
