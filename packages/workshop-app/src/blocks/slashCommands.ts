import type { ComposerCommand } from './ComposerCommandPicker'

/** A slash and what follows it, up to the cursor, at the start of a word: what the picker filters by. */
export type SlashToken = { start: number; query: string }

/**
 * The slash command being typed, where the cursor is: a `/` at the start of the draft or after a
 * space, followed by what can be in a name. Nothing elsewhere, so a path or a URL is left alone,
 * and `//` is written as it is.
 */
export const slashTokenAt = (text: string, cursor: number): SlashToken | undefined => {
  const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(text.slice(0, cursor))
  if (!match) return undefined
  // The rest of the word, after the cursor, must be part of it too.
  if (/^[^\s]/.test(text.slice(cursor))) return undefined
  return { start: match.index + match[1].length, query: match[2].toLowerCase() }
}

/**
 * The commands that fit what was typed: names and plain-word titles that start with it first, then
 * those with a word that does, then anywhere in what they are for.
 */
export const matchCommands = (commands: readonly ComposerCommand[], query: string): ComposerCommand[] => {
  if (!query) return [...commands]
  const rank = (command: ComposerCommand) => {
    const title = command.title.toLowerCase()
    if (command.name.startsWith(query) || title.startsWith(query)) return 0
    if (command.name.split('-').some((word) => word.startsWith(query)) || title.split(/\s+/).some((word) => word.startsWith(query))) return 1
    return command.description.toLowerCase().includes(query) ? 2 : 3
  }
  return commands
    .map((command, index) => ({ command, index, place: rank(command) }))
    .filter(({ place }) => place < 3)
    .toSorted((a, b) => a.place - b.place || a.index - b.index)
    .map(({ command }) => command)
}

/**
 * The command a message typed out in full starts with, such as `/meeting-brief for Tuesday`, and
 * the words after it, which are what the command is given. Only an exact name counts: anything
 * else is a message that happens to start with a slash.
 */
export const leadingCommand = (commands: readonly ComposerCommand[], text: string): { command: ComposerCommand; args: string } | undefined => {
  const match = /^\/([a-z0-9-]+)(?:\s+|$)/i.exec(text)
  const command = match && commands.find(({ name }) => name === match[1].toLowerCase())
  return command ? { command, args: text.slice(match[0].length) } : undefined
}
