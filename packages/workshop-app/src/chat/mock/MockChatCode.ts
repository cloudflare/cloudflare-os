import type { ChatCodeBase, ChatGadgetPinState, CodeChangeSubmission } from '@gadgets/workshop-shared/api'
import { applyCodeChange, composeCodeChange, requireTextFiles, transformCodeChange, type CodeChange } from '@gadgets/workshop-shared/code-change'
import type { StreamRow } from '../code/changeStream'

const empty = (change: CodeChange) => Object.keys(change).length === 0

/**
 * A scripted chat's code as the server keeps it (see `Overseer.submitCodeChange`, `ChatCodeBase`):
 * one stream of changes per generation, each sent change moved past those taken since the revision
 * it was made over, a sending told by its client and number so that one sent again is taken once,
 * and each gadget pinned at its head by its first change. What the script's messages change
 * (`recorded`) comes on top as the messages themselves, as an agent's recorded steps do.
 *
 * Keeping it closes the generation with its content carried over (`prior`); discarding it closes
 * it with nothing. Rows not yet recorded in a message are sent again to whoever subscribes.
 */
export class MockChatCode {
  #generation = 0
  #revision = 0
  #pins: ChatGadgetPinState[] = []
  #prior: ChatCodeBase['prior']
  // Every row of this generation, those the closed one had, and how many of this one are recorded.
  #rows: StreamRow[] = []
  #priorRows: StreamRow[] = []
  #recordedThrough = 0
  // Everything since the last keep, as one change over each gadget's pin, or its head without one.
  #change: CodeChange = {}
  #sessions = new Map<string, { seq: number; landed: { generation: number; revision: number } }>()

  /** The code base, as the chat's metadata says it, with the epoch it is given. */
  base(epoch: number | undefined): ChatCodeBase {
    return { pins: this.#pins, generation: this.#generation, revision: this.#revision, ...(epoch === undefined ? {} : { epoch }), ...(this.#prior ? { prior: this.#prior } : {}) }
  }

  /** The gadgets it changes. */
  get gadgets(): number[] {
    return Object.keys(this.#change).map(Number)
  }

  get pins(): readonly ChatGadgetPinState[] {
    return this.#pins
  }

  /** Rows not recorded in a message yet, which a new subscriber is sent. */
  get unrecorded(): readonly StreamRow[] {
    return this.#rows.filter(({ revision }) => revision > this.#recordedThrough)
  }

  /**
   * Takes a change a client sent, `headOf` saying each gadget's head, as its pin is checked
   * against: the row it made, or where one sent again landed the first time, which is told to nobody.
   */
  submit(submission: CodeChangeSubmission, headOf: (gadgetId: number) => string | undefined): { row: StreamRow; again: boolean } {
    const { clientId, seq } = submission
    const session = this.#sessions.get(clientId)
    if (session?.seq === seq) return { row: { ...session.landed, change: {} }, again: true }
    if (seq !== (session?.seq ?? 0) + 1) throw new Error('That change was sent out of order.')
    let change = submission.change
    let since: readonly StreamRow[]
    if (submission.generation === this.#generation) {
      if (submission.revision > this.#revision) throw new Error('That change is over a revision there isn’t yet.')
      since = this.#rows.filter(({ revision }) => revision > submission.revision)
    } else if (submission.generation === this.#prior?.generation) {
      since = [...this.#priorRows.filter(({ revision }) => revision > submission.revision), ...this.#rows]
    } else {
      throw new Error('The chat’s changes were discarded, and that change with them.')
    }
    for (const row of since) change = transformCodeChange(row.change, change).b
    for (const gadgetId of Object.keys(change).map(Number)) {
      if (this.#pins.some((pin) => pin.gadgetId === gadgetId)) continue
      const head = headOf(gadgetId)
      if (head === undefined) continue
      const declared = submission.generation === this.#generation ? submission.pins?.find((pin) => pin.gadgetId === gadgetId) : { baseCommit: head }
      if (declared?.baseCommit !== head) throw new Error(`Gadget ${gadgetId} isn’t pinned at its head.`)
      this.#pins = [...this.#pins, { gadgetId, baseCommit: head, mergedCommit: head }]
    }
    const row: StreamRow = { generation: this.#generation, revision: ++this.#revision, change, submission: { clientId, seq } }
    this.#rows.push(row)
    this.#change = composeCodeChange(this.#change, change)
    this.#sessions.set(clientId, { seq, landed: { generation: row.generation, revision: row.revision } })
    return { row, again: false }
  }

  /** A change the script's messages record, as an agent's steps are recorded. */
  recorded(change: CodeChange) {
    this.#change = composeCodeChange(this.#change, change)
  }

  /** The rows not recorded yet, as one change and how far it reaches, for a message to record. */
  record(): { change: CodeChange; watermark: { changesGeneration: number; throughRevision: number } } | undefined {
    const rows = this.unrecorded
    if (rows.length === 0) return undefined
    this.#recordedThrough = this.#revision
    return {
      change: rows.reduce((made, { change }) => composeCodeChange(made, change), {} as CodeChange),
      watermark: { changesGeneration: this.#generation, throughRevision: this.#revision },
    }
  }

  /** Gadget `gadgetId`'s files as the chat has them, over `filesAt` its pin, or its head without one. */
  files(gadgetId: number, filesAt: (commit: string | undefined) => Record<string, string> | undefined): Record<string, string> {
    const base = this.#pins.find((pin) => pin.gadgetId === gadgetId)?.baseCommit
    const entries = this.#change[gadgetId]
    const before = filesAt(base) ?? {}
    if (!entries) return before
    const after = applyCodeChange(new Map([[gadgetId, new Map(Object.entries(before))]]), { [gadgetId]: entries })
    return Object.fromEntries(requireTextFiles(after.get(gadgetId) ?? new Map()))
  }

  /** Closes the generation once its content is kept, which the next carries on from. */
  kept() {
    this.#prior = { generation: this.#generation, finalRevision: this.#revision, discontinuousGadgets: [] }
    this.#priorRows = this.#rows
    this.#next()
  }

  /** Closes the generation with nothing kept. */
  discarded() {
    this.#prior = undefined
    this.#priorRows = []
    this.#next()
  }

  get proposes() {
    return !empty(this.#change)
  }

  #next() {
    this.#generation++
    this.#revision = 0
    this.#recordedThrough = 0
    this.#rows = []
    this.#pins = []
    this.#change = {}
  }
}
