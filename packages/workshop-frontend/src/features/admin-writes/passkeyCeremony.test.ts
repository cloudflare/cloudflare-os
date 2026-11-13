// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminPasskeyChallenge } from '@gadgets/workshop-shared/api'
import { assertPasskey, createPasskey, PasskeyCeremonyError } from './passkeyCeremony'

const NOW = Date.UTC(2026, 0, 15, 12)

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const bytesOf = (source: BufferSource) =>
  [...new Uint8Array(ArrayBuffer.isView(source) ? source.buffer : source)]

// The values below are chosen so that their standard base64 holds "+", "/" and padding, which
// unpadded base64url writes differently: [0xfb, 0xff] is "+/8=" there and "-_8" here.
const CHALLENGE: AdminPasskeyChallenge = {
  challenge: 'AQID-_8',
  rpId: 'workshop.example',
  credentialIds: ['-_8', 'BAUG'],
  expiresAt: new Date(NOW + 90_000),
}
const USER = { id: 'alice@example.com', name: 'Alice' }

const create = vi.fn<(options: CredentialCreationOptions) => Promise<unknown>>()
const get = vi.fn<(options: CredentialRequestOptions) => Promise<unknown>>()

const attestation = (response: object = {}) => ({
  rawId: bytes(0xfb, 0xff),
  response: {
    clientDataJSON: bytes(1, 2, 3),
    getAuthenticatorData: () => bytes(4, 5),
    getPublicKey: () => bytes(6),
    getPublicKeyAlgorithm: () => -257,
    ...response,
  },
})

const failureOf = (ceremony: Promise<unknown>) =>
  ceremony.then(() => { throw new Error('the ceremony answered') }, (err: unknown) => err as PasskeyCeremonyError)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  vi.stubGlobal('PublicKeyCredential', vi.fn<() => void>())
  vi.stubGlobal('navigator', { credentials: { create, get } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  create.mockReset()
  get.mockReset()
})

describe('createPasskey', () => {
  it('asks for a verified passkey on the challenge, for the user, excluding their others', async () => {
    create.mockResolvedValue(attestation())

    await createPasskey(CHALLENGE, USER, 'Example OS')

    const { publicKey } = create.mock.calls[0][0]
    expect(publicKey).toMatchObject({
      rp: { id: 'workshop.example', name: 'Example OS' },
      user: { name: 'alice@example.com', displayName: 'Alice' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none',
      timeout: 90_000,
    })
    expect(bytesOf(publicKey!.challenge)).toEqual([1, 2, 3, 0xfb, 0xff])
    expect(publicKey!.excludeCredentials!.map(({ type, id }) => ({ type, id: bytesOf(id) }))).toEqual([
      { type: 'public-key', id: [0xfb, 0xff] },
      { type: 'public-key', id: [4, 5, 6] },
    ])
    // A user handle may hold 64 bytes at most, whatever the length of the user id.
    const handle = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alice@example.com'))
    expect(bytesOf(publicKey!.user.id)).toEqual(bytesOf(handle))
    expect(bytesOf(publicKey!.user.id)).toHaveLength(32)
  })

  it('reads the registration from the credential, as unpadded base64url', async () => {
    create.mockResolvedValue(attestation())

    expect(await createPasskey(CHALLENGE, USER, 'Example OS')).toEqual({
      credentialId: '-_8',
      clientDataJSON: 'AQID',
      authenticatorData: 'BAU',
      publicKey: 'Bg',
      publicKeyAlgorithm: -257,
    })
  })

  it.each([
    { missing: 'getPublicKey' },
    { missing: 'getPublicKeyAlgorithm' },
    { missing: 'getAuthenticatorData' },
  ])('is unsupported where the response has no $missing()', async ({ missing }) => {
    create.mockResolvedValue(attestation({ [missing]: undefined }))

    expect((await failureOf(createPasskey(CHALLENGE, USER, 'Example OS'))).reason).toBe('unsupported')
  })

  it('is unsupported where the browser cannot hand over the public key', async () => {
    create.mockResolvedValue(attestation({ getPublicKey: () => null }))

    expect((await failureOf(createPasskey(CHALLENGE, USER, 'Example OS'))).reason).toBe('unsupported')
  })

  it('fails, keeping the browser\'s error, for an authenticator that is already enrolled', async () => {
    const refusal = new DOMException('The authenticator holds an excluded credential.', 'InvalidStateError')
    create.mockRejectedValue(refusal)

    const failure = await failureOf(createPasskey(CHALLENGE, USER, 'Example OS'))

    expect(failure).toBeInstanceOf(PasskeyCeremonyError)
    expect(failure.reason).toBe('failed')
    expect(failure.cause).toBe(refusal)
    expect(failure.message).toBe('The authenticator holds an excluded credential.')
  })
})

describe('assertPasskey', () => {
  it('asks for a verified assertion on the challenge by one of the passkeys it lists', async () => {
    get.mockResolvedValue({
      rawId: bytes(4, 5, 6),
      response: { clientDataJSON: bytes(0xfb, 0xff), authenticatorData: bytes(1, 2, 3), signature: bytes(6) },
    })

    const assertion = await assertPasskey(CHALLENGE)

    const { publicKey } = get.mock.calls[0][0]
    expect(publicKey).toMatchObject({ rpId: 'workshop.example', userVerification: 'required', timeout: 90_000 })
    expect(bytesOf(publicKey!.challenge)).toEqual([1, 2, 3, 0xfb, 0xff])
    expect(publicKey!.allowCredentials!.map(({ type, id }) => ({ type, id: bytesOf(id) }))).toEqual([
      { type: 'public-key', id: [0xfb, 0xff] },
      { type: 'public-key', id: [4, 5, 6] },
    ])
    expect(assertion).toEqual({
      credentialId: 'BAUG',
      clientDataJSON: '-_8',
      authenticatorData: 'AQID',
      signature: 'Bg',
    })
  })

  it('leaves no time to a challenge that has expired', async () => {
    get.mockRejectedValue(new DOMException('Timed out.', 'NotAllowedError'))

    await failureOf(assertPasskey({ ...CHALLENGE, expiresAt: new Date(NOW - 1) }))

    expect(get.mock.calls[0][0].publicKey!.timeout).toBe(0)
  })

  it.each([
    { thrown: () => new DOMException('Dismissed.', 'NotAllowedError'), reason: 'cancelled' },
    { thrown: () => new DOMException('Aborted.', 'AbortError'), reason: 'cancelled' },
    { thrown: () => new DOMException('Not this origin.', 'SecurityError'), reason: 'failed' },
    { thrown: () => new TypeError('Not an option.'), reason: 'failed' },
  ])('is $reason for what the browser threw', async ({ thrown, reason }) => {
    get.mockRejectedValue(thrown())

    expect((await failureOf(assertPasskey(CHALLENGE))).reason).toBe(reason)
  })

  it('fails when the browser answers with no credential', async () => {
    get.mockResolvedValue(null)

    expect((await failureOf(assertPasskey(CHALLENGE))).reason).toBe('failed')
  })
})

describe('a browser without passkeys', () => {
  it('is unsupported without PublicKeyCredential, and asks for nothing', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined)

    expect((await failureOf(createPasskey(CHALLENGE, USER, 'Example OS'))).reason).toBe('unsupported')
    expect((await failureOf(assertPasskey(CHALLENGE))).reason).toBe('unsupported')
    expect(create).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('is unsupported without a credential container', async () => {
    vi.stubGlobal('navigator', {})

    expect((await failureOf(createPasskey(CHALLENGE, USER, 'Example OS'))).reason).toBe('unsupported')
    expect((await failureOf(assertPasskey(CHALLENGE))).reason).toBe('unsupported')
  })
})
