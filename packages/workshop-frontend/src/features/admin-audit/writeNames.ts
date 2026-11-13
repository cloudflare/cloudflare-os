import type { BadgeVariant } from '@cloudflare/kumo'
import type { AdminPasskeyRefusal, AdminWriteRecord } from '@gadgets/workshop-shared/api'

/** What the Audit tab calls each step of an admin write to a workspace. */
export const WRITE_EVENT_NAMES: Record<AdminWriteRecord['event'], string> = {
  requested: 'Requested',
  refused: 'Refused',
  approved: 'Approved',
  applied: 'Applied',
  failed: 'Failed',
  denied: 'Denied',
  expired: 'Expired',
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
}

/** What the Audit tab says of each check a refused approval attempt failed. */
export const PASSKEY_REFUSAL_NAMES: Record<AdminPasskeyRefusal, string> = {
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
}
