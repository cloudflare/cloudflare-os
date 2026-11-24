import { MAX_PREFERENCE_LENGTH, MAX_RECENT_COMMANDS } from './preferenceFields'
import type { UserPreferences } from './UserPreferences'

/**
 * Remembers that the command with that `key` was chosen now, in the user's account:
 * `recentCommands`, the skills and commands chosen last in a composer, latest first, which the
 * composer's + menu names first, and the slash list puts first among equally good matches. By its
 * key rather than its name, which two skills of different collections can share.
 */
export const recordCommandUse = (preferences: UserPreferences, key: string) => {
  if (preferences.getSnapshot().recentCommands[0] === key || key.length > MAX_PREFERENCE_LENGTH) return
  preferences.change(({ recentCommands }) => ({
    recentCommands: [key, ...recentCommands.filter((other) => other !== key)].slice(0, MAX_RECENT_COMMANDS),
  }))
}

/** `commands` with those chosen last first, latest first, and the rest as they were. */
export const byRecentUse = <Command extends { key: string }>(commands: readonly Command[], recent: readonly string[]): Command[] => {
  const place = new Map(recent.map((key, index) => [key, index]))
  return commands
    .map((command, index) => ({ command, index, at: place.get(command.key) ?? Infinity }))
    .toSorted((a, b) => a.at - b.at || a.index - b.index)
    .map(({ command }) => command)
}
