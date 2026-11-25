import type { ComposerCommand } from './composerCommand'

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
