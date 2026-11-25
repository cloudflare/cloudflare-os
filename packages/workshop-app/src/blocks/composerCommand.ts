import { FoldVerticalIcon, ScrollIcon, type Icon } from '@/components/icons'

/** Something the composer can send in place of words alone: a skill, or a built-in command. */
export type ComposerCommand = {
  /** Which it is, among the composer's commands. */
  key: string
  /** As typed after the slash: `meeting-brief`. */
  name: string
  /** In plain words: "Meeting Brief". */
  title: string
  description: string
  /** A skill the agent follows, or a command of the app's own such as Compact. */
  kind: 'skill' | 'builtin'
  /** Where it is kept, such as its collection, for whoever wants to know. */
  source?: string
}

/** A command's name after the `/` (`meeting-brief`) in plain words (`Meeting Brief`). */
export const commandTitle = (name: string) =>
  name
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/** A command's glyph: a skill's scroll, or what a built-in does. */
export const commandGlyph = (command: Pick<ComposerCommand, 'kind' | 'name'>): Icon =>
  command.kind === 'builtin' && command.name === 'compact' ? FoldVerticalIcon : ScrollIcon
