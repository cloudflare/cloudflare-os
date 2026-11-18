import type { PublicApi } from '@gadgets/workshop-shared/api'
import { hashPassword } from './passwordHash'

/** What signing in or making an account came to: the session token, or why there is none. */
export type PasswordOutcome = { token: string } | { problem: string }

const failure = (error: unknown, fallback: string): PasswordOutcome => ({ problem: error instanceof Error ? error.message : fallback })

/** Signs in with a username and password (`PublicApi.login`), as `workshop-frontend` does. */
export const signInWithPassword = async (api: Pick<PublicApi, 'login'>, username: string, password: string): Promise<PasswordOutcome> => {
  try {
    const token = await api.login(username, await hashPassword(username, password))
    return token ? { token } : { problem: 'Invalid username or password' }
  } catch (error) {
    return failure(error, 'Login failed')
  }
}

/**
 * Makes an account with a username and password, and signs in to it (`PublicApi.createAccount`).
 * Its display name is its username until the user changes it, as `workshop-frontend` has it.
 */
export const createAccountWithPassword = async (api: Pick<PublicApi, 'createAccount'>, username: string, password: string): Promise<PasswordOutcome> => {
  try {
    const token = await api.createAccount(username, username, await hashPassword(username, password))
    return token ? { token } : { problem: 'Username already exists' }
  } catch (error) {
    return failure(error, 'Account creation failed')
  }
}
