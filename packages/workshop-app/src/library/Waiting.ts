import type { OutputSummary } from '@gadgets/workshop-shared/api'

/** What waits on the user to approve across their gadgets. */
export type WaitingSnapshot = {
  /** How many changes, in all. */
  total: number
  /** How many gadgets they are from. */
  gadgets: number
}

/** Whether the page is in sight, and word of when that changes. */
export type PageSight = {
  hidden: () => boolean
  /** Calls `changed` whenever it is shown or hidden, until the returned function is called. */
  watch: (changed: () => void) => () => void
}

export type WaitingOptions = {
  /** How long between reads while the page is in sight. */
  everyMs?: number
  /** The document's, by default. */
  sight?: PageSight
}

const documentSight: PageSight = {
  hidden: () => document.hidden,
  watch: (changed) => {
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  },
}

const EVERY_MS = 30_000
const EMPTY: WaitingSnapshot = { total: 0, gadgets: 0 }

/** What the user can decide: a gadget's changes, unless they only use its workspace. */
export const waitingOn = (output: Partial<Pick<OutputSummary, 'role' | 'waiting'>>) => (output.role === 'use' ? 0 : output.waiting ?? 0)

/**
 * How much the user's gadgets have waiting on them to approve, across every workspace, for the
 * sidebar to say so wherever they are. Nothing tells the app when a gadget starts to wait, so it
 * is read from the Library's index (`listOutputs`, `OutputSummary.waiting`) when started, when the
 * page comes back into sight, every so often while it is in sight, and when asked, as after a
 * decision. A read that fails keeps what was shown. Observable through `subscribe`/`getSnapshot`.
 */
export class Waiting {
  #snapshot: WaitingSnapshot = EMPTY
  #listeners = new Set<() => void>()
  #timer: ReturnType<typeof setInterval> | undefined
  #run = 0
  #unwatch: (() => void) | undefined

  constructor(
    private readonly read: () => Promise<{ outputs: OutputSummary[] }>,
    private readonly options: WaitingOptions = {},
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  start() {
    this.stop()
    this.#run++
    void this.refresh()
    this.#timer = setInterval(() => {
      if (!this.#sight.hidden()) void this.refresh()
    }, this.options.everyMs ?? EVERY_MS)
    this.#unwatch = this.#sight.watch(() => {
      if (!this.#sight.hidden()) void this.refresh()
    })
  }

  stop() {
    this.#run++
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#unwatch?.()
    this.#unwatch = undefined
  }

  /** Reads it again now. */
  refresh = async () => {
    const run = this.#run
    try {
      const { outputs } = await this.read()
      if (run !== this.#run) return
      const counts = outputs.map(waitingOn).filter((count) => count > 0)
      const next = { total: counts.reduce((sum, count) => sum + count, 0), gadgets: counts.length }
      if (next.total === this.#snapshot.total && next.gadgets === this.#snapshot.gadgets) return
      this.#snapshot = next
      for (const listener of this.#listeners) listener()
    } catch {
      // Read again on the next turn; what is shown stays.
    }
  }

  get #sight() {
    return this.options.sight ?? documentSight
  }
}
