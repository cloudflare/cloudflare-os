import { useState } from 'react'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'

/**
 * Whether the card of what a chat has is open, and the way to open and close it. Left open, it is
 * open in every chat until it is put away. Open as the chat was, before anyone has changed it
 * here, it is `restored`: it is simply there, as it was left, rather than opening.
 */
export const useContextOpen = () => {
  const [state, setState] = useState(() => {
    const open = readLayoutPrefs().contextOpen === true
    return { open, restored: open }
  })
  const change = (next: boolean) => {
    setState({ open: next, restored: false })
    writeLayoutPrefs({ contextOpen: next })
  }
  return [state.open, change, state.restored] as const
}
