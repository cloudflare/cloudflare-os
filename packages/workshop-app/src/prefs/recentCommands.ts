import { stored, stringList } from './stored'
import { withOpened } from './libraryOpened'

const store = stored<string[]>('workshop-app:recent-commands', stringList, [])

/**
 * The skills and commands chosen in a composer last on this device, by name, latest first: what
 * the composer's + menu names first, and the slash list puts first among equally good matches. The
 * server keeps no record of it.
 */
export const readRecentCommands = store.read

/** Remembers that the command `name` was chosen now. */
export const recordCommandUse = (name: string) => store.write(withOpened(store.read(), name))

/** `commands` with those chosen last first, latest first, and the rest as they were. */
export const byRecentUse = <Command extends { name: string }>(commands: readonly Command[], recent: readonly string[]): Command[] => {
  const place = new Map(recent.map((name, index) => [name, index]))
  return commands
    .map((command, index) => ({ command, index, at: place.get(command.name) ?? Infinity }))
    .toSorted((a, b) => a.at - b.at || a.index - b.index)
    .map(({ command }) => command)
}
