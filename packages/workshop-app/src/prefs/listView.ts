import { isRecord, stored } from './stored'

/**
 * How a list was last looked at on this device: as rows or cards, in which order (by its id), how
 * grouped, for a list that can be (by its id), and, for a list that keeps them, which filters were
 * on (by their ids).
 */
export type ListViewPrefs = { mode: 'list' | 'cards'; order?: string; group?: string; filters?: string[] }

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
 * What is kept of how the list called `name` is looked at. A search is not, and for most lists
 * filters are not either: they are for the visit, and a list that came back narrowed would seem to
 * have lost things. A list that is narrowed to start with keeps them, as what it leaves out is
 * then the user's to say (`useListView`). Until the user has chosen, it is looked at as `mode`.
 */
export const listViewPrefs = (name: string, mode: ListViewPrefs['mode'] = 'list') =>
  stored<ListViewPrefs>(`workshop-app:list-view:${name}`, parse, { mode })
