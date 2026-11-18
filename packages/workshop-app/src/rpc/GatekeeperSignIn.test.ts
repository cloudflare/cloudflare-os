import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatekeeperSignIn, type GatekeeperSignInApi, type SignInWindow } from './GatekeeperSignIn'

const POLL = 1000

// An attempt the test answers: each `receive()` waits for `answer` (null until the window has
// confirmed the ticket) or `fail`.
const fakeAttempt = () => {
  const pending: { resolve: (token: string | null) => void; reject: (error: Error) => void }[] = []
  const attempt = {
    receive: vi.fn<() => Promise<string | null>>(() => new Promise<string | null>((resolve, reject) => pending.push({ resolve, reject }))),
    [Symbol.dispose]: vi.fn<() => void>(),
    answer: (token: string | null) => pending.shift()!.resolve(token),
    fail: (message: string) => pending.shift()!.reject(new Error(message)),
  }
  return attempt
}
type FakeAttempt = ReturnType<typeof fakeAttempt>

const setUp = ({ open = (): SignInWindow => ({ closed: false, close: vi.fn<() => void>() }) } = {}) => {
  const attempts: FakeAttempt[] = []
  const api: GatekeeperSignInApi = {
    startGatekeeperLogin: vi.fn<GatekeeperSignInApi['startGatekeeperLogin']>(async (vendorId) => {
      const attempt = fakeAttempt()
      attempts.push(attempt)
      return { url: `https://${vendorId}.example/sign-in`, nonce: 'n'.repeat(64), attempt }
    }),
  }
  const windows: { url: string; nonce: string; window: SignInWindow }[] = []
  const tokens: string[] = []
  const signIn = new GatekeeperSignIn({
    api,
    openWindow: (url, nonce) => {
      const window = open()
      windows.push({ url, nonce, window })
      return window
    },
    onToken: (token) => tokens.push(token),
    pollMs: POLL,
  })
  return { signIn, api, attempts, windows, tokens }
}

// Lets the promises the class is waiting on settle, then moves the clock on by `ms`.
const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('GatekeeperSignIn', () => {
  it('opens the service’s sign-in with the nonce, then asks for the token until it is released', async () => {
    const { signIn, attempts, windows, tokens } = setUp()
    void signIn.start('google')
    await tick()

    expect(windows).toEqual([{ url: 'https://google.example/sign-in', nonce: 'n'.repeat(64), window: expect.anything() }])
    expect(signIn.getSnapshot()).toEqual({ pending: 'google', problem: null })

    await tick(POLL)
    attempts[0].answer(null)
    await tick(POLL)
    attempts[0].answer('the-token')
    await tick()

    expect(tokens).toEqual(['the-token'])
    expect(windows[0].window.close).toHaveBeenCalled()
    expect(attempts[0][Symbol.dispose]).toHaveBeenCalled()
  })

  it('does not ask again while it is still waiting for an answer', async () => {
    const { signIn, attempts } = setUp()
    void signIn.start('google')
    await tick(POLL * 3)
    expect(attempts[0].receive).toHaveBeenCalledOnce()
  })

  it('says why it failed, and gives the buttons back', async () => {
    const { signIn, attempts, windows } = setUp()
    void signIn.start('google')
    await tick(POLL)
    attempts[0].fail('The sign-in expired.')
    await tick()

    expect(signIn.getSnapshot()).toEqual({ pending: null, problem: 'The sign-in expired.' })
    expect(windows[0].window.close).toHaveBeenCalled()
    expect(attempts[0][Symbol.dispose]).toHaveBeenCalled()
  })

  it('says so when the window cannot be opened, and lets the attempt go', async () => {
    const { signIn, attempts } = setUp({ open: () => { throw new Error('The pop-up was blocked.') } })
    await signIn.start('google')

    expect(signIn.getSnapshot()).toEqual({ pending: null, problem: 'The pop-up was blocked.' })
    expect(attempts[0][Symbol.dispose]).toHaveBeenCalled()
  })

  it('gives the buttons back once the window is closed, and still asks, as it may only look closed', async () => {
    const window = { closed: false, close: vi.fn<() => void>() }
    const { signIn, attempts, tokens } = setUp({ open: () => window })
    void signIn.start('google')
    await tick(POLL)
    attempts[0].answer(null)
    window.closed = true
    await tick(POLL)

    expect(signIn.getSnapshot().pending).toBeNull()
    attempts[0].answer('the-token')
    await tick()
    expect(tokens).toEqual(['the-token'])
  })

  it('puts away the attempt before when another is started, once its answer is in', async () => {
    const { signIn, attempts, tokens } = setUp()
    void signIn.start('google')
    await tick(POLL)
    // The first attempt is being answered as the second is started.
    void signIn.start('github')
    await tick()
    expect(signIn.getSnapshot().pending).toBe('github')
    expect(attempts).toHaveLength(1)

    attempts[0].answer(null)
    await tick()
    expect(attempts[0][Symbol.dispose]).toHaveBeenCalled()
    expect(attempts).toHaveLength(2)
    expect(tokens).toEqual([])
  })

  it('starts nothing more when the attempt before is answered with the token as another is started', async () => {
    const { signIn, attempts, tokens } = setUp()
    void signIn.start('google')
    await tick(POLL)
    void signIn.start('github')
    attempts[0].answer('the-token')
    await tick()

    expect(tokens).toEqual(['the-token'])
    expect(attempts).toHaveLength(1)
  })

  it('stops asking once disposed, and gives no token that arrives after', async () => {
    const { signIn, attempts, tokens } = setUp()
    void signIn.start('google')
    await tick(POLL)
    signIn.dispose()
    attempts[0].answer('the-token')
    await tick(POLL * 2)

    expect(tokens).toEqual([])
    expect(attempts[0].receive).toHaveBeenCalledOnce()
    expect(attempts[0][Symbol.dispose]).toHaveBeenCalled()
  })
})
