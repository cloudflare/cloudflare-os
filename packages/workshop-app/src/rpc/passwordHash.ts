import { SERVICE_SALT } from '@gadgets/workshop-shared/api'

/**
 * The hash `PublicApi.login` and `createAccount` take in place of the password. hash-wasm is
 * imported on demand, so its WASM is only fetched to sign in.
 */
export const hashPassword = async (username: string, password: string) => {
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
