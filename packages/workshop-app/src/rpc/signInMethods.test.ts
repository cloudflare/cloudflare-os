import { describe, expect, it } from 'vitest'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import { signInMethods } from './signInMethods'

const GOOGLE = { vendorId: 'google', displayName: 'Google' }

const config = (overrides: Partial<ServerConfig>) => ({ authVendors: [], passwordAuthEnabled: true, signupsEnabled: true, ...overrides }) as ServerConfig

describe('signInMethods', () => {
  it('offers a password, and the way to make an account, where the deployment takes new ones', () => {
    expect(signInMethods(config({}), 'signIn')).toEqual({ password: true, vendors: [], signUpOffered: true, signUpClosed: false })
    expect(signInMethods(config({}), 'signUp')).toEqual({ password: true, vendors: [], signUpOffered: false, signUpClosed: false })
  })

  it('offers each service the deployment allows, beside the password or alone', () => {
    expect(signInMethods(config({ authVendors: [GOOGLE] }), 'signIn')).toMatchObject({ password: true, vendors: [GOOGLE] })
    expect(signInMethods(config({ authVendors: [GOOGLE], passwordAuthEnabled: false }), 'signIn'))
      .toEqual({ password: false, vendors: [GOOGLE], signUpOffered: false, signUpClosed: false })
  })

  it('offers no new account where the deployment takes none, and says so to whoever asks for one', () => {
    expect(signInMethods(config({ signupsEnabled: false }), 'signIn')).toMatchObject({ password: true, signUpOffered: false })
    expect(signInMethods(config({ signupsEnabled: false, authVendors: [GOOGLE] }), 'signUp'))
      .toEqual({ password: false, vendors: [GOOGLE], signUpOffered: false, signUpClosed: true })
  })

  it('makes no account with a password where there is no password sign-in', () => {
    expect(signInMethods(config({ authVendors: [GOOGLE], passwordAuthEnabled: false }), 'signUp')).toMatchObject({ password: false, signUpClosed: false })
  })
})
