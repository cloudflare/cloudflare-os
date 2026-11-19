import { stored } from './stored'

/**
 * A value kept as `stored` keeps it, which can also be subscribed to: from here, and from another
 * tab of the same browser, so that what draws it stays in step (`useSyncExternalStore`).
 */
export const watched = <T>(key: string, parse: (value: unknown) => T | undefined, fallback: T) => {
  const store = stored(key, parse, fallback)
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }
  if (typeof addEventListener === 'function') addEventListener('storage', (event) => { if (event.key === key || event.key === null) changed() })

  return {
    read: store.read,
    write: (value: T) => {
      store.write(value)
      changed()
    },
    subscribe: (onChange: () => void) => {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

/** A `parse` for a value that is on or off. */
export const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
