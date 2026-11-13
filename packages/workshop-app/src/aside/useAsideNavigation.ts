import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { isNarrowScreen } from '@/hooks/useNarrowScreen'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { parseAsideRef } from './asideItems'
import { lastShown, rememberShown } from './lastShown'

/** A chat, by where it is. */
export type ChatRef = { workspaceId: string; chatId: number }

/**
 * What to show beside a chat that is being gone to with nothing named: what was last shown beside
 * it, when the aside was showing when last left. A link that names something shows that instead.
 * Nothing on a narrow screen, where the aside would cover the chat that was asked for.
 */
export const asideFor = ({ workspaceId, chatId }: ChatRef): string | undefined =>
  readLayoutPrefs().asideOpen && !isNarrowScreen() ? lastShown(workspaceId, chatId) : undefined

/**
 * The ways to show something beside a chat page and to put the aside away, which are history: the
 * URL names what is shown (`?open=`). Showing something with the aside away is a step of its own,
 * so Back puts it away again; showing another in its place, or putting it away, is not. Each
 * function is stable.
 */
export const useAsideNavigation = () => {
  const router = useRouter()
  const [actions] = useState(() => ({
    /** Shows `open` (an `AsideRef`, written out) beside the chat page this is on, the chat if it has been made. */
    show: (open: string, chat?: ChatRef) => {
      const { location } = router.state
      // Read as the URL has it: an output's ref comes back a number.
      const showing = parseAsideRef(location.search.open) !== undefined
      if (chat) rememberShown(chat.workspaceId, chat.chatId, open)
      writeLayoutPrefs({ asideOpen: true })
      void router.navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => ({ ...previous, open }),
        replace: showing,
        state: { chatTitle: location.state.chatTitle, asideOpenedHere: showing ? location.state.asideOpenedHere : true },
      })
    },
    /** Puts the aside away: back, when showing it was the last step. */
    hide: () => {
      const { location } = router.state
      writeLayoutPrefs({ asideOpen: false })
      if (location.state.asideOpenedHere) return router.history.back()
      void router.navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => ({ ...previous, open: undefined }),
        replace: true,
        state: { chatTitle: location.state.chatTitle },
      })
    },
  }))
  return actions
}
