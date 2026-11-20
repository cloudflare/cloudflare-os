import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { isNarrowScreen } from '@gadgets/ui'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import type { UserPreferences } from '@/prefs/UserPreferences'
import { usePreferences } from '@/prefs/UserPreferencesContext'
import { carriedOpen, parseAsideRef } from './asideItems'
import { lastShown, rememberShown } from './lastShown'

/** A chat, by where it is. */
export type ChatRef = { workspaceId: string; chatId: number }

/** A page that things are shown beside, by where it is: a chat, or with no chat, its workspace's own page. */
export type BesideRef = { workspaceId: string; chatId?: number }

/**
 * What to show beside a chat that is being gone to with nothing named: what was last shown beside
 * it, when the aside was showing when last left. A link that names something shows that instead.
 * Nothing on a narrow screen, where the aside would cover the chat that was asked for.
 */
export const asideFor = (preferences: UserPreferences, { workspaceId, chatId }: ChatRef): string | undefined =>
  readLayoutPrefs().asideOpen && !isNarrowScreen() ? lastShown(preferences.getSnapshot(), workspaceId, chatId) : undefined

/**
 * What to show beside `to`, a page of a workspace being gone to from another of its pages, where
 * `open` is shown: the same, when it is the workspace's to show (`carriedOpen`), so that it stays
 * in sight from one chat to the next. It is then what was last shown beside `to`.
 */
export const carryAside = (preferences: UserPreferences, open: unknown, to: BesideRef): string | undefined => {
  const carried = carriedOpen(open)
  if (carried !== undefined) rememberShown(preferences, to.workspaceId, to.chatId, carried)
  return carried
}

/**
 * The ways to show something beside a page, a chat's or a workspace's, and to put the aside away,
 * which are history: the URL names what is shown (`?open=`). Showing something with the aside away
 * is a step of its own, so Back puts it away again; showing another in its place, or putting it
 * away, is not. Each function is stable.
 */
export const useAsideNavigation = () => {
  const router = useRouter()
  // Each connection has its own, read when a function is called.
  const current = usePreferences()
  const preferences = useRef(current)
  preferences.current = current
  const [actions] = useState(() => ({
    /** Shows `open` (an `AsideRef`, written out) beside the page this is on: `beside`, unless it is a chat still to be made. */
    show: (open: string, beside?: BesideRef) => {
      const { location } = router.state
      // Read as the URL has it: an output's ref comes back a number.
      const showing = parseAsideRef(location.search.open) !== undefined
      if (beside) rememberShown(preferences.current, beside.workspaceId, beside.chatId, open)
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
