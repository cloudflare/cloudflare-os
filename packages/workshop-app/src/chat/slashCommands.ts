import type { SlashCommandChoice, SlashCommandId, SlashCommandRequest } from '@gadgets/workshop-shared/api'
import { commandTitle, type ComposerCommand } from '@/blocks/composerCommand'

/**
 * What a command is known by in the composer: a gatekeeper's by its command id, which that
 * gatekeeper gives it in every workspace, and a built-in by its own.
 */
const keyOf = (id: Pick<SlashCommandId, 'commandId'> & { builtin?: boolean }) => (id.builtin ? `builtin:${id.commandId}` : `command:${id.commandId}`)

// Words for the built-ins, which the server names in its own.
const BUILTINS: Record<string, Pick<ComposerCommand, 'title' | 'description'>> = {
  compact: { title: 'Compact', description: 'Sum up the chat so far, to make room for more' },
}

/**
 * A command a workspace offers (`Overseer.listSlashCommands`), as the composer shows it. A skill
 * says where it is kept, which tells it from another of its name: the first part of what its
 * provider labels it with, which for the Context Library is its collection (the rest is its path
 * there), or else the provider.
 */
export const composerCommandOf = ({ selection, name, description, providerLabel, resourceLabel }: SlashCommandChoice): ComposerCommand => ({
  key: keyOf(selection),
  name,
  ...(selection.builtin
    ? { kind: 'builtin', ...(BUILTINS[selection.commandId] ?? { title: commandTitle(name), description }) }
    : { kind: 'skill', title: commandTitle(name), description, source: resourceLabel?.split(' · ')[0]?.trim() || providerLabel }),
})

/**
 * The request that sends `command` with `args` in a workspace that offers `choices`, or nothing
 * when it offers no such command, such as a skill that has since been deleted or unshared.
 */
export const slashRequestFor = (choices: readonly SlashCommandChoice[], command: ComposerCommand, args: string): SlashCommandRequest | undefined => {
  const choice = choices.find(({ selection }) => keyOf(selection) === command.key)
  return choice && { id: choice.selection, args, commandPosition: 0 }
}

/** Why a command could not be sent, for one its workspace does not offer. */
export const missingCommand = (command: ComposerCommand) =>
  command.kind === 'skill'
    ? `${command.title} isn’t available here. It may have been deleted or not shared with you.`
    : `${command.title} isn’t available here.`

/** Skills first, by name in plain words, then the app's own commands, which are not what is looked for most. */
export const orderCommands = (commands: readonly ComposerCommand[]) =>
  commands.toSorted((a, b) => Number(a.kind === 'builtin') - Number(b.kind === 'builtin') || a.title.localeCompare(b.title))
