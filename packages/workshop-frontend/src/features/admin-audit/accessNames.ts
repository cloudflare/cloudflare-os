import { ADMIN_ACCESS_ERROR_CODES, type AdminAccessRecord, type AdminWorkspaceAccess } from '@gadgets/workshop-shared/api'

/** What the Audit tab calls each level of admin access to a workspace or a user's account. */
export const ACCESS_LEVEL_NAMES: Record<AdminWorkspaceAccess, string> = {
  off: 'Off',
  metadata: 'Metadata only',
  full: 'Full',
}

/** What the Audit tab calls each reason an admin call into a workspace or a user's account was
 * refused. */
export const REFUSAL_NAMES: Record<NonNullable<AdminAccessRecord['refused']>, string> = {
  [ADMIN_ACCESS_ERROR_CODES.contentWithheld]: 'Content withheld',
  [ADMIN_ACCESS_ERROR_CODES.accessOff]: 'Access off',
}
