import { composeCodeChange, type CodeChange } from '@gadgets/workshop-shared/code-change'
import type { EpochCode } from './epochCode'

/** One change of a chat's stream as the server took it (`AiChatSubscriber.changeApplied`). */
export type StreamRow = {
  generation: number
  revision: number
  change: CodeChange
  /** Which client sent it, and its number there, where one did: how a client knows its own. */
  submission?: { clientId: string; seq: number }
}

/** What happened to the stream, in the order it happened. */
export type StreamEvent =
  /** A change was taken, on top of everything before it. */
  | { type: 'row'; row: StreamRow }
  /**
   * The chat's changes were kept: its content carries on as it was, but over the commits the keep
   * made, but for the gadgets in `discontinuous`, whose content the keep changed.
   */
  | { type: 'kept'; discontinuous: readonly number[] }
  /**
   * It started over from the history, without changes it had not had as rows: what was discarded
   * (`discarded`, a destructive bump), or else what it could not follow, such as what was recorded
   * while it was not listening. Anything worked out over the old one is lost.
   */
  | { type: 'reset'; discarded: boolean }

const NONE: readonly StreamEvent[] = []
const key = (generation: number, revision: number) => `${generation}:${revision}`

/**
 * A chat's change stream as far as the server has taken it, for one client: its changes since they
 * were last kept as one change over each gadget's pin, through `revision` of `generation`. It is
 * the history's (`EpochCode`) with each row after it on top, and never reads a file, as changes
 * compose without the text they apply to.
 *
 * Rows come in order, but not always before what they need: before the history, or past a gap, or
 * of the generation that follows a keep before the rows that close the one before it. Those wait
 * until they apply. A row already had is let go. Until the history is had there is no stream.
 */
export class ChangeStream {
  #ready = false
  #generation = 0
  #revision = 0
  #history: CodeChange = {}
  #through = 0
  // The rows after the history's, in order.
  #rows: StreamRow[] = []
  #change: CodeChange | undefined = {}
  #held = new Map<string, StreamRow>()
  // A keep that closed this generation, which is gone on to once its last row is had.
  #closing: { finalRevision: number; next: EpochCode } | undefined

  get ready() {
    return this.#ready
  }

  get generation() {
    return this.#generation
  }

  get revision() {
    return this.#revision
  }

  /** Everything taken, as one change. */
  get change(): CodeChange {
    this.#change ??= this.#rows.reduce((made, { change }) => composeCodeChange(made, change), this.#history)
    return this.#change
  }

  /** Rows wait that cannot be taken yet: a gap, or the rest of a generation a keep closed. */
  get stalled() {
    return this.#closing !== undefined || [...this.#held.values()].some(({ generation }) => generation === this.#generation)
  }

  /** It waits for the last rows of a generation a keep closed. */
  get closing() {
    return this.#closing !== undefined
  }

  /**
   * Stops waiting for the last rows of the generation a keep closed, which may never come, as
   * after a reconnect, which replays only the current generation's: it starts over from the
   * history that followed the keep.
   */
  abandonClosing(): readonly StreamEvent[] {
    const closing = this.#closing
    if (!closing) return NONE
    this.#closing = undefined
    this.#start(closing.next)
    return [{ type: 'reset', discarded: false }, ...this.#drain()]
  }

  /** The history as it is read again: what started the stream, a keep, or a discard. */
  history(history: EpochCode): readonly StreamEvent[] {
    if (!this.#ready) {
      this.#start(history)
      return this.#drain()
    }
    if (history.generation < this.#generation) return NONE
    if (history.generation === this.#generation) {
      if (this.#closing) return NONE
      if (history.rowsThrough < this.#through) return NONE
      // It took in rows that never came as rows: they were recorded while nobody here listened.
      if (history.rowsThrough > this.#revision) {
        this.#start(history)
        return [{ type: 'reset', discarded: false }, ...this.#drain()]
      }
      this.#history = history.change
      this.#through = history.rowsThrough
      this.#rows = this.#rows.filter(({ revision }) => revision > history.rowsThrough)
      this.#change = undefined
      return NONE
    }
    // A keep that closed this generation: its last rows come first, then the next.
    if (history.prior?.generation === this.#generation) {
      this.#closing = { finalRevision: history.prior.finalRevision, next: history }
      return this.#drain()
    }
    this.#closing = undefined
    this.#start(history)
    // With no `prior`, the bump threw the old stream's changes away; with another's, it was missed.
    return [{ type: 'reset', discarded: history.prior === undefined }, ...this.#drain()]
  }

  row(row: StreamRow): readonly StreamEvent[] {
    if (this.#ready && (row.generation < this.#generation || (row.generation === this.#generation && row.revision <= this.#revision))) return NONE
    this.#held.set(key(row.generation, row.revision), row)
    return this.#ready ? this.#drain() : NONE
  }

  #start({ generation, change, rowsThrough }: EpochCode) {
    this.#ready = true
    this.#generation = generation
    this.#revision = rowsThrough
    this.#history = change
    this.#through = rowsThrough
    this.#rows = []
    this.#change = undefined
    for (const [found, row] of this.#held) if (row.generation < generation || (row.generation === generation && row.revision <= rowsThrough)) this.#held.delete(found)
  }

  // Takes what waited and now applies, in order, going on to the next generation where a keep
  // closed this one.
  #drain(): StreamEvent[] {
    const events: StreamEvent[] = []
    for (;;) {
      const closing = this.#closing
      if (closing && this.#revision >= closing.finalRevision) {
        this.#closing = undefined
        this.#start(closing.next)
        events.push({ type: 'kept', discontinuous: closing.next.prior?.discontinuousGadgets ?? [] })
        continue
      }
      const next = this.#held.get(key(this.#generation, this.#revision + 1))
      if (!next) return events
      this.#held.delete(key(next.generation, next.revision))
      this.#revision = next.revision
      this.#rows.push(next)
      this.#change = undefined
      events.push({ type: 'row', row: next })
    }
  }
}
