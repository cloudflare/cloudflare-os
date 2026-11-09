import { afterEach, beforeEach, expect, it } from 'vitest'
import { cdp } from 'vitest/browser'
import type { AdminPasskeyChallenge } from '@gadgets/workshop-shared/api'
import { assertPasskey, createPasskey, PasskeyCeremonyError } from './passkeyCeremony'

// The DevTools commands that put a virtual authenticator in place of the platform's. The Playwright
// provider types the whole session, but its types bring Node's into a program that is checked
// against a browser's alone, so the commands sent here are typed by hand. cdp() throws where the
// provider has no DevTools session, which fails the test with the provider's own message.
type WebAuthnSession = {
  send(method: 'WebAuthn.enable' | 'WebAuthn.disable'): Promise<unknown>
  send(method: 'WebAuthn.addVirtualAuthenticator', params: { options: Record<string, unknown> })
    : Promise<{ authenticatorId: string }>
  send(method: 'WebAuthn.removeVirtualAuthenticator', params: { authenticatorId: string }): Promise<unknown>
}
const webAuthn = () => cdp() as WebAuthnSession

let authenticatorId: string | undefined

const removeAuthenticator = async () => {
  if (authenticatorId === undefined) return
  await webAuthn().send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
  authenticatorId = undefined
}

// An authenticator that holds resident keys and verifies its user without a prompt.
beforeEach(async () => {
  await webAuthn().send('WebAuthn.enable')
  ;({ authenticatorId } = await webAuthn().send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }))
})

afterEach(async () => {
  await removeAuthenticator()
  await webAuthn().send('WebAuthn.disable')
})

const bytesOf = (base64Url: string) =>
  Uint8Array.from(atob(base64Url.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))

const clientDataOf = (base64Url: string): { type: string; challenge: string; origin: string } =>
  JSON.parse(new TextDecoder().decode(bytesOf(base64Url)))

// The bit of an authenticator's flags byte, which follows the 32-byte relying party hash, that
// says the user was verified.
const USER_VERIFIED = 0x04

const challengeFor = (challenge: string, credentialIds: string[], secondsLeft = 60): AdminPasskeyChallenge => ({
  challenge,
  rpId: location.hostname,
  credentialIds,
  expiresAt: new Date(Date.now() + secondsLeft * 1000),
})

// Thirty-two bytes each, as the unpadded base64url a browser writes them back in.
const ENROLMENT_CHALLENGE = 'ZW5yb2xtZW50LWNoYWxsZW5nZS0wMTIzNDU2Nzg5YWI'
const REMOVAL_CHALLENGE = 'cmVtb3ZhbC1jaGFsbGVuZ2UtMDEyMzQ1Njc4OWFiY2Q'

const enrol = () => createPasskey(
  challengeFor(ENROLMENT_CHALLENGE, []), { id: 'alice@example.com', name: 'Alice' }, 'Example OS')

it('creates a passkey and then confirms a challenge with it', async () => {
  const registration = await enrol()

  expect(clientDataOf(registration.clientDataJSON)).toMatchObject({
    type: 'webauthn.create', challenge: ENROLMENT_CHALLENGE, origin: location.origin,
  })
  expect(bytesOf(registration.authenticatorData)[32] & USER_VERIFIED).toBe(USER_VERIFIED)
  expect([-7, -257]).toContain(registration.publicKeyAlgorithm)
  expect(bytesOf(registration.publicKey).length).toBeGreaterThan(0)

  const assertion = await assertPasskey(challengeFor(REMOVAL_CHALLENGE, [registration.credentialId]))

  expect(assertion.credentialId).toBe(registration.credentialId)
  expect(clientDataOf(assertion.clientDataJSON)).toMatchObject({
    type: 'webauthn.get', challenge: REMOVAL_CHALLENGE, origin: location.origin,
  })
  expect(bytesOf(assertion.authenticatorData)[32] & USER_VERIFIED).toBe(USER_VERIFIED)
  expect(bytesOf(assertion.signature).length).toBeGreaterThan(0)
})

it('refuses to enrol an authenticator that holds one of the excluded passkeys', async () => {
  const registration = await enrol()

  const failure = await createPasskey(
    challengeFor(ENROLMENT_CHALLENGE, [registration.credentialId]),
    { id: 'alice@example.com', name: 'Alice' }, 'Example OS',
  ).then(() => undefined, (err: unknown) => err)

  expect(failure).toBeInstanceOf(PasskeyCeremonyError)
  expect((failure as PasskeyCeremonyError).reason).toBe('failed')
  expect((failure as PasskeyCeremonyError).cause).toMatchObject({ name: 'InvalidStateError' })
})

it('gives up when no authenticator answers before the challenge expires', async () => {
  const registration = await enrol()
  await removeAuthenticator()

  const failure = await assertPasskey(challengeFor(REMOVAL_CHALLENGE, [registration.credentialId], 2))
    .then(() => undefined, (err: unknown) => err)

  expect(failure).toBeInstanceOf(PasskeyCeremonyError)
  expect(['cancelled', 'failed']).toContain((failure as PasskeyCeremonyError).reason)
})
