import type {
  AdminPasskeyAssertion, AdminPasskeyChallenge, AdminPasskeyRegistration,
} from '@gadgets/workshop-shared/api'

/** Why a passkey ceremony gave no answer (see PasskeyCeremonyError). */
export type PasskeyCeremonyFailure = 'unsupported' | 'cancelled' | 'failed'

const FAILURE_MESSAGES: Record<PasskeyCeremonyFailure, string> = {
  unsupported: 'This browser cannot use passkeys here.',
  cancelled: 'The passkey prompt was dismissed or timed out.',
  failed: 'The passkey could not be used.',
}

/**
 * A passkey ceremony that gave no answer. Its `reason` is "unsupported" where the browser lacks
 * WebAuthn or the parts of it the server's verifier relies on, "cancelled" when the person
 * dismissed the prompt or let it time out, and "failed" for anything else. A browser's own error is
 * kept as `cause`, and its message when it has one.
 */
export class PasskeyCeremonyError extends Error {
  readonly reason: PasskeyCeremonyFailure

  constructor(reason: PasskeyCeremonyFailure, cause?: unknown) {
    const browsers = cause instanceof Error || cause instanceof DOMException ? cause.message : ''
    super(browsers || FAILURE_MESSAGES[reason], { cause })
    this.name = 'PasskeyCeremonyError'
    this.reason = reason
  }
}

const toBase64Url = (buffer: ArrayBuffer): string => {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))

const descriptors = (challenge: AdminPasskeyChallenge): PublicKeyCredentialDescriptor[] =>
  challenge.credentialIds.map((id) => ({ type: 'public-key', id: fromBase64Url(id) }))

// The server answers a challenge only until it expires, so the prompt is not left open past that.
const timeLeft = (challenge: AdminPasskeyChallenge): number =>
  Math.max(0, challenge.expiresAt.getTime() - Date.now())

// Runs one ceremony on the browser's credential container and names what stopped it.
const ceremony = async (
  run: (credentials: CredentialsContainer) => Promise<Credential | null>,
): Promise<PublicKeyCredential> => {
  if (window.PublicKeyCredential === undefined || navigator.credentials === undefined) {
    throw new PasskeyCeremonyError('unsupported')
  }
  let credential: Credential | null
  try {
    credential = await run(navigator.credentials)
  } catch (err) {
    const dismissed = err instanceof DOMException
      && (err.name === 'NotAllowedError' || err.name === 'AbortError')
    throw new PasskeyCeremonyError(dismissed ? 'cancelled' : 'failed', err)
  }
  if (credential === null) throw new PasskeyCeremonyError('failed')
  // A request made with `publicKey` options answers with nothing but a PublicKeyCredential.
  return credential as PublicKeyCredential
}

/**
 * Creates a passkey for `user` on this device, answering an enrolment challenge. `siteName` is
 * what the authenticator files the passkey under. User verification is required, no attestation is
 * asked for, and the passkeys the challenge lists are excluded, so one authenticator is not
 * enrolled twice. Rejects with a PasskeyCeremonyError.
 */
export const createPasskey = async (
  challenge: AdminPasskeyChallenge, user: { id: string; name: string }, siteName: string,
): Promise<AdminPasskeyRegistration> => {
  const credential = await ceremony(async (credentials) => credentials.create({
    publicKey: {
      rp: { id: challenge.rpId, name: siteName },
      user: {
        // A user handle holds at most 64 bytes and a user id has no length limit, so the handle is
        // the id's digest.
        id: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.id)),
        name: user.id,
        displayName: user.name,
      },
      challenge: fromBase64Url(challenge.challenge),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      excludeCredentials: descriptors(challenge),
      timeout: timeLeft(challenge),
    },
  }))
  const response = credential.response as AuthenticatorAttestationResponse
  // The server reads the public key as the browser parsed it rather than from the attestation
  // object, which takes these three getters.
  if (typeof response.getAuthenticatorData !== 'function'
      || typeof response.getPublicKey !== 'function'
      || typeof response.getPublicKeyAlgorithm !== 'function') {
    throw new PasskeyCeremonyError('unsupported')
  }
  // Null where the browser does not understand the key's algorithm.
  const publicKey = response.getPublicKey()
  if (publicKey === null) throw new PasskeyCeremonyError('unsupported')
  return {
    credentialId: toBase64Url(credential.rawId),
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.getAuthenticatorData()),
    publicKey: toBase64Url(publicKey),
    publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
  }
}

/**
 * Confirms an approval or a removal challenge with one of the passkeys it lists, user verification
 * required. Rejects with a PasskeyCeremonyError.
 */
export const assertPasskey = async (challenge: AdminPasskeyChallenge): Promise<AdminPasskeyAssertion> => {
  const credential = await ceremony((credentials) => credentials.get({
    publicKey: {
      challenge: fromBase64Url(challenge.challenge),
      rpId: challenge.rpId,
      allowCredentials: descriptors(challenge),
      userVerification: 'required',
      timeout: timeLeft(challenge),
    },
  }))
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    credentialId: toBase64Url(credential.rawId),
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.authenticatorData),
    signature: toBase64Url(response.signature),
  }
}
