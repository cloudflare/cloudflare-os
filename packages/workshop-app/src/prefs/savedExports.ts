import { MAX_PREFERENCE_LENGTH, MAX_SAVED_EXPORTS, type SavedExport } from './preferenceFields'
import type { UserPreferences } from './UserPreferences'

/**
 * Remembers the file a save under `key` (see `savedExportKey`) made, in the user's account, so a
 * later save from any browser can replace it: for the latest MAX_SAVED_EXPORTS. One too long to
 * keep is not kept.
 */
export const rememberSavedExport = (preferences: UserPreferences, key: string, saved: SavedExport) => {
  if ([key, saved.url, saved.name].some((text) => text.length > MAX_PREFERENCE_LENGTH)) return
  preferences.change(({ savedExports }) => {
    const entries = Object.entries(savedExports).filter(([candidate]) => candidate !== key)
    return { savedExports: Object.fromEntries([...entries, [key, saved]].slice(-MAX_SAVED_EXPORTS)) }
  })
}
