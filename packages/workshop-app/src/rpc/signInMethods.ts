import type { AuthVendorInfo, ServerConfig } from '@gadgets/workshop-shared/api'
import type { SignInMode } from '@/blocks/SignInForm'

/** What the sign-in page offers, for what the deployment allows (`signInMethods`). */
export type SignInMethods = {
  /** A username and password: to sign in with, or to make an account with. */
  password: boolean
  /** The services that can be signed in with, each a button. */
  vendors: AuthVendorInfo[]
  /** Signing in: the way to make an account instead. */
  signUpOffered: boolean
  /** Making an account: the deployment takes no new ones, which is said. */
  signUpClosed: boolean
}

/**
 * What the sign-in page offers in `mode`, as the deployment says (`PublicApi.getServerConfig`): a
 * password where it has password sign-in, the services it allows, and a new account only where it
 * takes them. A new account is made with a password: a service makes one by signing in with it.
 */
export const signInMethods = (config: ServerConfig, mode: SignInMode): SignInMethods => {
  const vendors = config.authVendors ?? []
  return mode === 'signIn'
    ? { password: config.passwordAuthEnabled, vendors, signUpOffered: config.passwordAuthEnabled && config.signupsEnabled, signUpClosed: false }
    : { password: config.passwordAuthEnabled && config.signupsEnabled, vendors, signUpOffered: false, signUpClosed: !config.signupsEnabled }
}
