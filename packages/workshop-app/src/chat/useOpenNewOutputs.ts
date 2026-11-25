import { useEffect, useState } from 'react'
import { isNarrowScreen } from '@gadgets/ui'
import { readLayoutPrefs } from '@/prefs/layoutPrefs'
import type { ChatFeed, OutputItem } from './chatItems'
import { NewOutputs } from './NewOutputs'

/**
 * Has what the chat makes while it is open shown as it is made (`onOpen`), unless the user has
 * switched that off on this device (`LayoutPrefs.opensNewOutputs`). Not on a narrow screen, where it
 * would cover the chat it was made in. Give it the feed once the chat is ready.
 */
export const useOpenNewOutputs = (feed: Pick<ChatFeed, 'items' | 'pinned'> | undefined, onOpen: ((output: OutputItem) => void) | undefined) => {
  const [outputs] = useState(() => new NewOutputs())
  const items = feed?.items
  const pinned = feed?.pinned
  // The server says when something is made, which nothing the user does here stands for.
  useEffect(() => {
    if (!items || !pinned) return
    // Taken whether or not it is shown, so that switching this back on shows nothing made before.
    const made = outputs.take({ items, pinned })
    if (made && onOpen && readLayoutPrefs().opensNewOutputs !== false && !isNarrowScreen()) onOpen(made)
  }, [outputs, items, pinned, onOpen])
}
