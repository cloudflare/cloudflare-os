import {
  ADMIN_ACCESS_ERROR_CODES,
  type AdminAccessRecord,
  type AdminViewAccess,
  type AdminWorkspaceAccess,
} from '@gadgets/workshop-shared/api'

/** What the Audit tab calls each level of admin access to a workspace or a user's account. */
export const ACCESS_LEVEL_NAMES: Record<AdminWorkspaceAccess, string> = {
  off: 'Off',
  metadata: 'Metadata',
  content: 'Content',
}

/** What the Audit tab calls each reason an admin call into a workspace or a user's account was
 * refused. */
export const REFUSAL_NAMES: Record<NonNullable<AdminAccessRecord['refused']>, string> = {
  [ADMIN_ACCESS_ERROR_CODES.accessOff]: 'Access off',
  [ADMIN_ACCESS_ERROR_CODES.contentOff]: 'Content off',
  [ADMIN_ACCESS_ERROR_CODES.contentNotRequested]: 'Content not requested',
  [ADMIN_ACCESS_ERROR_CODES.grantRequired]: 'No grant',
}

/**
 * What a record's view was opened for, as its details say it: nothing for "metadata", which a view
 * is opened for unless content is asked for, and nothing for a record stored without the field.
 */
export function openedForName(requested: AdminViewAccess | undefined): string | undefined {
  return !requested || requested === 'metadata' ? undefined : ACCESS_LEVEL_NAMES[requested]
}

/** What the access level's help says of Content. */
export const CONTENT_ACCESS_HELP =
  'Content lets an admin also read what Metadata withholds of a workspace, but only under a live ' +
  'grant: one the workspace’s owner gave, or one a second admin approved. Never ' +
  'without one. Each such read is recorded here with the grant it ran under.'

/** What the help adds while the deployment's maximum keeps Content from being chosen. */
export const CONTENT_ABOVE_MAX_HELP =
  'Content cannot be chosen here: only this deployment’s ADMIN_WORKSPACE_ACCESS_MAX can allow it.'
