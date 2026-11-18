import { describe, expect, it, vi } from 'vitest'
import { createAccountWithPassword, signInWithPassword } from './passwordSignIn'

// The hash itself is `passwordHash.ts`'s, and slow: what matters here is that it is what is sent.
vi.mock('./passwordHash', () => ({ hashPassword: async (username: string, password: string) => new TextEncoder().encode(`${username}:${password}`) }))
const hashOf = (username: string, password: string) => new TextEncoder().encode(`${username}:${password}`)

describe('signInWithPassword', () => {
  it('sends the hash, never the password, and gives the token', async () => {
    const login = vi.fn<(username: string, hash: Uint8Array) => Promise<string | null>>(async () => 'the-token')
    expect(await signInWithPassword({ login }, 'ada', 'analytical')).toEqual({ token: 'the-token' })
    expect(login).toHaveBeenCalledExactlyOnceWith('ada', hashOf('ada', 'analytical'))
  })

  it('says so when the username or password is wrong, or the server refuses', async () => {
    expect(await signInWithPassword({ login: async () => null }, 'ada', 'wrong')).toEqual({ problem: 'Invalid username or password' })
    expect(await signInWithPassword({ login: async () => { throw new Error('Password sign-in is turned off.') } }, 'ada', 'x'))
      .toEqual({ problem: 'Password sign-in is turned off.' })
  })
})

describe('createAccountWithPassword', () => {
  it('names the account by its username, and gives the token', async () => {
    const createAccount = vi.fn<(username: string, name: string, hash: Uint8Array) => Promise<string | null>>(async () => 'the-token')
    expect(await createAccountWithPassword({ createAccount }, 'ada', 'analytical')).toEqual({ token: 'the-token' })
    expect(createAccount).toHaveBeenCalledExactlyOnceWith('ada', 'ada', hashOf('ada', 'analytical'))
  })

  it('says so when the username is taken, or the server refuses', async () => {
    expect(await createAccountWithPassword({ createAccount: async () => null }, 'ada', 'analytical')).toEqual({ problem: 'Username already exists' })
    expect(await createAccountWithPassword({ createAccount: async () => { throw new Error('Signups are closed.') } }, 'ada', 'analytical'))
      .toEqual({ problem: 'Signups are closed.' })
  })
})
