/**
 * A value kept in this browser's `localStorage` under `key`, as JSON: `read` gives `fallback` for
 * one that is missing, unreadable, or not what `parse` accepts. Storage that is unavailable (a
 * private window, a sandboxed frame) only means nothing is kept.
 */
export const stored = <T>(key: string, parse: (value: unknown) => T | undefined, fallback: T) => ({
  read: (): T => {
    try {
      const raw = localStorage.getItem(key)
      return (raw === null ? undefined : parse(JSON.parse(raw))) ?? fallback
    } catch {
      return fallback
    }
  },
  write: (value: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Kept for this page only.
    }
  },
})

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
