import type { RpcStub } from 'capnweb'
import { SERVICE_SALT, type PublicApi } from '@gadgets/workshop-shared/api'
import { storeToken } from './token'

/** Opt-in, development only: set `VITE_DEV_AUTO_LOGIN=true` (e.g. in `.env.local`). */
export const devAutoLoginEnabled = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTO_LOGIN === 'true'

// Same derivation as the sign-in forms (see `PublicApi.login`). Imported on demand so the WASM
// never reaches a production bundle.
const hashPassword = async (username: string, password: string) => {
  const { argon2id } = await import('hash-wasm')
  const usernameBytes = new TextEncoder().encode(username)
  const salt = new Uint8Array(SERVICE_SALT.length + usernameBytes.length)
  salt.set(SERVICE_SALT)
  salt.set(usernameBytes, SERVICE_SALT.length)
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: 'binary',
  })
}

/**
 * Signs in as the dev account, creating it on a fresh backend. Returns the stored token, or null
 * when the backend refuses password sign-in.
 */
export const devAutoLogin = async (publicApi: RpcStub<PublicApi>): Promise<string | null> => {
  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'
  const passwordHash = await hashPassword(username, password)
  const token =
    (await publicApi.createAccount(username, username, passwordHash)) ??
    (await publicApi.login(username, passwordHash))
  if (token) storeToken(token)
  return token
}
