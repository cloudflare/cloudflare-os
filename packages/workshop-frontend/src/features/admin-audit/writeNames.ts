import type { BadgeVariant } from '@cloudflare/kumo'
import type { AdminApprovalRefusal, AdminWriteAction, AdminWriteRecord } from '@gadgets/workshop-shared/api'

// What the Audit tab calls each write an admin can request, in a write record's details.
const WRITE_ACTION_NAMES: Record<AdminWriteAction, string> = {
  stopAgent: 'Stop agent',
  restartWorkspace: 'Restart workspace',
  grantContentAccess: 'Grant content access',
}

/**
 * The name of the write a record holds. The log returns each record as it is stored, so a method
 * that is not a write the API names is shown as it is. An own-property test, so that a method such
 * as "toString" finds no name on Object.prototype.
 */
export function writeActionName(method: string): string {
  return Object.hasOwn(WRITE_ACTION_NAMES, method) ? WRITE_ACTION_NAMES[method as AdminWriteAction] : method
}

/** What the Audit tab calls each step of an admin write to a workspace. */
export const WRITE_EVENT_NAMES: Record<AdminWriteRecord['event'], string> = {
  requested: 'Requested',
  refused: 'Refused',
  approved: 'Approved',
  applied: 'Applied',
  failed: 'Failed',
  denied: 'Denied',
  expired: 'Expired',
  revoked: 'Grant ended',
}

/**
 * The Kumo Badge variant each step is shown with: a step that let the write through reads as a
 * success, one in which an admin stopped it or was stopped as a warning, and a write that failed
 * once approved as an error.
 */
export const WRITE_EVENT_VARIANTS: Record<AdminWriteRecord['event'], BadgeVariant> = {
  requested: 'neutral',
  refused: 'warning',
  approved: 'success',
  applied: 'success',
  failed: 'error',
  denied: 'warning',
  expired: 'outline',
  revoked: 'warning',
}

/** What the Audit tab says of each check a refused approval attempt failed. */
export const PASSKEY_REFUSAL_NAMES: Record<AdminApprovalRefusal, string> = {
  // Also what an approval sent again is refused with: its request is no longer pending.
  challenge: 'No challenge was outstanding (none issued, expired, already answered, or the request ' +
    'no longer pending), or the answer signed another',
  credential: 'Not a passkey this admin enrolled',
  origin: 'Made on another origin',
  relyingParty: 'Signed for another relying party',
  userVerification: 'The authenticator did not verify the user',
  userPresence: 'No user was present',
  signature: 'The signature did not verify',
  counter: 'The signature counter did not rise',
  type: 'The answer was to another kind of ceremony',
  algorithm: 'An unsupported key',
  malformed: 'A malformed answer',
  requester: 'Requested by the same admin',
}
