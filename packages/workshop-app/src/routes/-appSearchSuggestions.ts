import type { SearchEntry } from '@/blocks/SearchDialog'

// How many are offered before anything is typed.
const SUGGESTED_WORKSPACES = 3

/** What a few settings are listed under before anything is typed, in place of the part of the settings each is in. */
const SETTINGS = 'Settings'

/** What is done first, which is offered with no heading of its own. */
const ACTIONS = 'Actions'

const actions = (entries: readonly SearchEntry[]) => entries.map((entry) => ({ ...entry, group: ACTIONS, noHeading: true }))
const settingsGroup = (entries: readonly SearchEntry[]) => entries.map((entry) => ({ ...entry, group: SETTINGS }))

/** What is done where the user is: in a chat or on a workspace's page. */
export type SuggestedContext = {
  kind: 'chat' | 'workspace'
  /** A new chat in the workspace, where the viewer may start one: if not, there is the one of its own. */
  newChat: SearchEntry | undefined
  /** Inviting people to the workspace, where the viewer may, on its page. */
  invite: SearchEntry | undefined
}

/**
 * What search offers before anything is typed, in this order: what is done first, with no heading,
 * which is a new chat, in the workspace where the user is in one (`context`), with what else is done
 * there, else a new chat of its own (neither on the page that starts a chat); the most recent workspaces; the pages that are gone to most,
 * which the sidebar also has; and a few settings that are reached for, across the parts of the
 * settings, and the way to the rest of them (the Settings page), under one heading.
 *
 * In a chat what else is done is the default model, whose next message it answers, which is then not
 * with the settings; on a workspace's page, inviting people to it. Each is as it is found by typing,
 * but for where it is listed.
 */
export const suggestedEntries = ({ workspaces, pages, newChat, model, settings, context }: {
  /** Most recently active first. */
  workspaces: readonly SearchEntry[]
  pages: readonly SearchEntry[]
  /**
   * A new chat of its own, which starts a workspace: first where there is no workspace to start one
   * in. Not offered where the user is on the page that starts a chat already.
   */
  newChat: SearchEntry | undefined
  /** The default model, which may not be offered. */
  model: SearchEntry | undefined
  /** Anything that is to be listed with the settings, whatever it is found under by typing. */
  settings: readonly SearchEntry[]
  context: SuggestedContext | undefined
}): SearchEntry[] => {
  const first = context?.newChat ?? newChat
  const here = context?.kind === 'chat' ? [first, model] : [first, context?.invite]
  const withSettings = context?.kind === 'chat' ? undefined : model
  return [
    ...actions(here.filter((entry): entry is SearchEntry => entry !== undefined)),
    ...workspaces.slice(0, SUGGESTED_WORKSPACES),
    ...pages,
    ...settingsGroup(withSettings ? [withSettings, ...settings] : settings),
  ]
}
