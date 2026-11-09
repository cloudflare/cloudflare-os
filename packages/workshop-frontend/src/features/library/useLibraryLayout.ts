import { useState } from 'react'
import type { LibraryLayout } from './LibraryViews'

const STORAGE_KEY = 'gadgets:library:layout'

/** Whether Library views show a list or a grid, remembered on this device. */
export function useLibraryLayout(): [LibraryLayout, (layout: LibraryLayout) => void] {
  const [layout, setLayoutState] = useState<LibraryLayout>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })
  const setLayout = (next: LibraryLayout) => {
    setLayoutState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* still applies for this visit */ }
  }
  return [layout, setLayout]
}
