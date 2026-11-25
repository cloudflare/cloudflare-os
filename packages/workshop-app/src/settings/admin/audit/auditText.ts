import {
  ADMIN_ACCESS_ERROR_CODES,
  type AdminAccessRecord,
  type AdminAuditKind,
  type AdminSettingChange,
  type AdminVia,
  type AdminWorkspaceAccess,
} from '@gadgets/workshop-shared/api'
import type { AuditSettings } from './auditSettings'

// What the Audit part says of what the log holds, in main's Audit tab's words. Plain, so that the
// rules for what a change and a value are called can be tested without drawing them.

/** Each level of admin access to a workspace or a user's account. */
export const ACCESS_LEVEL_NAMES: Record<AdminWorkspaceAccess, string> = {
  off: 'Off',
  metadata: 'Metadata',
}

/** Each reason an admin's call into a workspace or a user's account was refused. */
export const REFUSAL_NAMES: Record<NonNullable<AdminAccessRecord['refused']>, string> = {
  [ADMIN_ACCESS_ERROR_CODES.accessOff]: 'Access off',
}

/** Each kind of record. */
export const KIND_NAMES: Record<AdminAuditKind, string> = {
  workspace: 'Workspace access',
  user: 'User access',
  write: 'Workspace write',
  setting: 'Setting change',
}

/** How an admin's calls reached the deployment. */
export const VIA_NAMES: Record<AdminVia, string> = { api: 'API', cli: 'CLI' }

// The settings kept as lists of entries with ids, whose change with no key is a change of order.
const ORDERED_SETTING_NAMES = new Map([
  ['formats', 'formats'],
  ['addedModels', 'added models'],
])

// The settings that are an order themselves, by what they order.
const ORDER_SETTING_NAMES = new Map([
  ['providerOrder', 'providers'],
  ['modelOrder', 'models'],
])

const NUMBER = new Intl.NumberFormat('en')

/** What a setting change changed: the setting, and the entry of it where it has entries, or the order it is or holds. */
export const changeName = (change: AdminSettingChange) => {
  const order = ORDER_SETTING_NAMES.get(change.setting)
  const setting = order === undefined ? change.setting : `Order of ${order}`
  if (change.key !== undefined) return `${setting} · ${change.key}`
  if (order !== undefined) return setting
  const ordered = ORDERED_SETTING_NAMES.get(change.setting)
  return ordered === undefined ? change.setting : `Order of ${ordered}`
}

/** Where an excerpt of a long value starts, and how long the values it was cut from are. */
export const excerptLabel = ({ offset, beforeLength, afterLength }: NonNullable<AdminSettingChange['excerpt']>) => {
  const length = (characters: number | undefined) => (characters === undefined ? '—' : NUMBER.format(characters))
  return `Excerpt from character ${NUMBER.format(offset + 1)} · ${length(beforeLength)} → ${length(afterLength)} characters`
}

// Past this many characters or lines, a value may not fit the lines it is cut to.
const CLAMP_CHARACTERS = 480
const CLAMP_LINES = 6

/** Whether a value may be longer than the lines it is cut to, and so has the way to show it whole. */
export const mayOverflow = (value: string) => value.length > CLAMP_CHARACTERS || value.split('\n').length > CLAMP_LINES

/**
 * A value recorded as JSON (an object or a list) laid out one field to a line. A setting that is
 * text is recorded as itself and may hold JSON too, so only the compact form a value that is not
 * text is recorded in is laid out: what an admin wrote as JSON, spaced or on several lines, is
 * shown as written, and so are excerpts and values such as "42".
 */
export const layOut = (value: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  if (typeof parsed !== 'object' || parsed === null || JSON.stringify(parsed) !== value) return value
  return JSON.stringify(parsed, null, 2)
}

/**
 * What inspection access is, and what limits it: the deployment's maximum where that allows
 * none, and where it holds the level an admin chose down, how to make that level the admins' own.
 */
export const accessHelp = ({ chosen, effective, max }: AuditSettings['adminWorkspaceAccess']): string[] => {
  const help = [
    'Whether an admin may inspect a workspace or a user’s account. Metadata shows a workspace’s ' +
      'structure and withholds chat messages, messages queued for an agent, attachments, file ' +
      'contents, commit messages, the arguments of calls queued for an agent, the configuration ' +
      'an agent suggested for a connection, which blueprint a gadget follows, the ids of the ' +
      'blueprints a workspace publishes, and the descriptions and fields of actions, ' +
      'observations and hooks. Titles, file names, commit authors, share links’ notes, blueprint ' +
      'descriptions, and the names and hashes of attachments stay, and can echo content. Of a ' +
      'user’s account, Metadata withholds what each connected account’s gatekeeper says of it ' +
      '(its names, avatar and what it grants) and the ids of the user’s blueprints. Off refuses ' +
      'inspection, and reaches views already open within about a minute.',
  ]
  if (max === 'off') {
    help.push('This deployment’s ADMIN_WORKSPACE_ACCESS_MAX allows no inspection (a value that is not a level counts as off).')
  }
  if (chosen !== effective) {
    help.push(
      `The level set here is ${ACCESS_LEVEL_NAMES[chosen]}, which that maximum limits to ${ACCESS_LEVEL_NAMES[effective]}. ` +
        `Set ${ACCESS_LEVEL_NAMES[effective]} here, so that a higher maximum does not raise it.`,
    )
  }
  return help
}
