import type { ComposerCommand } from './ComposerCommandPicker'
import { matchCommands } from './slashCommands'

/** A row of the composer's + menu: one of what it always offers, or a skill or command. */
export type ComposerAddEntry =
  | { key: 'upload' | 'connection'; kind: 'action'; disabled: boolean }
  | { key: string; kind: 'command'; command: ComposerCommand }

/**
 * What the + menu lists, given what is typed in its field: to start with, uploading and adding a
 * connection, then the skills in the order given (the latest used first), then the app's own
 * commands, such as Compact. Once something is typed, only the skills and commands that fit it,
 * as a slash would offer them, since the two that are always offered are not what is looked for.
 */
export const composerAddEntries = (
  commands: readonly ComposerCommand[],
  query: string,
  can: { upload: boolean; connection: boolean },
): ComposerAddEntry[] => {
  const typed = query.trim().toLowerCase()
  const listed = typed
    ? matchCommands(commands, typed)
    : [...commands.filter(({ kind }) => kind === 'skill'), ...commands.filter(({ kind }) => kind !== 'skill')]
  const rows = listed.map((command): ComposerAddEntry => ({ key: `command:${command.key}`, kind: 'command', command }))
  if (typed) return rows
  return [{ key: 'upload', kind: 'action', disabled: !can.upload }, { key: 'connection', kind: 'action', disabled: !can.connection }, ...rows]
}

/**
 * What a key pressed in the menu's field does, beyond what the field and its list do themselves
 * (typing, the arrows, Enter): Tab chooses the row that is highlighted, as it does after a slash,
 * Escape and a Tab with nothing to choose are left to close the menu, and everything else is kept
 * from it, which would take letters for its own items' names.
 */
export const composerAddKey = (key: string, highlighted: ComposerAddEntry | undefined): 'choose' | 'close' | 'keep' => {
  if (key === 'Tab') return highlighted && !(highlighted.kind === 'action' && highlighted.disabled) ? 'choose' : 'close'
  return key === 'Escape' ? 'close' : 'keep'
}
