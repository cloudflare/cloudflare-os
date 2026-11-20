import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserPreferences as StoredPreferences, UserPreferencesSubscriber } from '@gadgets/workshop-shared/api'
import { decodePreferences, EMPTY_PREFERENCES, encodePreferences, type AppPreferences } from './preferenceFields'

/**
 * What the server calls with the preferences. A class, because the server must receive a single
 * stub for the object. The server letting go of it (`Symbol.dispose`), which it does when the
 * account restarts and forgets its subscribers, is said through `onReleased`.
 */
class PreferencesListener extends RpcTarget implements UserPreferencesSubscriber {
  constructor(
    private readonly onUpdated: (preferences: StoredPreferences) => void,
    private readonly onReleased: () => void,
  ) {
    super()
  }

  async updated(preferences: StoredPreferences) {
    this.onUpdated(preferences)
  }

  [Symbol.dispose]() {
    this.onReleased()
  }
}

/**
 * The part of the backend the preferences use. The subscribe call takes the listener itself, as a
 * call through a stub does, and its lease must be disposed.
 */
export type PreferencesBackend = {
  subscribe(listener: Parameters<RpcStub<AuthenticatedApi>['subscribeToPreferences']>[0]): Promise<Disposable>
  update(update: StoredPreferences): Promise<void>
}

/** A change to the preferences, made of what they are when it is made. */
export type PreferencesChange = (current: AppPreferences) => Partial<AppPreferences>

// After a subscription fails, it is tried again after these, doubling.
const RETRY_DELAY = { first: 1000, most: 30_000 }

/**
 * What the user last chose in the app, kept in their account (`UserPreferences`), live
 * (`subscribeToPreferences()`), so that what one tab or device chooses reaches the others. Each
 * field is kept as JSON under its own key (see `AppPreferences`), read defensively.
 * Observable through `subscribe`/`getSnapshot`, which is empty until the account has said.
 *
 * A change shows at once, and is sent as the fields it replaces. One made before the account has
 * said on this connection waits for it, so that it is made of what is kept rather than of what
 * was; one made while stopped (no connection) is not made. While changes are on their way, what
 * the account says meanwhile waits too, so that a change does not flicker back; once they have all
 * landed, the latest it said is shown, which a refused change gives way to.
 *
 * A failed subscription is tried again with growing waits, and one the account forgot is made
 * again. Each new connection starts a subscription on this same store, which keeps showing what
 * the account last said meanwhile; a change still on its way over the old one is dropped.
 */
export class UserPreferences {
  #snapshot = EMPTY_PREFERENCES
  #backend: PreferencesBackend | undefined
  // Whether the account has said on this connection.
  #known = false
  // What the account said last, shown once no change is on its way.
  #told: AppPreferences | undefined
  #sending = 0
  #waiting: PreferencesChange[] = []
  #listeners = new Set<() => void>()
  #lease: Promise<Disposable> | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retryDelay = 0
  // Bumped by every subscription and stop(), so a call from an earlier one can tell it is stale.
  #run = 0
  // Bumped by every start() and stop(), so a change sent over an earlier connection can tell.
  #connection = 0

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  /** Makes `change` of the preferences as they are, shows it, and keeps it in the account. */
  change = (change: PreferencesChange) => {
    const backend = this.#backend
    if (!backend) return
    if (!this.#known) {
      this.#waiting.push(change)
      return
    }
    const update = change(this.#snapshot)
    this.#publish({ ...this.#snapshot, ...update })
    const connection = this.#connection
    this.#sending++
    void backend.update(encodePreferences(update)).catch(() => {}).finally(() => {
      if (connection === this.#connection && --this.#sending === 0 && this.#told) this.#publish(this.#told)
    })
  }

  start(backend: PreferencesBackend) {
    this.#backend = backend
    this.#known = false
    this.#retryDelay = 0
    this.#subscribe(backend)
  }

  stop() {
    this.#run++
    this.#connection++
    this.#backend = undefined
    this.#waiting = []
    // What was shown ahead of the account does not carry over to the next connection.
    if (this.#sending > 0 && this.#told) this.#publish(this.#told)
    this.#sending = 0
    clearTimeout(this.#retry)
    this.#releaseLease()
  }

  #subscribe(backend: PreferencesBackend) {
    const run = ++this.#run
    clearTimeout(this.#retry)
    this.#releaseLease()
    let live = false
    let released = false
    const listener = new PreferencesListener(
      (preferences) => {
        if (run !== this.#run) return
        this.#retryDelay = 0
        const told = decodePreferences(preferences)
        this.#told = told
        if (this.#sending === 0) this.#publish(told)
        if (this.#known) return
        this.#known = true
        for (const change of this.#waiting.splice(0)) this.change(change)
      },
      () => {
        released = true
        // Let go of after it took, while still the current one: the account forgot it.
        if (live && run === this.#run) this.#subscribe(backend)
      },
    )
    const lease = backend.subscribe(listener)
    this.#lease = lease
    lease.then(
      () => {
        if (run !== this.#run) return
        live = true
        if (released) this.#subscribe(backend)
      },
      () => {
        if (run !== this.#run) return
        const delay = this.#retryDelay || RETRY_DELAY.first
        this.#retryDelay = Math.min(delay * 2, RETRY_DELAY.most)
        this.#retry = setTimeout(() => {
          if (run === this.#run) this.#subscribe(backend)
        }, delay)
      },
    )
  }

  #releaseLease() {
    void this.#lease?.then((held) => held[Symbol.dispose](), () => {})
    this.#lease = undefined
  }

  #publish(snapshot: AppPreferences) {
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }
}
