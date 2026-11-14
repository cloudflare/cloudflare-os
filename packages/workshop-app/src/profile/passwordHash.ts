import { SERVICE_SALT } from '@gadgets/workshop-shared/api'

/**
 * A password hashed as sign-in hashes it (`PublicApi.login`): Argon2id, salted with the service's
 * salt and the user's id. The hashing library is imported only when a password is changed, so
 * its WASM stays out of the app's first load.
 */
export const hashPassword = async (userId: string, password: string): Promise<Uint8Array> => {
  const { argon2id } = await import('hash-wasm')
  const id = new TextEncoder().encode(userId)
  const salt = new Uint8Array(SERVICE_SALT.length + id.length)
  salt.set(SERVICE_SALT)
  salt.set(id, SERVICE_SALT.length)
  return argon2id({ password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' })
}
