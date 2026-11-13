export type ConnectionNoticeSnapshot =
  | { status: 'hidden' }
  | {
      status: 'reconnecting'
      /**
       * How many times, since the connection was lost, something asked for could not be done:
       * whoever shows it takes each as a fresh alarm. Coming up on its own is not one.
       */
      alarms: number
      /** It has been a while: the server may be down rather than the connection dropped. */
      long: boolean
      /** The browser says this device has no network. */
      offline: boolean
    }
  | { status: 'reconnected' }

/** Most drops are over within this, so nothing is said of them. */
export const SHOW_AFTER = 1000
/** After this the connection is no longer taken to be coming straight back. */
export const LONG_AFTER = 30_000
/** How long being back is said for. */
export const BACK_FOR = 2000

const HIDDEN: ConnectionNoticeSnapshot = { status: 'hidden' }
const RECONNECTED: ConnectionNoticeSnapshot = { status: 'reconnected' }

/**
 * What the user is told about the app's connection to the backend while it is made again, and
 * whether what they ask for meanwhile can be done. Observable through `subscribe`/`getSnapshot`
 * (for `useSyncExternalStore`).
 *
 * A drop is only said once it has lasted a moment. Put away (`dismiss`), it stays away until
 * something asked for cannot be done for it (`blocked`), which brings it back as a fresh alarm.
 * Once the connection is back that is said, briefly, if it was showing or if anything was asked
 * for meanwhile; a drop nobody noticed ends as quietly as it began.
 */
export class ConnectionNotice {
  #snapshot: ConnectionNoticeSnapshot = HIDDEN
  #listeners = new Set<() => void>()
  #down = false
  #dismissed = false
  // Something was asked for while it was down: whoever asked is waiting to hear it is back.
  #waited = false
  #long = false
  #offline = false
  #alarms = 0
  #timers: ReturnType<typeof setTimeout>[] = []

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  /** The connection is being made again: nothing asked for can be done meanwhile. */
  get down() {
    return this.#down
  }

  /** The connection was lost. */
  lost() {
    if (this.#down) return
    this.#down = true
    this.#dismissed = false
    this.#waited = false
    this.#long = false
    this.#alarms = 0
    this.#clearTimers()
    // Lost again while saying it was back, it carries straight on.
    if (this.#snapshot.status === 'reconnected') this.#publish(this.#reconnecting())
    else this.#after(SHOW_AFTER, () => {
      if (this.#snapshot.status === 'hidden' && !this.#dismissed) this.#publish(this.#reconnecting())
    })
    this.#after(LONG_AFTER, () => {
      this.#long = true
      this.#update()
    })
  }

  /** The connection is back, and signed in. */
  restored() {
    if (!this.#down) return
    this.#down = false
    this.#clearTimers()
    if (this.#snapshot.status !== 'reconnecting' && !this.#waited) return this.#publish(HIDDEN)
    this.#publish(RECONNECTED)
    this.#after(BACK_FOR, () => this.#publish(HIDDEN))
  }

  setOffline(offline: boolean) {
    if (offline === this.#offline) return
    this.#offline = offline
    this.#update()
  }

  /** Puts it away: while still down, until something cannot be done for it. */
  dismiss = () => {
    if (this.#snapshot.status === 'hidden') return
    if (this.#snapshot.status === 'reconnecting') this.#dismissed = true
    this.#publish(HIDDEN)
  }

  /**
   * To be asked before doing what the user asked for: whether it cannot be done, as the connection
   * is down, in which case they are told so again and should be left as they were (a draft kept).
   */
  blocked = (): boolean => {
    if (!this.#down) return false
    this.#waited = true
    this.#alarms++
    this.#dismissed = false
    this.#publish(this.#reconnecting())
    return true
  }

  /** Publishes what changed, while it is showing that it is reconnecting. */
  #update() {
    if (this.#snapshot.status === 'reconnecting') this.#publish(this.#reconnecting())
  }

  #reconnecting(): ConnectionNoticeSnapshot {
    return { status: 'reconnecting', alarms: this.#alarms, long: this.#long, offline: this.#offline }
  }

  #after(delay: number, run: () => void) {
    this.#timers.push(setTimeout(run, delay))
  }

  #clearTimers() {
    for (const timer of this.#timers.splice(0)) clearTimeout(timer)
  }

  #publish(snapshot: ConnectionNoticeSnapshot) {
    if (snapshot === this.#snapshot) return
    this.#snapshot = snapshot
    this.#listeners.forEach((listener) => listener())
  }
}
