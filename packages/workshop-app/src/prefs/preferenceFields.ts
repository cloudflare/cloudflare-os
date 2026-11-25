import type { UserPreferences as StoredPreferences } from '@gadgets/workshop-shared/api'
import { isRecord } from './stored'

/** The most commands `AppPreferences.recentCommands` holds. */
export const MAX_RECENT_COMMANDS = 20

/** The most pages `AppPreferences.asideShown` holds. */
export const MAX_ASIDE_SHOWN = 100

/** The most saves `AppPreferences.savedExports` holds. */
export const MAX_SAVED_EXPORTS = 100

/** The most outputs `AppPreferences.starredOutputs` holds. */
export const MAX_STARRED_OUTPUTS = 200

/** The most outputs `AppPreferences.openedOutputs` holds. */
export const MAX_OPENED_OUTPUTS = 50

/** The most workspaces `AppPreferences.starredWorkspaces` holds. */
export const MAX_STARRED_WORKSPACES = 200

/** The most workspaces `AppPreferences.workspaceLooks` holds. */
export const MAX_WORKSPACE_LOOKS = 200

/** The longest string the app keeps in a preference, keys included, in UTF-16 code units. */
export const MAX_PREFERENCE_LENGTH = 2048

/** Names one output of the user's library: its workspace, and its workpiece there, as on `OutputSummary`. */
export type OutputRef = { workspaceId: string; workpieceId: number }

/**
 * The shapes a workspace's icon can be drawn as, in the order they are offered in. The folder is
 * first: it is the one until another is chosen.
 */
export const WORKSPACE_ICON_SHAPES = ['folder', 'briefcase', 'notepad', 'stack', 'window', 'house', 'building', 'rocket', 'cloud', 'cone', 'bulb', 'robot'] as const

/** One of `WORKSPACE_ICON_SHAPES`. */
export type WorkspaceIconShape = typeof WORKSPACE_ICON_SHAPES[number]

/**
 * The colours a workspace's icon can be drawn in, in the order they are offered in. The first, the
 * page's opposite, is the one until another is chosen.
 */
export const WORKSPACE_ICON_COLORS = ['contrast', 'red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink'] as const

/** One of `WORKSPACE_ICON_COLORS`. */
export type WorkspaceIconColor = typeof WORKSPACE_ICON_COLORS[number]

/** How a workspace's icon is drawn: as what, and in which colour. What is left out is the first of each. */
export type WorkspaceLook = { shape?: WorkspaceIconShape; color?: WorkspaceIconColor }

/**
 * The file a save of a gadget's export last made in one of the user's accounts, which a later save
 * can replace (see `AppPreferences.savedExports`).
 */
export type SavedExport = {
  /** The connected account it was saved to, as `AuthenticatedApi.saveFile()` names it. */
  accountId: number
  /** Where the file is, as `AuthenticatedApi.saveFile()` returned it. */
  url: string
  /** The file's name. */
  name: string
}

/**
 * What the app keeps in the user's account (`UserPreferences`), each field as JSON text under its
 * own key. Each map is in the order its entries were last set, least recent first, so the oldest
 * can be dropped to stay within bounds.
 */
export type AppPreferences = {
  /** The skills and commands chosen last in a composer, each by its key, latest first. At most MAX_RECENT_COMMANDS. */
  recentCommands: string[]
  /**
   * What was last shown beside each page, as its `?open=` value, by page: a workspace's own page
   * by its id, a chat's by `<workspaceId>/<chatId>`. At most MAX_ASIDE_SHOWN.
   */
  asideShown: Record<string, string>
  /** The file each kind of save of a gadget's export last made, by `savedExportKey`. At most MAX_SAVED_EXPORTS. */
  savedExports: Record<string, SavedExport>
  /**
   * The outputs the user starred, in the order they put them, the latest starred first. One that
   * is not listed is kept, as the library may only not have read it yet. At most MAX_STARRED_OUTPUTS.
   */
  starredOutputs: OutputRef[]
  /** The outputs the user opened last, latest first, each once. At most MAX_OPENED_OUTPUTS. */
  openedOutputs: OutputRef[]
  /**
   * The order the user put their starred workspaces in, as the workspaces' ids. Whether one is
   * starred is the account's (`pinned`): an id here that is not starred is passed over, and one
   * starred that is not here comes first. At most MAX_STARRED_WORKSPACES.
   */
  starredWorkspaces: string[]
  /** How the user has each workspace's icon drawn, by the workspace's id. At most MAX_WORKSPACE_LOOKS. */
  workspaceLooks: Record<string, WorkspaceLook>
}

export const EMPTY_PREFERENCES: AppPreferences = {
  recentCommands: [],
  asideShown: {},
  savedExports: {},
  starredOutputs: [],
  openedOutputs: [],
  starredWorkspaces: [],
  workspaceLooks: {},
}

const isSavedExport = (value: unknown): value is SavedExport =>
  isRecord(value) && typeof value.accountId === 'number' && typeof value.url === 'string' && typeof value.name === 'string'

const isOutputRef = (value: unknown): value is OutputRef =>
  isRecord(value) && typeof value.workspaceId === 'string' && Number.isInteger(value.workpieceId)

const isOneOf = <Value extends string>(values: readonly Value[]) => (value: unknown): value is Value =>
  values.includes(value as Value)
const isShape = isOneOf(WORKSPACE_ICON_SHAPES)
const isColor = isOneOf(WORKSPACE_ICON_COLORS)

// A shape or a colour there no longer is, is left out, which leaves that workspace the first of
// them rather than losing what else was chosen for it.
const lookOf = ({ shape, color }: Record<string, unknown>): WorkspaceLook =>
  ({ shape: isShape(shape) ? shape : undefined, color: isColor(color) ? color : undefined })

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const entriesOf = <Value>(value: unknown, keep: (entry: unknown) => entry is Value): Record<string, Value> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Value] => keep(entry[1]))) : {}

const isString = (value: unknown): value is string => typeof value === 'string'

const listOf = <Value>(value: unknown, keep: (entry: unknown) => entry is Value): Value[] =>
  Array.isArray(value) ? value.filter(keep) : []

/**
 * The app's preferences as kept in the account. Another version of the app may have written them,
 * so what is missing, not JSON, or of another shape reads as empty, and entries of another shape
 * are left out.
 */
export const decodePreferences = (stored: StoredPreferences): AppPreferences => ({
  recentCommands: listOf(parse(stored.recentCommands), isString),
  asideShown: entriesOf(parse(stored.asideShown), isString),
  savedExports: entriesOf(parse(stored.savedExports), isSavedExport),
  starredOutputs: listOf(parse(stored.starredOutputs), isOutputRef),
  openedOutputs: listOf(parse(stored.openedOutputs), isOutputRef),
  starredWorkspaces: listOf(parse(stored.starredWorkspaces), isString),
  workspaceLooks: Object.fromEntries(Object.entries(entriesOf(parse(stored.workspaceLooks), isRecord)).map(([id, look]) => [id, lookOf(look)])),
})

/** `update` as kept in the account: each field it has as JSON text under its own key. */
export const encodePreferences = (update: Partial<AppPreferences>): StoredPreferences =>
  Object.fromEntries(Object.entries(update).map(([key, value]) => [key, JSON.stringify(value)]))
