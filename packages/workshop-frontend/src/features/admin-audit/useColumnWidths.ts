import { useState } from 'react'

/** The narrowest and widest a resizable column may be, in pixels. */
export const MIN_COLUMN_WIDTH = 64
export const MAX_COLUMN_WIDTH = 800

/** `width` held within the bounds every resizable column keeps, in whole pixels. */
export const clampColumnWidth = (width: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)))

// Reaches `localStorage` only when called, inside a try/catch: merely reading the global throws
// where storage is blocked.
const read = (storageKey: string): unknown => {
  try {
    const stored = localStorage.getItem(storageKey)
    return stored === null ? null : JSON.parse(stored)
  } catch {
    return null
  }
}

const write = (storageKey: string, widths: Record<string, number>) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths))
  } catch {
    // Storage blocked or full: the widths hold for this page only.
  }
}

/**
 * The widths of a table's resizable columns, starting from those stored under `storageKey` and
 * falling back to `defaults` for any missing or malformed. `setWidth` holds a width within the
 * bounds, and stores every width once `persist` is set (at the end of a drag, on each key press);
 * `reset` returns a column to its default and stores that.
 */
export const useColumnWidths = <K extends string>(storageKey: string, defaults: Record<K, number>) => {
  const [widths, setWidths] = useState<Record<K, number>>(() => {
    const stored = read(storageKey)
    const valid = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {}
    const initial = { ...defaults }
    for (const column of Object.keys(defaults) as K[]) {
      const width = valid[column]
      if (typeof width === 'number' && Number.isFinite(width)) initial[column] = clampColumnWidth(width)
    }
    return initial
  })

  // Each width set is absolute (a drag sets the width it has reached, not a step), so building on
  // the rendered widths loses nothing.
  const setWidth = (column: K, width: number, persist: boolean) => {
    const next = { ...widths, [column]: clampColumnWidth(width) }
    setWidths(next)
    if (persist) write(storageKey, next)
  }
  const reset = (column: K) => setWidth(column, defaults[column], true)

  return { widths, setWidth, reset }
}
