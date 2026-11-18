import { stored } from './stored'

/** How many of the outputs opened last are remembered: more than Recent shows, for any deleted meanwhile. */
export const OPENED_KEPT = 50

/** The outputs opened last (their keys, latest first) with `key` opened now: first, and once. */
export const withOpened = (opened: readonly string[], key: string): string[] =>
  [key, ...opened.filter((other) => other !== key)].slice(0, OPENED_KEPT)

const parse = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((key) => typeof key === 'string') ? value : undefined

const store = stored<string[]>('workshop-app:library-opened', parse, [])

/**
 * What of the library was opened last on this device, as the outputs' keys, latest first: what the
 * Library's Recent tab lists after what needs the user. The server keeps no record of it.
 */
export const readLibraryOpened = store.read

/** Remembers that the output `key` names was opened now. */
export const recordLibraryOpen = (key: string) => store.write(withOpened(store.read(), key))
