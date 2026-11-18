import { describe, expect, it } from 'vitest'
import { keyOf, registrationOf } from './browserPush'

describe('registrationOf', () => {
  it('gives the account the endpoint and the keys, and nothing else', () => {
    const subscription = {
      endpoint: 'https://push.example/1',
      toJSON: () => ({ endpoint: 'https://push.example/1', expirationTime: null, keys: { p256dh: 'p', auth: 'a', extra: 'x' } }),
    }
    expect(registrationOf(subscription)).toEqual({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } })
  })
})

describe('keyOf', () => {
  it('says the key a subscription was made with as the deployment gives it, in base64url', () => {
    const key = new Uint8Array([0xfb, 0xff, 0xfe, 0x01]).buffer
    expect(keyOf({ options: { applicationServerKey: key, userVisibleOnly: true } })).toBe('-__-AQ')
  })
})
