import type { ReactNode } from 'react'
import type { ComposerCommand } from './composerCommand'
import { searchMatches } from './searchMatches'

/**
 * Something the + menu offers besides uploading and the skills, as whoever has the composer knows
 * it: a format or a template to start with, something to set up, such as an automation, or a
 * service to connect something of.
 */
export type ComposerAddOffer = {
  key: string
  group: 'format' | 'setup' | 'connection' | 'template'
  title: string
  /** A few words at the end of its row: what choosing it does, or what tells it from another of its name. */
  detail?: string
  /** What it is found by besides its title. */
  keywords?: readonly string[]
  icon: ReactNode
  /** One of the few that the menu opens with, before anything is typed. */
  suggested?: boolean
  /** What choosing it opens has the focus itself, such as a dialog: the draft is not gone back to. */
  opens?: boolean
  onChoose: () => void
}

/** A kind there can be many of, which the menu lists whole only when asked to. */
export type ComposerAddList = 'skill' | 'connection'

/** A row of the + menu. */
export type ComposerAddEntry = { key: string; title: string; keywords?: readonly string[] } & (
  | { kind: 'upload'; disabled: boolean }
  | { kind: 'command'; command: ComposerCommand }
  | { kind: 'offer'; offer: ComposerAddOffer }
  /** Goes on to all of a kind. */
  | { kind: 'all'; list: ComposerAddList }
)

const commandEntry = (command: ComposerCommand): ComposerAddEntry => ({
  key: `command:${command.key}`,
  kind: 'command',
  title: command.title,
  keywords: [command.name, command.description, command.source ?? ''],
  command,
})

const offerEntry = (offer: ComposerAddOffer): ComposerAddEntry => ({
  key: offer.key,
  kind: 'offer',
  title: offer.title,
  keywords: [...(offer.keywords ?? []), offer.detail ?? ''],
  offer,
})

/**
 * What the + menu lists, given what is typed in its field and which kind it has gone on to.
 *
 * To start with, a short list that stays as it is: uploading, then what whoever offers them says
 * to open with (`suggested`): the formats, what can be set up, and a handful of the services
 * that are connected most. Then the ways on to all the skills, where there are any or they are
 * still being read (`loading`), and to all the connections.
 *
 * Gone on to a kind (`list`), all of it: the skills, those chosen last first as `commands` come,
 * then the app's own commands, such as Compact; or every service.
 *
 * Once something is typed, what fits it, best first, found as search finds things: by its title,
 * and by what else it is known by, such as a skill's description or a service's kinds. Of
 * everything there is, templates included, or of the kind gone on to.
 */
export const composerAddEntries = (
  { commands, offers = [], upload, loading = false }: { commands: readonly ComposerCommand[]; offers?: readonly ComposerAddOffer[]; upload: boolean; loading?: boolean },
  query: string,
  list?: ComposerAddList,
): ComposerAddEntry[] => {
  const skills = commands.filter(({ kind }) => kind === 'skill').map(commandEntry)
  const builtins = commands.filter(({ kind }) => kind !== 'skill').map(commandEntry)
  const offered = (group: ComposerAddOffer['group']) => offers.filter((offer) => offer.group === group).map(offerEntry)
  const connections = offered('connection')

  if (list) return searchMatches(query, list === 'skill' ? [...skills, ...builtins] : connections)

  const uploading: ComposerAddEntry = { key: 'upload', kind: 'upload', title: 'Upload files or photos', keywords: ['attach', 'image', 'picture'], disabled: !upload }
  if (query.trim()) {
    return searchMatches(query, [uploading, ...offered('format'), ...offered('setup'), ...connections, ...skills, ...offered('template'), ...builtins])
  }

  return [
    uploading,
    ...offers.filter(({ suggested }) => suggested).map(offerEntry),
    ...(skills.length || loading ? [{ key: 'all:skill', kind: 'all' as const, list: 'skill' as const, title: 'See all skills…' }] : []),
    ...(connections.length ? [{ key: 'all:connection', kind: 'all' as const, list: 'connection' as const, title: 'See all connections…' }] : []),
  ]
}

// The keys that move a cursor about what is written, or take from it, rather than write.
const WRITING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'PageUp', 'PageDown'])

/**
 * What a key pressed in the menu's field does, beyond what the field and its list do themselves
 * (typing, the arrows, Enter): Tab chooses the row that is highlighted, as Enter does.
 * Gone on to a kind, Escape goes back, as does Backspace with nothing typed to take a letter
 * from. Otherwise Escape, and a Tab with nothing to choose, are left to close the menu, and
 * everything else is kept from it, which would take letters for its own items' names.
 *
 * Opened by something typed in the draft (`tentative`), it is only in the way of whoever meant
 * what they typed: until something is typed in it, Backspace takes that back (`undo`), and
 * a key that only moves about what is written leaves the menu for the draft (`leave`).
 */
export const composerAddKey = (
  key: string,
  { highlighted, onList = false, typed = false, tentative = false }: { highlighted: ComposerAddEntry | undefined; onList?: boolean; typed?: boolean; tentative?: boolean },
): 'choose' | 'back' | 'close' | 'keep' | 'undo' | 'leave' => {
  if (key === 'Tab') return highlighted && !(highlighted.kind === 'upload' && highlighted.disabled) ? 'choose' : 'close'
  if (onList && (key === 'Escape' || (key === 'Backspace' && !typed))) return 'back'
  if (tentative && !onList && !typed) {
    if (key === 'Backspace') return 'undo'
    if (WRITING_KEYS.has(key)) return 'leave'
  }
  return key === 'Escape' ? 'close' : 'keep'
}

/**
 * Whether a menu opened by something typed in the draft gives way to the draft, for what is then
 * typed in its field: a space straight away, as after a slash that was meant as one, or words
 * that find nothing in it, which were being written, not looked for. Not while its skills are
 * still being read, when it cannot tell.
 */
export const composerAddGivesWay = (source: Parameters<typeof composerAddEntries>[0], query: string) =>
  /^\s/.test(query) || (query.trim() !== '' && !source.loading && composerAddEntries(source, query).length === 0)
