import type { ChatGadgetPin, CodeChangeSubmission } from '@gadgets/workshop-shared/api'
import { composeCodeChange, transformCodeChange, type CodeChange } from '@gadgets/workshop-shared/code-change'
import type { StreamRow } from './changeStream'

const NOTHING: CodeChange = {}
const empty = (change: CodeChange) => Object.keys(change).length === 0
const without = (change: CodeChange, gadgets: ReadonlySet<number>): CodeChange =>
  Object.fromEntries(Object.entries(change).filter(([gadgetId]) => !gadgets.has(Number(gadgetId))))
// Not `crypto.randomUUID()`, which a page that is not served securely, as the dev server is to a phone, has not.
const randomClientId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * What one client edited of a chat's code that the server has not taken yet, over the stream as
 * the client has it: at most one change sent and not yet answered, and what was edited since,
 * as one change on top of it. The server takes them in its own order, so each change it takes
 * from anyone else moves both on to apply after it (`transformCodeChange`, the server's change
 * first, as it was taken first).
 *
 * The change sent is kept as it was sent, to send again as it is should the sending fail: the
 * server knows a change by its client and number, and takes one changed in between as another.
 *
 * A gadget's first edit here is over the commit it was shown at (`base`), which the change sent
 * declares as its pin where the chat has none yet, and which its edits are shown over meanwhile.
 * A gadget the chat made has no commit, and is declared nothing.
 */
export class LocalEdits {
  #clientId: string
  #seq = 0
  // `answered` once the server said it took it: it is then only waited for, as a row.
  #sent: { submission: CodeChangeSubmission; change: CodeChange; answered: boolean } | undefined
  #pending: CodeChange = NOTHING
  #bases = new Map<number, string>()

  constructor(private readonly newClientId: () => string = randomClientId) {
    this.#clientId = newClientId()
  }

  /** Everything edited here not taken yet, as one change over the stream. */
  get change(): CodeChange {
    if (!this.#sent) return this.#pending
    return empty(this.#pending) ? this.#sent.change : composeCodeChange(this.#sent.change, this.#pending)
  }

  /** Nothing is waiting to be taken. */
  get idle() {
    return !this.#sent && empty(this.#pending)
  }

  /** A change is sent, and not answered yet. */
  get sending() {
    return this.#sent !== undefined
  }

  /** Something was edited that is not sent yet, so that the server cannot have it. */
  get unsent() {
    return !empty(this.#pending)
  }

  /** The change sent has not been answered, so that the server may have it or not. */
  get unanswered() {
    return this.#sent !== undefined && !this.#sent.answered
  }

  /** The commit each gadget's edits here are over, where its first one was over one. */
  get bases(): ReadonlyMap<number, string> {
    return this.#bases
  }

  /** An edit, over what is shown: the stream with `change` on top. */
  add(edit: CodeChange, baseOf: (gadgetId: number) => string | undefined) {
    if (empty(edit)) return
    // First, as it throws for an edit that does not fit, which then changes nothing.
    this.#pending = composeCodeChange(this.#pending, edit)
    for (const key of Object.keys(edit)) {
      const gadgetId = Number(key)
      const base = this.#bases.has(gadgetId) ? undefined : baseOf(gadgetId)
      if (base !== undefined) this.#bases.set(gadgetId, base)
    }
  }

  /**
   * What is next to send, over `revision` of `generation`, declaring a pin for each gadget it
   * changes that `pinned` says the chat has none for: the change that was sent again, where its
   * sending failed, else all that was edited since once that one has come back, else nothing.
   */
  next(generation: number, revision: number, pinned: (gadgetId: number) => boolean): CodeChangeSubmission | undefined {
    if (this.#sent) return this.#sent.answered ? undefined : this.#sent.submission
    if (empty(this.#pending)) return undefined
    const pins: ChatGadgetPin[] = Object.keys(this.#pending).map(Number).flatMap((gadgetId) => {
      const baseCommit = this.#bases.get(gadgetId)
      return baseCommit === undefined || pinned(gadgetId) ? [] : [{ gadgetId, baseCommit }]
    })
    const submission: CodeChangeSubmission = {
      generation,
      revision,
      clientId: this.#clientId,
      seq: ++this.#seq,
      ...(pins.length ? { pins } : {}),
      change: this.#pending,
    }
    this.#sent = { submission, change: this.#pending, answered: false }
    this.#pending = NOTHING
    return submission
  }

  /** The server said it took the change sent, which comes back as a row. */
  answered() {
    if (this.#sent) this.#sent.answered = true
  }

  /**
   * A change the stream took: the one sent, come back, or anyone else's, which both move on past.
   * Says what someone else's does to what is shown, the stream with everything edited here on top:
   * it, moved past those edits. Nothing for the one sent, which was shown already.
   */
  heard({ change, submission }: StreamRow): CodeChange | undefined {
    const sent = this.#sent
    if (sent && submission?.clientId === this.#clientId && submission.seq === sent.submission.seq) {
      this.#sent = undefined
      return undefined
    }
    let remote = change
    if (sent) {
      const moved = transformCodeChange(remote, sent.change)
      sent.change = moved.b
      remote = moved.a
    }
    if (!empty(this.#pending)) {
      const moved = transformCodeChange(remote, this.#pending)
      this.#pending = moved.b
      remote = moved.a
    }
    return remote
  }

  /**
   * The chat's changes were kept: what was edited here goes on over the commits the keep made
   * (`commits`), as their content is the same, but for the gadgets whose content the keep changed,
   * whose edits are let go of. The server moves the change sent across too, or refuses it.
   */
  kept(discontinuous: readonly number[], commits: ReadonlyMap<number, string>) {
    const gone = new Set(discontinuous)
    this.#pending = without(this.#pending, gone)
    for (const gadgetId of this.#bases.keys()) {
      const commit = commits.get(gadgetId)
      if (gone.has(gadgetId)) this.#bases.delete(gadgetId)
      else if (commit !== undefined) this.#bases.set(gadgetId, commit)
    }
  }

  /** Lets go of everything not taken, and starts as a client the server has not heard from. */
  drop() {
    this.#clientId = this.newClientId()
    this.#seq = 0
    this.#sent = undefined
    this.#pending = NOTHING
    this.#bases.clear()
  }
}
