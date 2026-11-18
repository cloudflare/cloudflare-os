import type { LoginAttempt } from '@gadgets/workshop-shared/api'

/** What `GatekeeperSignIn` needs of the public API (`PublicApi.startGatekeeperLogin`). */
export type GatekeeperSignInApi = {
  startGatekeeperLogin(vendorId: string): Promise<{ url: string; nonce: string; attempt: Pick<LoginAttempt, 'receive'> & Disposable }>
}

/** The window a sign-in is finished in, as far as this needs it. */
export type SignInWindow = { readonly closed: boolean; close: () => void }

export type GatekeeperSignInState = {
  /**
   * The service being signed in with, while its window is open or its token is being collected:
   * no other sign-in can be started meanwhile.
   */
  readonly pending: string | null
  /** Why the last sign-in did not work, until the next is started. */
  readonly problem: string | null
}

export type GatekeeperSignInOptions = {
  api: GatekeeperSignInApi
  /** Opens the service's sign-in in a window given the flow's nonce (`openHandoffWindow`). Throws when it cannot. */
  openWindow: (url: string, nonce: string) => SignInWindow
  /** Given the session token once a sign-in has finished. */
  onToken: (token: string) => void
  /** How often the attempt is asked whether its token has been released. */
  pollMs?: number
}

// What an attempt's promise rejects with when it is put away from outside (a newer attempt, or
// `dispose`) rather than failing: there is then nothing to say.
const CANCELLED = Symbol('sign-in cancelled')
const RECEIVE_POLL_MS = 1000

/**
 * Signs in with a service (an authentication gatekeeper, `ServerConfig.authVendors`). Ported from
 * `workshop-frontend`'s `OAuthButtons`, without the native app's path.
 *
 * Starting one asks the backend for an attempt and opens the service's sign-in in a window that is
 * given the attempt's nonce. The window ends on `/connect/handoff`, which confirms the ticket with
 * the nonce over the public API (`SignInHandoffPane`); that is what ties the sign-in to this
 * browser, as the sign-in's address alone can be finished by anyone. Meanwhile the attempt is
 * asked every second for the token (`LoginAttempt.receive()`), which it releases once the ticket is
 * confirmed, and only to whoever holds it: the window never sees the token.
 *
 * Only one attempt is asked at a time. A newer one waits for the one before to hear back from a
 * `receive()` it has under way before putting it away: the server releases the token only once,
 * so one put away while being answered could lose a token already handed out, and the user would
 * have to sign in twice.
 *
 * Observable through `subscribe`/`getSnapshot` (for `useSyncExternalStore`).
 */
export class GatekeeperSignIn {
  #state: GatekeeperSignInState = { pending: null, problem: null }
  #listeners = new Set<() => void>()
  // Puts away the attempt under way, once a `receive()` it has under way is answered, and
  // resolves to whether it received the token, in which case it finishes the sign-in itself.
  #putAway: (() => Promise<boolean>) | null = null
  #disposed = false
  readonly #options: GatekeeperSignInOptions

  constructor(options: GatekeeperSignInOptions) {
    this.#options = options
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#state

  /** Signs in with `vendorId`. Resolves once it is over, however it went. */
  start = async (vendorId: string) => {
    if (this.#disposed) return
    // Nothing else can be started from now, while the attempt before hears back.
    this.#set({ pending: vendorId, problem: this.#state.problem })
    if (await this.#putAway?.()) return
    if (this.#disposed) return
    this.#set({ pending: vendorId, problem: null })
    try {
      const token = await this.#attempt(vendorId)
      if (!this.#disposed) this.#options.onToken(token)
    } catch (error) {
      if (error === CANCELLED || this.#disposed) return
      this.#set({ pending: null, problem: error instanceof Error ? error.message : 'Couldn’t sign in.' })
    }
  }

  /** Stops asking for the token of the attempt under way, as when the page that showed it goes. */
  dispose() {
    this.#disposed = true
    void this.#putAway?.()
    this.#putAway = null
  }

  async #attempt(vendorId: string): Promise<string> {
    const { url, nonce, attempt } = await this.#options.api.startGatekeeperLogin(vendorId)
    const disposeAttempt = () => {
      try {
        attempt[Symbol.dispose]()
      } catch {
        // Already disposed.
      }
    }
    if (this.#disposed) {
      disposeAttempt()
      throw CANCELLED
    }
    let window: SignInWindow
    try {
      window = this.#options.openWindow(url, nonce)
    } catch (error) {
      disposeAttempt()
      throw error
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false
      let received = false
      // The `receive()` under way, as a promise that settles once its answer has been dealt with
      // here, and never rejects.
      let inflight: Promise<void> | null = null
      const finish = (end: () => void) => {
        if (settled) return
        settled = true
        this.#putAway = null
        clearInterval(poll)
        try {
          window.close()
        } catch {
          // Already gone.
        }
        disposeAttempt()
        end()
      }
      const poll = setInterval(() => {
        // Not necessarily given up on: the window closes itself once confirmed, and a service that
        // swaps browsing context groups (COOP) reports it closed while the sign-in goes on. So
        // the buttons are given back and the attempt is still asked. One really closed sends
        // nothing, and is put away by the next attempt, or by the server once it expires, which
        // is then said. Not while a `receive()` is under way, which another start would cut off.
        if (window.closed && inflight === null && this.#state.pending === vendorId) this.#set({ pending: null, problem: null })
        if (inflight !== null) return
        inflight = attempt.receive().then(
          (token) => {
            inflight = null
            if (token === null) return
            received = true
            finish(() => resolve(token))
          },
          (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error('Couldn’t sign in.'))),
        )
      }, this.#options.pollMs ?? RECEIVE_POLL_MS)
      this.#putAway = async () => {
        await inflight
        if (!settled) finish(() => reject(CANCELLED))
        return received
      }
    })
  }

  #set(state: GatekeeperSignInState) {
    this.#state = state
    this.#listeners.forEach((listener) => listener())
  }
}
