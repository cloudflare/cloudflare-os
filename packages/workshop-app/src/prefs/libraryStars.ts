import { stored } from './stored'

const parse = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((key) => typeof key === 'string') ? value : undefined

const store = stored<string[]>('workshop-app:library-star-order', parse, [])

/**
 * The order the starred in the library were last put in on this device, as their entries' keys.
 * The server keeps only whether each is starred, so the order is this device's.
 */
export const readLibraryStarOrder = store.read

export const writeLibraryStarOrder = store.write
