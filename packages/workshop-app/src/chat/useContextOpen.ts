import { useState } from 'react'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'

/**
 * Whether the card of what a chat has is open, and the way to open and close it. Left open, it is
 * open in every chat until it is put away.
 */
export const useContextOpen = () => {
  const [open, setOpen] = useState(() => readLayoutPrefs().contextOpen === true)
  const change = (next: boolean) => {
    setOpen(next)
    writeLayoutPrefs({ contextOpen: next })
  }
  return [open, change] as const
}
