import {
  ADMIN_GRANT_LIFETIME_SECONDS,
  getAdminAccessErrorCode,
  getAdminGrantErrorCode,
} from '@gadgets/workshop-shared/api'

/** How long a grant lasts, in hours, as the admin pages say it. */
export const GRANT_HOURS = ADMIN_GRANT_LIFETIME_SECONDS / 3600

/**
 * The server's own message for a refusal it names by code (an admin access or grant refusal),
 * which says what the admin can do about it. Undefined for any other failure.
 */
export const adminRefusalMessage = (err: unknown): string | undefined => {
  const code = getAdminAccessErrorCode(err) ?? getAdminGrantErrorCode(err)
  return code !== undefined && err instanceof Error ? err.message : undefined
}

/** The id of the admin panel's list of pending approvals, which a link to it names. */
export const PENDING_APPROVALS_ID = 'pending-approvals'
