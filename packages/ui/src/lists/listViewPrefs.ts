import { createContext } from 'react'
import type { ListViewMode } from './listView'

/**
 * How a list was last looked at: as rows or cards, in which order (by its id), and, for a list
 * that keeps them, which filters were on (by their ids).
 */
export type ListViewPrefs = { mode: ListViewMode; order?: string; filters?: string[] }

/** What is kept of how one list is looked at. */
export type KeptListView = { read: () => ListViewPrefs; write: (prefs: ListViewPrefs) => void }

/**
 * Where how the list called `name` is looked at is kept, read as `{ mode }` until the user has
 * chosen: on the device, for an app that has storage of its own, or only for the visit.
 */
export type ListViewKeeper = (name: string, mode: ListViewMode) => KeptListView

const visit = new Map<string, ListViewPrefs>()

/** Keeps how each list is looked at until the page is left, for an app with nowhere to keep it longer, such as a sandboxed frame. */
export const keepListViewForTheVisit: ListViewKeeper = (name, mode) => ({
  read: () => visit.get(name) ?? { mode },
  write: (prefs) => {
    visit.set(name, prefs)
  },
})

/**
 * Where `useListView` keeps how its lists are looked at: give the app's own (`ListViewPrefsContext`'s
 * provider, near its root) to keep them longer than the visit.
 */
export const ListViewPrefsContext = createContext<ListViewKeeper>(keepListViewForTheVisit)
