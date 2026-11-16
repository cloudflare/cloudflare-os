import { isRecord, stored } from './stored'

/** How a list was last looked at on this device: as rows or cards, and in which order (by its id). */
export type ListViewPrefs = { mode: 'list' | 'cards'; order?: string }

const parse = (value: unknown): ListViewPrefs | undefined =>
  isRecord(value) && (value.mode === 'list' || value.mode === 'cards')
    ? { mode: value.mode, order: typeof value.order === 'string' ? value.order : undefined }
    : undefined

/**
 * What is kept of how the list called `name` is looked at. A search and filters are not: they are
 * for the visit, and a list that came back narrowed would seem to have lost things.
 */
export const listViewPrefs = (name: string) => stored<ListViewPrefs>(`workshop-app:list-view:${name}`, parse, { mode: 'list' })
