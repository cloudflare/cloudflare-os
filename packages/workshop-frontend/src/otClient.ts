import type {
  AiChatAuthorInfo, ChatCodeBase, ChatGadgetPin, CodeChangeSubmission, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import {
  applyCodeChange, changedGadgets, composeCodeChange, transformCodeChange,
  type CodeContent, type CodeChange, type FileChange,
} from '@gadgets/workshop-shared/code-change'

// The chat-level OT client: the classic two-buffer client behind the code view.
//
// A chat's uncommitted code is one revisioned stream of code changes per generation (see
// ChatCodeBase in the API). This client tracks that stream for one chat: it derives the chat's
// content (per-pin base trees + the epoch's materialized changes + accepted rows), holds at most
// one in-flight submitCodeChange() plus one pending composition of newer local edits, transforms
// both over incoming remote rows (the priority pairing lives in code-change.ts), and rebases
// them. The pending buffer *composes*, so submissions land at ~RTT granularity -- everything
// typed since the last ack rides one submit -- not per keystroke.
//
// Inputs arrive through three paths, each safe to deliver redundantly or out of order across
// paths (the client holds rows it cannot apply yet and drains them as knowledge arrives):
//  - setDurableState(): the chat's ChatCodeBase plus the composed change of the current epoch's
//    "changes" messages (see ChatCodeChanges in ChatInterface). Also how generation bumps are
//    learned: a content-preserving bump (a merge's epoch reset, `prior` present) hands the
//    local buffers across the boundary, so typing straight through someone's accept is
//    seamless; a destructive bump (revert / draft discard / turn abort) discards local edits
//    and rebuilds, per ChatCodeBase.generation's contract.
//  - pushRow(): one AiChatSubscriber.changeApplied() row. Deduped by (generation, revision), so
//    subscribe-replay after a reconnect is harmless.
//  - applyLocalChange() (with ensureGadgetEditable() for the first edit to an unpinned gadget):
//    locally-authored edits, composed into the pending buffer and submitted under the
//    client-generated (clientId, seq) idempotency scheme of Overseer.submitCodeChange().
//
// Base content is never taken from another client: it always comes from
// getCodeAtCommit(baseCommit) (the delegate's fetch, cacheable by oid) or, for the first local
// edit to an unpinned gadget, from the head tree the view is already displaying -- which is
// byte-identical to what the accompanying pin declaration names. The client mints a fresh
// clientId whenever local state is rebuilt; a transport failure retries the same seq with an
// identical payload, never a re-composed change (the server's dedupe digest requires it).

/** One accepted row of a chat's change stream, as delivered by AiChatSubscriber.changeApplied(). */
export interface ChatChangeRow {
  generation: number
  revision: number
  author: AiChatAuthorInfo
  change: CodeChange
  submission?: { clientId: string; seq: number }
}

/**
 * The durable half of a chat's code state, derived from its metadata and message log together
 * (see ChatCodeChanges in ChatInterface): the ChatCodeBase plus the current epoch's non-reverted
 * "changes" messages composed into one change, and the current generation's revision those
 * messages' watermarks reach (rows <= rowsThrough are already inside epochChange; later rows
 * arrive via pushRow()).
 */
export interface ChatDurableCode {
  codeBase?: ChatCodeBase
  epochChange?: CodeChange
  rowsThrough: number
}

/** A remote content change to one file, for open editors to apply as a remote transaction. */
export interface RemoteFileEvent {
  gadgetId: WorkpieceId
  path: string
  change: FileChange
}

/** How the client reaches the world. All callbacks may be invoked from async continuations. */
export interface ChatOtClientDelegate {
  /** Read a commit's flattened file map (Overseer.getCodeAtCommit, cacheable by oid). */
  fetchCommitFiles(commitId: string): Promise<ReadonlyMap<string, string>>
  /** Overseer.submitCodeChange for this chat. */
  submitCodeChange(submission: CodeChangeSubmission)
      : Promise<{ generation: number; revision: number }>
  /** True for transport-level failures that a retry/reconnect is expected to cure. */
  isTransientError(err: unknown): boolean
  /**
   * Remote content changed. `events` carries per-file deltas for open editors; an *empty* array
   * means the change is coarse (a rebuild or epoch reset) and open editors must reload from the
   * client wholesale. Notifications that would change nothing an editor displays -- our own
   * submission's echo, a doubly-transformed no-op remote row -- are not delivered at all, so
   * empty never means "no-op" (a spurious coarse signal would needlessly rebuild editors,
   * dropping focus and selection).
   */
  onRemoteChange(events: RemoteFileEvent[]): void
  /** Queued local edits were discarded (hard rejection or destructive generation bump). */
  onLocalEditsDiscarded(): void
  /** Whether unacknowledged local edits are stuck behind a failing submission. */
  onDirtyState(hasUnsyncedEdits: boolean): void
  /** Unrecoverable failure (e.g. a base tree fetch failed); the view should show an error. */
  onFatalError(err: unknown): void
}

const EMPTY_CHANGE: CodeChange = {}

function isEmptyChange(change: CodeChange): boolean {
  return Object.keys(change).length === 0
}

// Drop the given gadgets' entries from a change (an epoch reset marks gadgets discontinuous:
// pending changes touching them would be rejected as bridge-ineligible anyway).
function dropGadgetsFromChange(change: CodeChange, gadgets: ReadonlySet<WorkpieceId>): CodeChange {
  if (![...gadgets].some(id => id in change)) return change
  const out: CodeChange = {}
  for (const [key, entries] of Object.entries(change)) {
    const gadgetId = Number(key)
    if (!gadgets.has(gadgetId)) out[gadgetId] = entries
  }
  return out
}

// While a submission is failing transiently, retry with backoff (same seq, identical payload).
const SUBMIT_RETRY_BASE_MS = 1000
const SUBMIT_RETRY_MAX_MS = 15_000

// A content-preserving generation switch normally completes as soon as the closed generation's
// last few rows arrive (in-flight-RTT scale), and a materialization watermark that runs ahead of
// the applied revision normally resolves as soon as the same batch's rows are processed (they
// are delivered first, but reach the client's queue through independently-scheduled React
// effects). If either stall persists -- events were genuinely lost -- give up and rebuild
// (discarding local edits) rather than wedging the view.
const STALL_TIMEOUT_MS = 5_000

// What the backend throws while an agent turn is active (AGENT_RUNNING_ERROR_MESSAGE in
// overseer.ts): a retryable rejection -- keep the queue, resubmit after the turn. The UI already
// locks editing during turns, so this only backstops races; matching the message is acceptable
// for a rare path whose drift merely reclassifies it as a hard rejection (discard + rebuild).
const AGENT_RUNNING_MESSAGE = 'Agent is running'
// The backend's "state moved during my awaits too many times" rejection -- also retryable.
const CHANGING_TOO_QUICKLY_MESSAGE = 'The chat is changing too quickly'

function isRetryableSubmitRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(AGENT_RUNNING_MESSAGE) || message.includes(CHANGING_TOO_QUICKLY_MESSAGE)
}

/**
 * The OT client for one chat. Create one per (chat, view) and dispose it on chat switch; feed
 * it durable snapshots and rows as they arrive, and route editor edits through
 * ensureGadgetEditable()/applyLocalChange(). `getContent()` is the chat's uncommitted content as
 * this client sees it -- committed heads still apply for gadgets absent from it (an unpinned
 * gadget tracks mainline head live).
 */
export class ChatOtClient {
  readonly #delegate: ChatOtClientDelegate

  // ---- server-acked state ----
  // Content through (#generation, #appliedRevision): pin base trees + epoch message changes + rows.
  // Treated as immutable (copy-on-write), like everything code-change functions touch.
  #applied: CodeContent = new Map()
  #generation = 0
  #appliedRevision = 0

  // ---- local (unacknowledged) state ----
  // At most one submission in flight (the seq rule makes that a checked invariant server-side),
  // plus the composition of local edits made since it left. `pending` applies on top of
  // `inflight.change`, which applies on top of #applied. `wire` is the payload as first sent --
  // retries must resend it byte-identically for the server's dedupe digest -- while `change` is the
  // same change as transformed over remote rows since, for local display and rebasing. `accepted`
  // is where the server's RPC response said the submission landed: normally the echo row
  // (broadcast before the response) has already cleared the whole record by the time it is
  // set, so it only matters as the lost-echo backstop (see #tryApplyInflightAck).
  #inflight: {
    wire: CodeChangeSubmission
    change: CodeChange
    accepted?: { generation: number; revision: number }
  } | null = null
  #pending: CodeChange = EMPTY_CHANGE
  // Local seeds for gadgets this client started editing before any pin existed: the head tree
  // the first keystroke was made against. Declared as the pin base on the next submission and
  // dropped once the gadget's content enters #applied (or on any rebuild/reset).
  #localSeeds = new Map<WorkpieceId, { baseCommit: string; files: ReadonlyMap<string, string> }>()

  // ---- derived ----
  // #applied + local seeds + inflight + pending: what editors display. Kept incrementally so
  // remote rows can be delivered to editors as deltas.
  #display: CodeContent = new Map()

  // ---- stream bookkeeping ----
  #clientId = crypto.randomUUID()
  #seq = 0
  #latestDurable: ChatDurableCode = { rowsThrough: 0 }
  // Rows not yet applied: held when they run ahead of the state we can apply them to (a future
  // generation before its metadata, a revision gap, a pin we haven't learned yet).
  #heldRows = new Map<number, Map<number, ChatChangeRow>>()
  // Set while waiting out a content-preserving generation switch (see setDurableState).
  #pendingSwitch: { codeBase: ChatCodeBase; since: number } | null = null
  // Set while the durable watermark has run ahead of the applied revision (see #checkStalls).
  #watermarkGapSince: number | null = null
  #recheckTimer: ReturnType<typeof setTimeout> | null = null
  // Chat-created (pending) gadgets have no head commit and build content up from nothing; rows
  // touching them apply against an empty base rather than waiting for a pin.
  #pendingCreations: ReadonlySet<WorkpieceId> = new Set()

  // ---- lifecycle ----
  #ready = false
  #disposed = false
  #fatal = false
  // Serializes the async work (rebuilds, row application with base fetches) so state mutations
  // happen in synchronous tails, in order -- mirroring the server's prefetch-then-commit
  // pattern. Local edits are deliberately *not* queued: they are synchronous, and the queued
  // tasks' synchronous tails read the then-current buffers.
  #queue: Promise<void> = Promise.resolve()
  #submitScheduled = false
  #submitBackoffMs = SUBMIT_RETRY_BASE_MS

  constructor(delegate: ChatOtClientDelegate) {
    this.#delegate = delegate
  }

  dispose(): void {
    this.#disposed = true
    if (this.#recheckTimer !== null) {
      clearTimeout(this.#recheckTimer)
      this.#recheckTimer = null
    }
  }

  /** False until the first durable snapshot has been folded (and after a fatal error). */
  isReady(): boolean {
    return this.#ready && !this.#fatal
  }

  /** The chat's uncommitted content as displayed: server-acked rows plus local edits. */
  getContent(): CodeContent {
    return this.#display
  }

  /** Whether the chat's uncommitted content covers this gadget (else it tracks head live). */
  hasGadget(gadgetId: WorkpieceId): boolean {
    return this.#display.has(gadgetId)
  }

  getFiles(gadgetId: WorkpieceId): ReadonlyMap<string, string> | undefined {
    return this.#display.get(gadgetId)
  }

  /** Whether unacknowledged local edits exist (in flight or still pending). */
  hasLocalEdits(): boolean {
    return this.#inflight !== null || !isEmptyChange(this.#pending)
  }

  /** Update the set of gadgets still pending (chat-created) in this chat. */
  setPendingCreations(ids: ReadonlySet<WorkpieceId>): void {
    this.#pendingCreations = ids
    // A held row or a waiting submission may have been waiting for exactly this knowledge.
    this.#enqueue(() => this.#drainHeldRows())
    this.#scheduleSubmit()
  }

  // =====================================================================================
  // Durable state / rows in

  /**
   * Fold a fresh durable snapshot (metadata + message log). Called on every recomputation;
   * internally decides whether it means a rebuild, a generation handoff, or nothing.
   */
  setDurableState(durable: ChatDurableCode): void {
    this.#enqueue(async () => {
      const codeBase = durable.codeBase ?? { pins: [], generation: 0, revision: 0 }
      this.#latestDurable = durable

      if (!this.#ready) {
        await this.#rebuild(durable)
        return
      }

      if (codeBase.generation !== this.#generation) {
        if (codeBase.generation < this.#generation) return  // stale delivery
        if (codeBase.prior?.generation === this.#generation) {
          // Content-preserving epoch reset: finish the closed generation's tail, then hand the
          // local buffers across (see #trySwitchGeneration, called from the drain).
          this.#pendingSwitch ??= { codeBase, since: Date.now() }
          this.#pendingSwitch.codeBase = codeBase
          await this.#drainHeldRows()
          this.#checkStalls()
        } else {
          // Destructive bump (or a boundary we can't bridge): local edits are rooted in erased
          // history and must be discarded.
          await this.#discardLocalAndRebuild()
        }
        return
      }

      // Same generation. New pins may unblock held rows or a waiting submission; and a
      // watermark running ahead of the applied revision means rows are missing (usually just
      // still in flight through the UI layer -- see #checkStalls).
      await this.#drainHeldRows()
      this.#checkStalls()
      this.#scheduleSubmit()
    })
  }

  // Whether the durable materialization watermark has run ahead of the applied revision: rows
  // it covers never reached us (or haven't yet).
  #hasWatermarkGap(): boolean {
    return this.#latestDurable.rowsThrough > this.#appliedRevision &&
        (this.#latestDurable.codeBase?.generation ?? 0) === this.#generation &&
        this.#pendingSwitch === null
  }

  // Whether a rebuild would lose anything: pending edits, local seeds, or an in-flight
  // submission not yet known to be durably recorded. An in-flight the server has accepted at a
  // position the durable watermark already covers (or in a generation it has moved past) is
  // inside the snapshot's epochChange -- or erased with its generation -- so rebuilding from the
  // snapshot reproduces the server's truth without losing keystrokes.
  #hasUnsyncedLocalState(): boolean {
    if (!isEmptyChange(this.#pending) || this.#localSeeds.size > 0) return true
    if (this.#inflight === null) return false
    const accepted = this.#inflight.accepted
    if (accepted === undefined) return true
    const durableGeneration = this.#latestDurable.codeBase?.generation ?? 0
    return !(durableGeneration > accepted.generation ||
        (durableGeneration === accepted.generation &&
         this.#latestDurable.rowsThrough >= accepted.revision))
  }

  // Evaluate the two stall conditions (an unfinished generation handoff, a materialization
  // watermark ahead of the applied revision): normally they resolve within the next event
  // batch, so give them a grace period on a timer before concluding that events were lost and
  // rebuilding.
  #checkStalls(): void {
    if (this.#fatal || this.#disposed || !this.#ready) return
    if (this.#hasWatermarkGap()) {
      if (!this.#hasUnsyncedLocalState()) {
        // The missing rows are already inside the snapshot's epochChange and nothing local is at
        // risk: rebuild right away instead of stalling the view for the grace period.
        this.#watermarkGapSince = null
        this.#enqueue(async () => {
          if (this.#ready && this.#hasWatermarkGap() && !this.#hasUnsyncedLocalState()) {
            await this.#rebuild(this.#latestDurable)
          }
        })
        return
      }
      this.#watermarkGapSince ??= Date.now()
    } else {
      this.#watermarkGapSince = null
    }

    const stalledSince = this.#pendingSwitch?.since ?? this.#watermarkGapSince
    if (stalledSince === null || stalledSince === undefined) return
    const overdue = Date.now() - stalledSince - STALL_TIMEOUT_MS
    if (overdue >= 0) {
      this.#enqueue(() => this.#discardLocalAndRebuild())
      return
    }
    if (this.#recheckTimer === null) {
      this.#recheckTimer = setTimeout(() => {
        this.#recheckTimer = null
        this.#enqueue(async () => {
          await this.#drainHeldRows()
          this.#checkStalls()
        })
      }, -overdue + 50)
    }
  }

  /** Feed one changeApplied row. Duplicates (subscribe-replay) are ignored. */
  pushRow(row: ChatChangeRow): void {
    this.#enqueue(async () => {
      let generationRows = this.#heldRows.get(row.generation)
      if (!generationRows) {
        generationRows = new Map()
        this.#heldRows.set(row.generation, generationRows)
      }
      if (!generationRows.has(row.revision)) generationRows.set(row.revision, row)
      await this.#drainHeldRows()
    })
  }

  // Apply every held row that is applicable now, in revision order; stop at the first that
  // isn't (a gap, a future generation, or an unknown pin still awaiting metadata).
  async #drainHeldRows(): Promise<void> {
    if (!this.#ready || this.#fatal) return
    for (;;) {
      // Prune: generations fully left behind, and *applied* rows once a materialization
      // watermark covers them. Applied-but-unmaterialized rows are deliberately retained --
      // they are the local replay cache a rebuild draws on (a rebuild starts from the
      // messages' watermark, before rows the server still considers live). Unapplied rows are
      // retained even below the watermark: a row arriving just after the watermark that
      // absorbed it is still the stream's next step (its content and the epochChange's agree), and
      // dropping it would wedge the stream at the gap.
      for (const generation of this.#heldRows.keys()) {
        if (generation < this.#generation) this.#heldRows.delete(generation)
      }
      const durableBase = this.#latestDurable.codeBase
      const generationRows = this.#heldRows.get(this.#generation)
      if (generationRows && (durableBase?.generation ?? 0) === this.#generation) {
        const coveredThrough =
          Math.min(this.#latestDurable.rowsThrough, this.#appliedRevision)
        for (const revision of generationRows.keys()) {
          if (revision <= coveredThrough) generationRows.delete(revision)
        }
      }

      const next = generationRows?.get(this.#appliedRevision + 1)
      if (next !== undefined) {
        if (!(await this.#applyRow(next))) return
        continue
      }
      if (this.#tryApplyInflightAck()) continue
      const outcome = this.#trySwitchGeneration()
      if (outcome === "discard") {
        await this.#discardLocalAndRebuild()
        return
      }
      if (outcome === "idle") return
    }
  }

  // Apply one row (the next in sequence). Returns false if it must wait (a pin the metadata
  // hasn't delivered yet) or if the client's local edits had to be discarded instead.
  async #applyRow(row: ChatChangeRow): Promise<boolean> {
    // Establish bases for gadgets the row touches that content doesn't cover yet. The pin is
    // read from the latest metadata; the metadata carrying it is written in the same
    // synchronous server step as the row, so normally it has already arrived.
    const seeds = new Map<WorkpieceId, ReadonlyMap<string, string>>()
    for (const gadgetId of changedGadgets(row.change)) {
      if (this.#applied.has(gadgetId) || seeds.has(gadgetId)) continue
      const pin = (this.#latestDurable.codeBase?.pins ?? []).find(p => p.gadgetId === gadgetId)
      if (pin !== undefined) {
        const localSeed = this.#localSeeds.get(gadgetId)
        if (localSeed !== undefined && localSeed.baseCommit !== pin.baseCommit) {
          // Another client's first edit pinned this gadget at a different base than our own
          // not-yet-submitted first edit assumed: our declaration would be rejected as a pin
          // conflict, and our display no longer matches the chat. Discard and rebuild.
          await this.#discardLocalAndRebuild()
          return false
        }
        // The fetch awaits; the synchronous tail below revalidates the stream position.
        seeds.set(gadgetId, await this.#delegate.fetchCommitFiles(pin.baseCommit))
      } else if (this.#localSeeds.has(gadgetId)) {
        // Our own declaration's echo can arrive before the metadata that mirrors the pin; the
        // local seed is byte-identical to the declared base by construction.
        seeds.set(gadgetId, this.#localSeeds.get(gadgetId)!.files)
      } else if (!this.#pendingCreations.has(gadgetId)) {
        // No pin known yet: hold until the metadata that declares it arrives
        // (setDurableState / setPendingCreations re-drain).
        return false
      }
    }

    // ---- synchronous tail ----
    if (this.#fatal || this.#disposed) return false
    if (row.generation !== this.#generation || row.revision !== this.#appliedRevision + 1) {
      return true  // state moved during the fetch; the drain loop re-evaluates
    }

    const events: RemoteFileEvent[] = []
    if (seeds.size > 0) {
      const applied = new Map(this.#applied)
      const display = new Map(this.#display)
      for (const [gadgetId, files] of seeds) {
        applied.set(gadgetId, new Map(files))
        if (!display.has(gadgetId)) {
          // A newly-visible remote pin: surface its base files so an open editor re-reads.
          // (When we held a matching local seed, the display already shows this content.)
          for (const [path, text] of files) events.push({ gadgetId, path, change: { set: text } })
          display.set(gadgetId, new Map(files))
        }
        this.#localSeeds.delete(gadgetId)
      }
      this.#applied = applied
      this.#display = display
    }

    const own = row.submission !== undefined && row.submission.clientId === this.#clientId &&
      this.#inflight !== null && row.submission.seq === this.#inflight.wire.seq
    this.#applied = applyCodeChange(this.#applied, row.change)
    this.#appliedRevision = row.revision

    if (own) {
      // Our own echo: the broadcast change is our in-flight change as the server transformed it
      // -- the same transforms we applied locally -- so the display already reflects it and
      // editors are notified only of the seed events above (usually none). An empty call would
      // read as a coarse reset (see ChatOtClientDelegate.onRemoteChange).
      this.#inflight = null
      this.#submitBackoffMs = SUBMIT_RETRY_BASE_MS
      this.#delegate.onDirtyState(false)
      this.#scheduleSubmit()
      if (events.length > 0) this.#delegate.onRemoteChange(events)
      return true
    }

    // A remote row: rebase the local buffers over it (the row has priority -- the server
    // ordered it first) and apply its doubly-transformed form to the display.
    let displayChange = row.change
    if (this.#inflight !== null) {
      const { a, b } = transformCodeChange(displayChange, this.#inflight.change)
      displayChange = a
      this.#inflight.change = b
    }
    if (!isEmptyChange(this.#pending)) {
      const { a, b } = transformCodeChange(displayChange, this.#pending)
      displayChange = a
      this.#pending = b
    }
    this.#display = applyCodeChange(this.#display, displayChange)
    for (const [gadgetKey, entries] of Object.entries(displayChange)) {
      for (const [path, change] of entries) {
        events.push({ gadgetId: Number(gadgetKey), path, change })
      }
    }
    // A row whose doubly-transformed form changed no displayed file (and surfaced no seeds)
    // is a display no-op: deliver nothing rather than a spurious coarse reset.
    if (events.length > 0) this.#delegate.onRemoteChange(events)
    return true
  }

  // Backstop for a lost echo: the submission was accepted (the RPC response said where it
  // landed -- see #sendInflight) but its broadcast row never reached us, e.g. it was
  // materialized while we were disconnected so subscribe-replay no longer carries it. Once the
  // stream reaches the position just below the accepted one, apply our own change exactly as the
  // echo would have: the broadcast change is our in-flight change as the server transformed it
  // -- the same transforms we applied locally (see #applyRow's own-echo path).
  #tryApplyInflightAck(): boolean {
    const accepted = this.#inflight?.accepted
    if (accepted === undefined || accepted.generation !== this.#generation ||
        accepted.revision !== this.#appliedRevision + 1) {
      return false
    }
    const inflight = this.#inflight!

    // Seed gadgets our own submission's pin declarations covered (mirrors the local-seed echo
    // path in #applyRow); the display already shows this content.
    const seedGadgets = changedGadgets(inflight.change)
      .filter(gadgetId => !this.#applied.has(gadgetId) && this.#localSeeds.has(gadgetId))
    if (seedGadgets.length > 0) {
      const applied = new Map(this.#applied)
      for (const gadgetId of seedGadgets) {
        applied.set(gadgetId, new Map(this.#localSeeds.get(gadgetId)!.files))
        this.#localSeeds.delete(gadgetId)
      }
      this.#applied = applied
    }

    this.#applied = applyCodeChange(this.#applied, inflight.change)
    this.#appliedRevision = accepted.revision
    this.#inflight = null
    this.#submitBackoffMs = SUBMIT_RETRY_BASE_MS
    this.#delegate.onDirtyState(false)
    this.#scheduleSubmit()
    return true
  }

  // Complete a content-preserving generation switch once the closed generation's stream is
  // finished (applied through prior.finalRevision). Content is byte-identical across the
  // boundary for every gadget except `discontinuousGadgets`; local buffers carry over -- an
  // in-flight submission rides the server's straggler bridge under its old-generation claim,
  // and the next submission waits for the pins the bridge derives (see #maybeSubmit). Returns
  // "idle" when there is nothing to do (no pending switch, or the old tail is still draining),
  // "switched" on success, and "discard" when local edits cannot be carried across (the caller
  // discards and rebuilds).
  #trySwitchGeneration(): "idle" | "switched" | "discard" {
    const target = this.#pendingSwitch
    if (target === null) return "idle"
    const prior = target.codeBase.prior!
    if (this.#appliedRevision < prior.finalRevision) return "idle"  // still draining the tail

    const discontinuous = new Set(prior.discontinuousGadgets)

    // An in-flight submission touching a discontinuous gadget is doomed -- the server rejects
    // the whole submission as bridge-ineligible -- and its content basis is gone, so nothing
    // local can be preserved either: take the discard path.
    if (this.#inflight !== null &&
        changedGadgets(this.#inflight.change).some(id => discontinuous.has(id))) {
      return "discard"
    }

    this.#pendingSwitch = null

    // Drop pending local changes touching discontinuous gadgets (the server would reject them as
    // bridge-ineligible; dropping proactively spares the rest of the buffer).
    const droppedPending = [...discontinuous].some(id => String(id) in this.#pending)
    this.#pending = dropGadgetsFromChange(this.#pending, discontinuous)

    // With nothing in flight, submit the pending buffer *now, under the closing generation's
    // claim*, so it rides the server's straggler bridge -- which derives pins from the merge's
    // recorded boundary. (A new-generation claim couldn't: the fresh epoch has no pins yet and
    // this client cannot know the boundary commits to declare.) Declarations still ride along
    // for local-seed gadgets, which were unpinned on both sides of the boundary and follow the
    // normal first-touch rule.
    if (this.#inflight === null && !isEmptyChange(this.#pending)) {
      const pins: ChatGadgetPin[] = changedGadgets(this.#pending)
        .filter(gadgetId => !this.#applied.has(gadgetId) && this.#localSeeds.has(gadgetId))
        .map(gadgetId =>
          ({ gadgetId, baseCommit: this.#localSeeds.get(gadgetId)!.baseCommit }))
      const submission: CodeChangeSubmission = {
        generation: this.#generation,
        revision: this.#appliedRevision,
        clientId: this.#clientId,
        seq: ++this.#seq,
        ...(pins.length > 0 ? { pins } : {}),
        change: this.#pending,
      }
      this.#inflight = { wire: submission, change: this.#pending }
      this.#pending = EMPTY_CHANGE
      void this.#sendInflight()
    }

    // Every pin evaporated: the merged content now lives in commits, and unpinned gadgets track
    // head live. Keep entries only for gadgets the local buffers still touch -- for those, the
    // old content equals the boundary commit's tree (that is what content-preserving means), so
    // local changes keep composing on identical content until the bridged rows re-pin them. Local
    // seeds for such gadgets survive too: they were unpinned on both sides, so their base (the
    // gadget's untouched head) still stands.
    const touched = new Set<WorkpieceId>([
      ...changedGadgets(this.#pending),
      ...(this.#inflight !== null ? changedGadgets(this.#inflight.change) : []),
    ])
    const carried: CodeContent = new Map()
    for (const gadgetId of touched) {
      if (discontinuous.has(gadgetId)) continue
      const files = this.#applied.get(gadgetId)
      if (files !== undefined) carried.set(gadgetId, files)
    }
    for (const gadgetId of this.#localSeeds.keys()) {
      if (!touched.has(gadgetId)) this.#localSeeds.delete(gadgetId)
    }
    this.#applied = carried
    this.#generation = target.codeBase.generation
    this.#appliedRevision = 0
    this.#recomputeDisplay()
    this.#delegate.onRemoteChange([])
    if (droppedPending) this.#delegate.onLocalEditsDiscarded()
    this.#scheduleSubmit()
    return "switched"
  }

  // Discard the local buffers and rebuild from the latest durable snapshot, notifying only if
  // keystrokes were actually lost.
  async #discardLocalAndRebuild(): Promise<void> {
    const hadLocalEdits = this.hasLocalEdits() || this.#localSeeds.size > 0
    await this.#rebuild(this.#latestDurable)
    if (hadLocalEdits && !this.#fatal) this.#delegate.onLocalEditsDiscarded()
  }

  // Rebuild server-acked state from a durable snapshot, dropping local buffers. This is a
  // client-session boundary: a fresh clientId, per the submitCodeChange contract.
  async #rebuild(durable: ChatDurableCode): Promise<void> {
    const codeBase = durable.codeBase ?? { pins: [], generation: 0, revision: 0 }

    // Prefetch every pin's base tree (oid-cached, so repeats are cheap).
    const bases = new Map<WorkpieceId, ReadonlyMap<string, string>>()
    try {
      await Promise.all(codeBase.pins.map(async pin => {
        bases.set(pin.gadgetId, await this.#delegate.fetchCommitFiles(pin.baseCommit))
      }))
    } catch (err) {
      if (!this.#disposed && !this.#fatal) {
        this.#fatal = true
        this.#delegate.onFatalError(err)
      }
      return
    }
    if (this.#disposed || this.#fatal) return
    if (this.#latestDurable !== durable) {
      return  // superseded while fetching; the newer snapshot's rebuild covers it
    }

    // ---- synchronous tail ----
    let content: CodeContent = new Map()
    for (const [gadgetId, files] of bases) content.set(gadgetId, new Map(files))
    if (durable.epochChange !== undefined) content = applyCodeChange(content, durable.epochChange)

    this.#applied = content
    this.#generation = codeBase.generation
    this.#appliedRevision = durable.rowsThrough
    this.#inflight = null
    this.#pending = EMPTY_CHANGE
    this.#localSeeds.clear()
    this.#pendingSwitch = null
    this.#watermarkGapSince = null
    this.#clientId = crypto.randomUUID()
    this.#seq = 0
    this.#ready = true
    this.#recomputeDisplay()
    this.#delegate.onDirtyState(false)
    this.#delegate.onRemoteChange([])
    await this.#drainHeldRows()
  }

  #recomputeDisplay(): void {
    let display = this.#applied
    if (this.#localSeeds.size > 0) {
      display = new Map(display)
      for (const [gadgetId, seed] of this.#localSeeds) {
        if (!display.has(gadgetId)) display.set(gadgetId, new Map(seed.files))
      }
    }
    if (this.#inflight !== null) display = applyCodeChange(display, this.#inflight.change)
    if (!isEmptyChange(this.#pending)) display = applyCodeChange(display, this.#pending)
    this.#display = display
  }

  // =====================================================================================
  // Local edits out

  /**
   * Seed local editing state for a gadget the chat has no content for yet (the first keystroke
   * to an unpinned gadget): keep displaying the head tree the user is looking at, and declare
   * `baseCommit` as the pin base on the next submission. No-op if content already exists. A
   * pending (chat-created) gadget needs no seed (pass its files straight to applyLocalChange).
   */
  ensureGadgetEditable(
    gadgetId: WorkpieceId, headCommitId: string | undefined,
    headFiles: ReadonlyMap<string, string>,
  ): void {
    if (this.#display.has(gadgetId) || this.#localSeeds.has(gadgetId)) return
    if (headCommitId === undefined || this.#pendingCreations.has(gadgetId)) return
    this.#localSeeds.set(gadgetId, { baseCommit: headCommitId, files: headFiles })
    const display = new Map(this.#display)
    display.set(gadgetId, new Map(headFiles))
    this.#display = display
  }

  /**
   * Apply one locally-authored change (which the editor has already applied to its own document):
   * fold it into the display and the pending buffer, and schedule a submission. The change must fit
   * the current display content -- call ensureGadgetEditable() first for a gadget the chat has
   * no content for.
   */
  applyLocalChange(change: CodeChange): void {
    if (this.#fatal || this.#disposed || !this.#ready || isEmptyChange(change)) return
    this.#display = applyCodeChange(this.#display, change)
    this.#pending = isEmptyChange(this.#pending) ? change : composeCodeChange(this.#pending, change)
    this.#scheduleSubmit()
  }

  // =====================================================================================
  // Submission

  #scheduleSubmit(): void {
    if (this.#submitScheduled) return
    this.#submitScheduled = true
    queueMicrotask(() => {
      this.#submitScheduled = false
      this.#enqueue(async () => this.#maybeSubmit())
    })
  }

  #maybeSubmit(): void {
    if (this.#fatal || this.#disposed || !this.#ready) return
    if (this.#inflight !== null || isEmptyChange(this.#pending)) return
    if (this.#pendingSwitch !== null) return  // finish the generation handoff first

    // Pin declarations: one per touched permanent gadget not yet pinned in the chat. A touched
    // gadget with no pin, no local seed, no chat content, and no pending-creation status means
    // the pin metadata hasn't reached us yet (e.g. right after an epoch reset whose bridged
    // rows re-pinned it) -- hold the submission until it does (setDurableState re-schedules).
    const pinned = new Set((this.#latestDurable.codeBase?.pins ?? []).map(pin => pin.gadgetId))
    const pins: ChatGadgetPin[] = []
    for (const gadgetId of changedGadgets(this.#pending)) {
      if (pinned.has(gadgetId) || this.#applied.has(gadgetId) ||
          this.#pendingCreations.has(gadgetId)) {
        continue
      }
      const seed = this.#localSeeds.get(gadgetId)
      if (seed === undefined) return  // wait for pin metadata
      pins.push({ gadgetId, baseCommit: seed.baseCommit })
    }

    const submission: CodeChangeSubmission = {
      generation: this.#generation,
      revision: this.#appliedRevision,
      clientId: this.#clientId,
      seq: ++this.#seq,
      ...(pins.length > 0 ? { pins } : {}),
      change: this.#pending,
    }
    this.#inflight = { wire: submission, change: this.#pending }
    this.#pending = EMPTY_CHANGE
    void this.#sendInflight()
  }

  // Send (and re-send) the in-flight submission until it is accepted or hard-rejected. Runs
  // outside the task queue: rows must keep applying (and rebasing the in-flight change) while the
  // RPC is out. Retries resend `wire` untouched -- if the previous attempt was actually
  // accepted (a lost response), the server's dedupe digest requires the identical payload; if
  // it wasn't, the server re-derives the same transforms we applied locally from the claimed
  // revision, so the untransformed change is equally correct.
  async #sendInflight(): Promise<void> {
    for (;;) {
      const inflight = this.#inflight
      if (inflight === null || this.#fatal || this.#disposed) return
      try {
        const accepted = await this.#delegate.submitCodeChange(inflight.wire)
        // Accepted. The echo row (recognized by clientId/seq) folds it into #applied and
        // clears #inflight -- normally it already has (it is broadcast before the response).
        // Record where the submission landed as the lost-echo backstop: if the row was
        // materialized while we were disconnected, no replay will ever deliver it, and the
        // drain applies our own change at that position instead (see #tryApplyInflightAck).
        if (this.#inflight === inflight) {
          inflight.accepted = accepted
          this.#enqueue(() => this.#drainHeldRows())
        }
        return
      } catch (err) {
        if (this.#disposed || this.#fatal) return
        if (this.#inflight !== inflight) return  // superseded by a rebuild
        if (this.#delegate.isTransientError(err) || isRetryableSubmitRejection(err)) {
          // Keep the queue and retry with the same seq (and identical payload) after a delay.
          this.#delegate.onDirtyState(true)
          await new Promise(resolve => setTimeout(resolve, this.#submitBackoffMs))
          this.#submitBackoffMs = Math.min(this.#submitBackoffMs * 2, SUBMIT_RETRY_MAX_MS)
          continue
        }
        // Hard rejection: a destructive bump raced us, a pin declaration lost its race, the
        // transform window aged out, or a protocol violation. Discard local edits and rebuild
        // under a fresh clientId (see Overseer.submitCodeChange).
        console.error('Code submission rejected; discarding local edits:', err)
        this.#enqueue(() => this.#discardLocalAndRebuild())
        return
      }
    }
  }

  // =====================================================================================

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#disposed) return
      try {
        await task()
      } catch (err) {
        if (!this.#disposed && !this.#fatal) {
          this.#fatal = true
          this.#delegate.onFatalError(err)
        }
      }
    })
  }
}
