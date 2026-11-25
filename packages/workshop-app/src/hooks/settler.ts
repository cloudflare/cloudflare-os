export type SettlerOptions = {
  /** How long a value must hold still before it is shown, in milliseconds. */
  wait: number
  /** The longest a change waits to be shown, from the first one not yet shown, however often it changes. */
  maxWait: number
}

/**
 * Shows what something has settled on, for something that changes faster than it can be followed.
 * A change is shown once the value has held still for `wait`, unless it has been changing for
 * `maxWait` without a pause, when the latest is shown anyway, so that it can never be held at one
 * thing for as long as it keeps changing. A value that is changed back to what is shown shows
 * nothing at all.
 *
 * What comes first, and what comes after `rest`, is shown at once: there is nothing to follow yet.
 */
export class Settler<T> {
  #shown: T | undefined
  #has = false
  #resting = true
  #pending: T | undefined
  #since = 0
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly options: SettlerOptions,
    private readonly onShow: (value: T) => void,
    private readonly equals: (a: T, b: T) => boolean = Object.is,
  ) {}

  get shown() {
    return this.#shown
  }

  /** The value is now `value`. */
  set(value: T) {
    if (this.#has && this.equals(value, this.#shown as T)) {
      // Back to what is shown: nothing is waiting any longer.
      this.#cancel()
      return
    }
    if (!this.#has || this.#resting) return this.#show(value)
    // Told again of what it is already waiting to show, as a component that renders again tells it:
    // not a change, so it does not make the wait any longer.
    if (this.#timer !== undefined && this.equals(value, this.#pending as T)) return
    const now = Date.now()
    if (this.#timer === undefined) this.#since = now
    else clearTimeout(this.#timer)
    this.#pending = value
    // Held still for `wait`, but not past `maxWait` from the first change that has not been shown.
    this.#timer = setTimeout(() => this.#show(this.#pending as T), Math.max(0, Math.min(this.options.wait, this.#since + this.options.maxWait - now)))
  }

  /** There is nothing to show for now: whatever comes next is shown at once. */
  rest() {
    this.#cancel()
    this.#resting = true
  }

  /** Stop waiting. Nothing more is shown until the next `set`. */
  dispose() {
    this.#cancel()
  }

  #show(value: T) {
    this.#cancel()
    this.#resting = false
    this.#has = true
    this.#shown = value
    this.onShow(value)
  }

  #cancel() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending = undefined
  }
}
