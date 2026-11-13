import { ADMIN_ACCESS_ERROR_CODES, type AdminAccessRecord, type AdminWorkspaceAccess } from '@gadgets/workshop-shared/api'

/** What the Audit tab calls each level of admin access to a workspace or a user's account. */
export const ACCESS_LEVEL_NAMES: Record<AdminWorkspaceAccess, string> = {
  off: 'Off',
  metadata: 'Metadata',
}

/** What the Audit tab calls each reason an admin call into a workspace or a user's account was
 * refused. */
export const REFUSAL_NAMES: Record<NonNullable<AdminAccessRecord['refused']>, string> = {
  [ADMIN_ACCESS_ERROR_CODES.accessOff]: 'Access off',
}

// The name `names` gives `value`, or `value` itself when it gives none. An own-property test, so
// that a value such as "constructor" finds no name on Object.prototype.
const nameIn = (names: Record<string, string>, value: string) =>
  Object.hasOwn(names, value) ? names[value] : value

/** The name of the level a record holds. The log returns each record as it is stored, so a value
 * that is not a level is shown as it is. */
export function accessLevelName(access: string): string {
  return nameIn(ACCESS_LEVEL_NAMES, access)
}

/** The name of the refusal a record holds, or the code itself when it has no name. */
export function refusalName(code: string): string {
  return nameIn(REFUSAL_NAMES, code)
}
