import type { RpcStub } from 'capnweb'
import type { GatekeeperUserSelection, GatekeeperUserSelectionReceiver } from '@gadgets/workshop-shared/gatekeeper'

// The Workshop's person picker over a gatekeeper's app (`GatekeeperAppHost.selectUsers`): the app
// is given a single-use ticket for each person chosen, made for it by the Workshop
// (`createGatekeeperUserSelection`), never what the directory says of them. Ported from
// `workshop-frontend`'s `SandboxedGatekeeperApp` and `GatekeeperUserPickerDialog`, one person at a time.

/** Said to the app of a person chosen after the picker was given up on. */
const CANCELLED = 'Person selection cancelled. A delivery may already have been accepted.'

/** The most people chosen at once: the directory leaves out at most 1,000, who chooses among them. */
export const MAX_PICKED_PEOPLE = 999

/** The picker an app has open: what it gives each person chosen to, until it is closed. */
export class OpenPicker {
  #closed = false
  readonly #deliveries = new Set<Promise<void> & Disposable>()

  constructor(
    /** Tells one opening from the next, for a dialog to be keyed by. */
    readonly id: number,
    private readonly receiver: RpcStub<GatekeeperUserSelectionReceiver>,
    private readonly resolve: () => void,
  ) {}

  /** Gives the app a person chosen, resolving once it has taken them; it says why when it will not. */
  async deliver(selection: GatekeeperUserSelection): Promise<void> {
    if (this.#closed) throw new Error(CANCELLED)
    const delivery = this.receiver.receive(selection)
    this.#deliveries.add(delivery)
    try {
      await delivery
    } finally {
      if (this.#deliveries.delete(delivery)) delivery[Symbol.dispose]()
    }
  }

  /** Closes it, letting go of what it held, and tells the app; what it already took stays taken. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.receiver[Symbol.dispose]()
    for (const delivery of this.#deliveries) delivery[Symbol.dispose]()
    this.#deliveries.clear()
    this.resolve()
  }

  get closed() {
    return this.#closed
  }
}

/** The one picker an app may have open at a time, for `useSyncExternalStore`. */
export class UserPickers {
  #open: OpenPicker | undefined
  #opened = 0
  readonly #listeners = new Set<() => void>()

  /** Opens one that gives each person chosen to `receiver`, which it then owns; resolves once it closes. Throws while one is open. */
  open(receiver: RpcStub<GatekeeperUserSelectionReceiver>): Promise<void> {
    if (this.#open && !this.#open.closed) throw new Error('A person picker is already open.')
    let resolve!: () => void
    const closed = new Promise<void>((done) => {
      resolve = done
    })
    const picker = new OpenPicker(++this.#opened, receiver, () => {
      resolve()
      if (this.#open !== picker) return
      this.#open = undefined
      this.#publish()
    })
    this.#open = picker
    this.#publish()
    return closed
  }

  /** Closes the one open, without waiting on what it is giving the app. */
  cancel() {
    this.#open?.close()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#open

  #publish() {
    for (const listener of this.#listeners) listener()
  }
}

/** Who has been chosen in an open picker, and what it says meanwhile. */
export type PickingState = {
  /** Those the app has taken, by the name the Workshop gave it for them. */
  picked: { id: string; name: string }[]
  /** Who is being made a ticket for, or given the app. */
  pending: string | undefined
  /** Why the last person chosen was not added. */
  notice: string | undefined
  /** Who was added last, said aloud. */
  announcement: string
  /** Done was chosen while someone was still being added, and it closes once they are. */
  closing: boolean
}

/** A ticket being made, which is let go of once it is in or no longer wanted. */
export type Minting = Promise<GatekeeperUserSelection | null> & Disposable

/**
 * What is chosen in one open picker, for `useSyncExternalStore`: one person at a time is made a
 * ticket for (`mint`) and given the app (`OpenPicker.deliver`), and is added once the app has
 * taken them. Done waits for whoever is being added, so that the app has everyone chosen before
 * `selectUsers()` resolves; one that fails stops it, so that what went wrong is seen.
 */
export class PersonPicking {
  #state: PickingState = { picked: [], pending: undefined, notice: undefined, announcement: '', closing: false }
  #minting: Minting | undefined
  readonly #listeners = new Set<() => void>()

  constructor(private readonly picker: OpenPicker, private readonly mint: (userId: string) => Minting) {}

  /** Adds whoever `userId` is, by `name` until the Workshop names them. */
  async pick(userId: string, name: string) {
    const { picked, pending, closing } = this.#state
    if (this.picker.closed || pending !== undefined || closing) return
    if (picked.some(({ id }) => id === userId)) return this.#set({ notice: `${name} is added already.` })
    if (picked.length >= MAX_PICKED_PEOPLE) return this.#set({ notice: `You can choose up to ${MAX_PICKED_PEOPLE} people at once. Close and open the picker again to go on.` })
    this.#set({ pending: userId, notice: undefined })
    const minting = this.mint(userId)
    this.#minting = minting
    let added = false
    try {
      // Let go of once it is in, unless `cancel` let go of it first.
      const selection = await minting.finally(() => {
        if (this.#minting !== minting) return
        this.#minting = undefined
        minting[Symbol.dispose]()
      })
      if (this.picker.closed) return
      if (!selection) return this.#set({ notice: `${name} can no longer be chosen. Try searching again.`, closing: false })
      await this.picker.deliver(selection)
      if (this.picker.closed) return
      added = true
      const { displayName } = selection.profile
      this.#set({ picked: [...this.#state.picked, { id: userId, name: displayName }], announcement: `Added ${displayName}` })
    } catch (error) {
      if (this.picker.closed) return
      // The app's own message, where it threw one, is for the user.
      const message = error instanceof Error ? error.message : ''
      this.#set({ notice: message ? `${name}: ${message}` : `Couldn’t add ${name}. Try again.`, closing: false })
    } finally {
      if (!this.picker.closed) {
        this.#set({ pending: undefined })
        if (added && this.#state.closing) this.picker.close()
      }
    }
  }

  /** Done: closes once whoever is being added is in. */
  close() {
    if (this.#state.pending === undefined) return this.picker.close()
    this.#set({ closing: true })
  }

  /** Closes at once, without waiting on whoever is being added, whom the app may have taken already. */
  cancel() {
    this.#minting?.[Symbol.dispose]()
    this.#minting = undefined
    this.picker.close()
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#state

  #set(change: Partial<PickingState>) {
    this.#state = { ...this.#state, ...change }
    for (const listener of this.#listeners) listener()
  }
}
