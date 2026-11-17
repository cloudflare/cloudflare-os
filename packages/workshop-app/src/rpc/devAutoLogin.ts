import type { RpcStub } from 'capnweb'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { hashPassword } from './passwordHash'
import { storeToken } from './token'

/**
 * Opt-in, development only: `RpcGate` imports this only with `VITE_DEV_AUTO_LOGIN=true` (e.g. in
 * `.env.local`) under the dev server.
 *
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
