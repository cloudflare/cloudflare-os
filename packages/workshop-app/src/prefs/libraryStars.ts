import { stored } from './stored'

const parse = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((key) => typeof key === 'string') ? value : undefined

const store = stored<string[]>('workshop-app:library-stars', parse, [])

/**
 * What is starred in the library on this device, as the outputs' keys, in the order they were last
 * put in. The server keeps no star for an output, so both the stars and their order are this
 * device's.
 */
export const readLibraryStars = store.read

export const writeLibraryStars = store.write
