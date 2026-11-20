import { MAX_WORKSPACE_LOOKS, type WorkspaceLook } from '@/prefs/preferenceFields'
import type { UserPreferences } from '@/prefs/UserPreferences'
import { usePreferencesSnapshot } from '@/prefs/UserPreferencesContext'

/** How each workspace's icon is drawn, by the workspace's id. One that is not there is drawn as any is. */
export type WorkspaceLooksById = Readonly<Partial<Record<string, WorkspaceLook>>>

/**
 * How the user has each workspace's icon drawn, by the workspace's id, as their preferences keep
 * it (`workspaceLooks`). A look for a workspace that is no longer listed is only never asked for.
 */
export const useWorkspaceLooks = (): WorkspaceLooksById => usePreferencesSnapshot().workspaceLooks

/**
 * Has a workspace's icon drawn as `look` from now on, wherever it is drawn, in the user's
 * preferences: for the MAX_WORKSPACE_LOOKS last set, the oldest going first.
 */
export const setWorkspaceLook = (preferences: UserPreferences, id: string, look: WorkspaceLook) =>
  preferences.change(({ workspaceLooks }) => {
    const others = Object.entries(workspaceLooks).filter(([other]) => other !== id)
    return { workspaceLooks: Object.fromEntries([...others, [id, look]].slice(-MAX_WORKSPACE_LOOKS)) }
  })
