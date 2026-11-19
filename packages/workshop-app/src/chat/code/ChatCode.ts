import type { ChatGadgetPinState, CodeChangeSubmission } from '@gadgets/workshop-shared/api'
import { composeCodeChange, transformCodeChange, type CodeChange, type FileChange } from '@gadgets/workshop-shared/code-change'
import { ChangeStream, type StreamEvent, type StreamRow } from './changeStream'
import type { EpochCode } from './epochCode'
import { LocalEdits } from './localEdits'

/** One gadget's code in a chat: what it is over, and what the chat changes of it. */
export type GadgetChatCode = {
  /**
   * The commit its content in the chat starts from: the chat's pin, or the commit edits here were
   * made over. None where the chat has not touched it, which leaves it as kept (`kept`, else its
   * head), or where the chat made it, which starts from nothing.
   */
  base?: string
  /** What it is compared with to say what changed: the head the chat last brought in. */
  review?: string
  /**
   * What the keep that opened the chat's epoch made of it, `commit`, over its head before then,
   * `over`: shown in place of the head that is still `over`, as the head is told of separately.
   */
  kept?: { commit: string; over: string }
  /** What the chat does to each of its files, edits here included, by path. */
  files: ReadonlyMap<string, FileChange>
}

export type ChatCodeSnapshot =
  | { status: 'loading' }
  | {
    status: 'ready'
    /** Counts what was published, for whoever shows it to say which it shows (`shown`). */
    version: number
    /** Each gadget the chat has done anything to, or that it kept, by its id. */
    gadgets: ReadonlyMap<number, GadgetChatCode>
    /** Its agent is working, and nothing can be edited until it is done. */
    agentActive: boolean
    /** Edits made here are on their way to the chat, and are not in it yet. */
    sending: boolean
    /** Edits made here that were lost, and why: the chat's changes were discarded, say. */
    lost?: string
  }

/** A change that was not sent, as while the conversation reconnects: tried again, and no failure. */
export class NotSent extends Error {}

export type ChatCodeOptions = {
  /** Sends a change to the chat (`Overseer.submitCodeChange`), or throws `NotSent`. */
  submit: (submission: CodeChangeSubmission) => Promise<unknown>
  /** Reads the chat's history again, where rows have waited too long for what they need. */
  reread?: () => void
  newClientId?: () => string
}

const LOADING: ChatCodeSnapshot = { status: 'loading' }
const NO_FILES: ReadonlyMap<string, FileChange> = new Map()
// How long rows may wait for what they need before the history is read again, at first, and at most.
const STALL = { first: 5000, most: 60_000 }
// How long a refused change waits to be sent again, at first, doubling each time, and how many
// times it is, before what was edited is let go of.
const RETRY = { first: 1000, times: 3 }
const MAX_UNSEEN = 200
const DISCARDED = 'The chat’s changes were discarded, and your edits with them.'
const RESYNCED = 'Your latest edits couldn’t be matched with the chat’s changes, so they weren’t kept.'
const REFUSED = 'Your latest edits couldn’t be saved, so they were undone.'

/**
 * One chat's code, live, for whoever shows or edits it beside the chat (see AGENTS.md's Beside
 * the page): the chat's stream as the server took it (`ChangeStream`), with
 * what is edited here on top (`LocalEdits`), sent one change at a time.
 *
 * Its session feeds it: the history (`history`, once it reaches back to the epoch, and again as it
 * changes), each row (`row`), and whether the agent works (`agent`). Nothing is sent while it does,
 * nor edited. A sending that fails is tried again, as it was: as long as it takes where it was not
 * sent, and a few times, with growing waits, where it was refused, before what was edited is let
 * go of. What was edited here goes on through a keep, and is lost with a discard, or where it
 * could not be followed and the server did not have it, which is said.
 *
 * An edit is over what was shown, which whoever shows it says (`shown`, once it is drawn): what
 * the stream took since then from anyone else is not in it, so the edit is moved past that first.
 */
export class ChatCode {
  #listeners = new Set<() => void>()
  #snapshot: ChatCodeSnapshot = LOADING
  #stream = new ChangeStream()
  #local: LocalEdits
  // The pins of the stream's generation, and those the history says now, which are the next
  // generation's while a keep is still closing this one.
  #pins: readonly ChatGadgetPinState[] = []
  #next: { generation: number; pins: readonly ChatGadgetPinState[] } | undefined
  #kept = new Map<number, { commit: string; over: string }>()
  #epoch: EpochCode | undefined
  #agentActive = false
  #inFlight = false
  #lost: string | undefined
  // How many times in a row the change sent was refused.
  #refusals = 0
  // The sending, by the drops it was made in, that a start over came during: whether what it
  // sent was kept is known once it is answered.
  #unsure: number | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #stall: ReturnType<typeof setTimeout> | undefined
  #stallDelay = 0
  #disposed = false
  // Counts the times what was edited here was let go of, so that what was sent before then is not heard of.
  #drops = 0
  // Each gadget's code as last published, so that one whose code is the same keeps its identity.
  #gadgets = new Map<number, GadgetChatCode>()
  #version = 0
  // What changed what is shown that the version last drawn (`shown`) may not have, but for edits
  // made here, each with the version that first has it: a change someone else made, as it is
  // over what is shown then, or that it started over, which nothing made over before can follow.
  #unseen: { in: number; change: CodeChange | 'reset' }[] = []

  constructor(private readonly options: ChatCodeOptions) {
    this.#local = new LocalEdits(options.newClientId)
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  /** The history, as it reaches back to the start of the chat's epoch, with the pins it has now. */
  history(epoch: EpochCode, pins: readonly ChatGadgetPinState[]) {
    this.#epoch = epoch
    this.#next = { generation: epoch.generation, pins }
    this.#apply(this.#stream.history(epoch))
  }

  row(row: StreamRow) {
    this.#apply(this.#stream.row(row))
  }

  /** Whether the agent works. What waited for it to be done goes once it is. */
  agent(active: boolean) {
    if (active === this.#agentActive) return
    this.#agentActive = active
    this.#publish()
    if (!active) this.retry()
  }

  /** What is drawn is the snapshot of `version`, which edits are made over from now. */
  shown(version: number) {
    this.#unseen = this.#unseen.filter((each) => each.in > version)
  }

  /**
   * Edits gadget `gadgetId`'s files as they are shown, over `base`, the commit they are shown over
   * where the chat does not say one. Nothing, while the agent works or the chat is not read yet,
   * or where it started over since what is shown, which says whether it was taken.
   */
  edit(gadgetId: number, files: readonly [string, FileChange][], base: string | undefined) {
    if (this.#disposed || !this.#stream.ready || this.#agentActive || files.length === 0) return false
    this.#lost = undefined
    try {
      if (this.#unseen.some(({ change }) => change === 'reset')) throw new Error('Made over a stream that has started over.')
      // Moved past what it did not see, each of which moves past it in turn, for the next edit
      // made over the same.
      let edit: CodeChange = { [gadgetId]: [...files] }
      this.#unseen = this.#unseen.map((each) => {
        if (each.change === 'reset') return each
        const moved = transformCodeChange(each.change, edit)
        edit = moved.b
        return { in: each.in, change: moved.a }
      })
      this.#local.add(edit, () => base)
    } catch {
      // Made over what is no longer shown: what is shown now is published again, to edit over.
      this.#publish()
      return false
    }
    this.#publish()
    this.#pump()
    return true
  }

  /** Tries the sending that waits to be tried again now, as once the connection is back. */
  retry = () => {
    clearTimeout(this.#retry)
    this.#retry = undefined
    this.#pump()
  }

  // Lets go of what was edited here and not taken, as the chat keeps refusing it, and says so:
  // what is shown goes back to the chat as the server has it, read again, as a stream it keeps
  // refusing changes over may be one it has moved on from.
  #giveUp() {
    clearTimeout(this.#retry)
    this.#retry = undefined
    this.#refusals = 0
    this.#lost = REFUSED
    this.#drops++
    this.#local.drop()
    this.#unsee('reset')
    this.#publish()
    this.options.reread?.()
  }

  /** Stops saying that edits were lost. */
  dismissLost = () => {
    if (this.#lost === undefined) return
    this.#lost = undefined
    this.#publish()
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#retry)
    clearTimeout(this.#stall)
    this.#listeners.clear()
  }

  #apply(events: readonly StreamEvent[]) {
    for (const event of events) {
      if (event.type === 'row') {
        const seen = this.#local.heard(event.row)
        if (seen) this.#unsee(seen)
      } else if (event.type === 'kept') {
        const kept = this.#epoch?.kept ?? new Map<number, string>()
        const closed = this.#pins
        this.#pins = this.#next?.pins ?? []
        this.#local.kept(event.discontinuous, kept)
        // The head is told of apart from the chat: until it says the keep's commit, that is shown.
        this.#kept = new Map([...kept].flatMap(([gadgetId, commit]) => {
          const over = closed.find((pin) => pin.gadgetId === gadgetId)?.mergedCommit
          return over === undefined ? [] : [[gadgetId, { commit, over }] as const]
        }))
        // A gadget the keep changed is shown afresh.
        if (event.discontinuous.length) this.#unsee('reset')
      } else {
        // What was not sent is lost, as is what was sent and refused, waiting to be sent again; what
        // is still on its way only if the server does not take it.
        if (event.discarded ? !this.#local.idle : this.#local.unsent || (this.#local.unanswered && !this.#inFlight)) {
          this.#lost = event.discarded ? DISCARDED : RESYNCED
        } else if (this.#local.unanswered) this.#unsure = this.#drops
        this.#drops++
        this.#local.drop()
        this.#kept = new Map()
        this.#refusals = 0
        clearTimeout(this.#retry)
        this.#retry = undefined
        this.#unsee('reset')
      }
    }
    if (this.#next?.generation === this.#stream.generation) this.#pins = this.#next.pins
    this.#watchStall()
    this.#publish()
    this.#pump()
  }

  // Kept until what is drawn has it, which is the next version published at the soonest.
  #unsee(change: CodeChange | 'reset') {
    this.#unseen.push({ in: this.#version + 1, change })
    // Where nothing says it drew them, as nothing is shown, what is still to be is all one.
    if (this.#unseen.length > MAX_UNSEEN) this.#unseen = [{ in: this.#version + 1, change: 'reset' }]
  }

  // Sends what is next, one change at a time, once the agent is done.
  #pump() {
    if (this.#disposed || this.#inFlight || this.#agentActive || this.#retry !== undefined || !this.#stream.ready) return
    const submission = this.#local.next(this.#stream.generation, this.#stream.revision, (gadgetId) => this.#pins.some((pin) => pin.gadgetId === gadgetId))
    if (!submission) return
    this.#inFlight = true
    this.#publish()
    const drops = this.#drops
    this.options.submit(submission).then(
      () => {
        this.#inFlight = false
        if (this.#unsure === drops) this.#unsure = undefined
        if (drops !== this.#drops) return this.#pump()
        this.#refusals = 0
        this.#local.answered()
        this.#publish()
        // What was edited meanwhile goes once its row is heard, which may have been already.
        this.#pump()
      },
      (error: unknown) => {
        this.#inFlight = false
        if (this.#disposed) return
        // Sent before the stream started over, and not taken: it was lost with what was not sent.
        if (this.#unsure === drops) {
          this.#unsure = undefined
          this.#lost = RESYNCED
          this.#publish()
        }
        if (drops !== this.#drops) return this.#pump()
        // Not sent, as while reconnecting, it is tried again as long as that takes; refused, a few
        // more times, as the connection may have dropped as it was sent.
        if (error instanceof NotSent) this.#refusals = 0
        else if (++this.#refusals > RETRY.times) return this.#giveUp()
        const delay = RETRY.first * 2 ** Math.max(0, this.#refusals - 1)
        this.#retry = setTimeout(() => {
          this.#retry = undefined
          this.#pump()
        }, delay)
        this.#publish()
      },
    )
  }

  // Rows that wait too long for the last of a generation a keep closed give up on it, as a
  // reconnect may have missed it for good; for a gap, the history is read again, less often each
  // time it does not help.
  #watchStall() {
    if (!this.#stream.stalled) {
      clearTimeout(this.#stall)
      this.#stall = undefined
      this.#stallDelay = 0
      return
    }
    if (this.#stall !== undefined) return
    const delay = this.#stallDelay || STALL.first
    this.#stallDelay = Math.min(delay * 2, STALL.most)
    this.#stall = setTimeout(() => {
      this.#stall = undefined
      if (this.#stream.closing) this.#apply(this.#stream.abandonClosing())
      else if (this.#stream.stalled) {
        this.options.reread?.()
        this.#watchStall()
      }
    }, delay)
  }

  #publish() {
    if (this.#disposed) return
    if (!this.#stream.ready) {
      this.#snapshot = LOADING
    } else {
      const change = this.#local.idle ? this.#stream.change : composeCodeChange(this.#stream.change, this.#local.change)
      this.#snapshot = {
        status: 'ready',
        version: ++this.#version,
        gadgets: this.#gadgetsOf(change),
        agentActive: this.#agentActive,
        sending: !this.#local.idle,
        lost: this.#lost,
      }
    }
    for (const listener of this.#listeners) listener()
  }

  #gadgetsOf(change: CodeChange): ReadonlyMap<number, GadgetChatCode> {
    const ids = new Set([...Object.keys(change).map(Number), ...this.#pins.map(({ gadgetId }) => gadgetId), ...this.#kept.keys(), ...this.#local.bases.keys()])
    const gadgets = new Map<number, GadgetChatCode>()
    for (const gadgetId of ids) {
      const pin = this.#pins.find((each) => each.gadgetId === gadgetId)
      const entries = change[gadgetId]
      const made: GadgetChatCode = {
        base: pin?.baseCommit ?? this.#local.bases.get(gadgetId),
        review: pin?.mergedCommit,
        kept: pin ? undefined : this.#kept.get(gadgetId),
        files: entries ? new Map(entries) : NO_FILES,
      }
      const was = this.#gadgets.get(gadgetId)
      gadgets.set(gadgetId, was && same(was, made) ? was : made)
    }
    this.#gadgets = gadgets
    return gadgets
  }
}

const same = (a: GadgetChatCode, b: GadgetChatCode) =>
  a.base === b.base && a.review === b.review && a.kept?.commit === b.kept?.commit && a.kept?.over === b.kept?.over &&
  a.files.size === b.files.size && [...a.files].every(([path, change]) => b.files.get(path) === change)
