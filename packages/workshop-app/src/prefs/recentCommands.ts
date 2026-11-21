import { MAX_PREFERENCE_LENGTH, MAX_RECENT_COMMANDS } from './preferenceFields'
import type { UserPreferences } from './UserPreferences'

/**
 * Remembers that the command `name` was chosen now, in the user's account: `recentCommands`, the
 * skills and commands chosen last in a composer, latest first, which the composer's + menu names
 * first, and the slash list puts first among equally good matches.
 */
export const recordCommandUse = (preferences: UserPreferences, name: string) => {
  if (preferences.getSnapshot().recentCommands[0] === name || name.length > MAX_PREFERENCE_LENGTH) return
  preferences.change(({ recentCommands }) => ({
    recentCommands: [name, ...recentCommands.filter((other) => other !== name)].slice(0, MAX_RECENT_COMMANDS),
  }))
}

/** `commands` with those chosen last first, latest first, and the rest as they were. */
export const byRecentUse = <Command extends { name: string }>(commands: readonly Command[], recent: readonly string[]): Command[] => {
  const place = new Map(recent.map((name, index) => [name, index]))
  return commands
    .map((command, index) => ({ command, index, at: place.get(command.name) ?? Infinity }))
    .toSorted((a, b) => a.at - b.at || a.index - b.index)
    .map(({ command }) => command)
}
