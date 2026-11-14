import type { SlashCommandChoice, SlashCommandId, SlashCommandRequest } from '@gadgets/workshop-shared/api'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { skillTitle } from '@/skills/skillManifest'
import type { Skill } from '@/skills/SkillsLibrary'

/**
 * What a command is known by in the composer, the same before a workspace has one as in it: a
 * skill by its document's id (`collection/path`), which is the command id its gatekeeper gives it
 * in every workspace, and a built-in by its own.
 */
const keyOf = (id: SlashCommandId) => (id.builtin ? `builtin:${id.commandId}` : `command:${id.commandId}`)

// Words for the built-ins, which the server names in its own.
const BUILTINS: Record<string, Pick<ComposerCommand, 'title' | 'description'>> = {
  compact: { title: 'Compact', description: 'Sum up the chat so far, to make room for more' },
}

/** A command a workspace offers (`Overseer.listSlashCommands`), as the composer shows it. */
export const composerCommandOf = ({ selection, name, description, providerLabel }: SlashCommandChoice): ComposerCommand => ({
  key: keyOf(selection),
  name,
  ...(selection.builtin
    ? { kind: 'builtin', ...(BUILTINS[selection.commandId] ?? { title: skillTitle(name), description }) }
    : { kind: 'skill', title: skillTitle(name), description, source: providerLabel }),
})

/** A skill in the Library as the composer offers it, before any workspace has listed it. */
export const skillCommandOf = (skill: Pick<Skill, 'id' | 'name' | 'description'>, source?: string): ComposerCommand => ({
  key: keyOf({ gatekeeperId: 0, commandId: skill.id }),
  name: skill.name,
  title: skillTitle(skill.name),
  description: skill.description,
  kind: 'skill',
  source,
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
