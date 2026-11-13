import { useCallback, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'
import { couldBeAutoApproved, isAutoApproved, type AutoApprovalRules } from './autoApprovalRules'
import type { PendingChange } from './pendingChangeGroups'
import type { ActionOutcome } from './useActionOutcomes'

/** Which way a bulk run resolves the requests it is given. */
export type BulkDecision = 'approve' | 'deny'

/** A run in flight: how many of `total` requests have been resolved so far. */
export interface BulkProgress {
  decision: BulkDecision
  done: number
  total: number
}

/** Where a run stopped, and what stopped it. */
export interface BulkFailure {
  decision: BulkDecision
  /**
   * How many requests the run actually decided, which is not how far down the queue it got: a
   * request the drain applied, or one someone else resolved, is not an effect this run landed.
   */
  applied: number
  total: number
  /**
   * The request that failed, so the message can name it rather than an opaque id. Absent when
   * nothing failed: a run the workspace itself stopped got no further than between requests.
   */
  title?: string
  /** Absent when the failure was transient (a dropped connection), which says nothing useful. */
  reason?: string
}

/**
 * Why a run stops when the restricted-data latch turns on under it.
 *
 * The latch is set by an observation the agent makes (`overseer.ts`), so it can land mid-run, and
 * it means every remaining request is to be read on its own. The kernel still honours an explicit
 * approval — the latch only disables the automatic ones — so nothing refuses these for us. The
 * user authorised a batch over a workspace that had not yet read sensitive data, and that is no
 * longer the workspace they authorised it over.
 */
const RESTRICTED_STOP =
  'This workspace has read sensitive data, so the rest are reviewed on their own.'

/**
 * How long a run waits for the drain to take a request a rule covers.
 *
 * The drain is kicked by the decision before it and runs detached from that call, so there is no
 * reply to await, only the request's entry arriving resolved. Waiting out this window gives the
 * drain the request's turn rather than racing it there. Running out of it proves nothing — a
 * provider call can simply be slow, or the drain may have stopped at a gate this run is not
 * deciding — so the run then sends its own decision. The workspace refuses that if the drain is
 * still applying the request, and the run waits this long again for the drain to land it.
 */
const DRAIN_WAIT_MS = 10_000
const DRAIN_POLL_MS = 100

/**
 * How long a refused decision waits for the decision that beat it to land, before the refusal
 * counts as a failure.
 *
 * The workspace refuses a decision on a request someone else has resolved or is still deciding.
 * One already resolved is known by the time the refusal arrives — its entry comes ahead of it on
 * the same connection — so this is for one still in flight elsewhere. A request a rule covers is
 * given the drain's wait instead, since the drain is the likeliest thing deciding it.
 */
const RESOLVED_ELSEWHERE_SETTLE_MS = 250

export interface BulkResolve {
  /**
   * Resolves `entries`, in submission order to apply and newest first to discard. Returns when
   * the run ends, successfully or not; a run already in flight is not restarted.
   */
  run: (entries: readonly PendingChange[], decision: BulkDecision) => Promise<void>
  progress: BulkProgress | null
  failure: BulkFailure | null
  dismissFailure: () => void
}

/** What a run reads as it goes. All of it live: none of it is captured when the run starts. */
export interface BulkInputs {
  /** The workspace's pending requests, from the action subscription. */
  pending: readonly ActionLogEntry[]
  /** Whether that set has loaded. An unready one counts as "still pending". */
  pendingReady: boolean
  /** The workspace's auto-approval rules. */
  rules: AutoApprovalRules
  /** Whether the rule list is loaded and current. An unready one claims nothing. */
  rulesReady: boolean
  /**
   * How the request with this id was resolved, as soon as the workspace said so, or undefined if
   * this view has not seen it resolved (see `useActionOutcomes`).
   *
   * Ahead of `pending`, which is rebuilt once per frame and not at all in a hidden tab. A request
   * with an outcome is gone, whatever the snapshot still says.
   */
  outcome: (id: number) => ActionOutcome | undefined
}

/**
 * Resolves a list of pending requests one at a time.
 *
 * **Never concurrently.** The workspace object's input gate is open across the gatekeeper call
 * each decision makes, so parallel decisions interleave inside it and apply out of order — the
 * same reason `AutoApprovalDrainer` is single-flight.
 *
 * A run stops at the first failure instead of carrying on. Requests stack: a later one was
 * described against a world where the earlier ones landed, so applying past a failure would
 * apply something to a state it was never checked against. The partial result is reported rather
 * than rolled back — nothing here is transactional across a gatekeeper's side effects, and a
 * batch RPC would only hide that. A request someone else resolves the other way stops a run for
 * the same reason, and the run says which: rejected under an apply, the effect the rest were
 * built on never happened; applied under a discard, the user is owed being told it landed.
 *
 * Nothing here is what stops a request being decided twice. The workspace claims each decision
 * until it lands and refuses a second one meanwhile, whoever sends it — this run, another
 * surface, another tab, or the auto-approval drain. What a run has to get right is order, and
 * saying what actually happened.
 *
 * The drain is the other thing resolving these requests, and it is detached from every call this
 * client makes: the kernel starts one for a request a rule covers the moment it is submitted, and
 * again whenever a decision clears a manual gate ahead of it. So an apply waits for each covered
 * request to leave the pending set, which is the drain taking it, before sending the next one,
 * which stacks on it. If the wait runs out the run sends its own decision. A drain still applying
 * the request turns that into a refusal, and the run gives the drain the same time again to land
 * it, then carries on.
 *
 * Discarding needs no such wait: it goes newest first, so by the time the oldest gate is
 * withdrawn — the withdrawal that would release the drain — there is nothing left for the drain
 * to apply. Withdrawing carries no ordering of its own, and oldest first would let the drain
 * apply the very requests the user asked to discard.
 *
 * Everything in `inputs` is read live rather than captured, because all of it can change under a
 * run that takes a provider call per request:
 *
 * - Enabling a rule mid-run hands its requests to the drain, so once the rule list has been
 *   re-read the run gives the drain their turn rather than racing it to them. Until then it can
 *   still race the drain to one, and a refusal it is not waiting long for stops the run; that is
 *   the price of not holding every run back while a rule change settles.
 * - Losing the rule list — a refresh that fails clears it — is not the same as reading "no rule
 *   covers this". While it is unreadable, anything a rule *could* cover is waited for, which also
 *   covers a rule a collaborator enabled that this client never managed to read.
 * - An unready pending set means no request is skipped on the strength of a snapshot that has
 *   not loaded.
 */
export function useBulkResolve(
  overseer: RpcStub<Overseer>,
  inputs: BulkInputs,
): BulkResolve {
  const { pending, pendingReady, rules, rulesReady, outcome } = inputs
  const [progress, setProgress] = useState<BulkProgress | null>(null)
  const [failure, setFailure] = useState<BulkFailure | null>(null)
  // Guards against a second run starting from a click that lands while the first is mid-flight;
  // state alone would not, since it is not updated until React re-renders.
  const running = useRef(false)
  // Read inside the run loop, which outlives the render that started it.
  const live = useRef({ ids: new Set<number>(), pendingReady, rules, rulesReady, outcome })
  live.current = {
    ids: new Set(pending.map(entry => entry.id)), pendingReady, rules, rulesReady, outcome,
  }

  const run = useCallback(async (
    entries: readonly PendingChange[], decision: BulkDecision,
  ) => {
    if (running.current || entries.length === 0) return
    running.current = true
    const queue = decision === 'approve' ? [...entries] : [...entries].toReversed()
    const total = queue.length
    setFailure(null)
    setProgress({ decision, done: 0, total })

    const stillPending = (id: number) => live.current.outcome(id) === undefined &&
      (!live.current.pendingReady || live.current.ids.has(id))
    // Resolved the other way from what this run is doing: rejected under an apply, applied under
    // a discard. Either way the run stops there and says so.
    const opposed = (entry: PendingChange) =>
      live.current.outcome(entry.id) === (decision === 'approve' ? 'rejected' : 'approved')
    const stopForOpposed = (entry: PendingChange) => setFailure({
      decision, applied, total,
      reason: decision === 'approve'
        ? `"${entry.description.title}" was denied elsewhere, so the rest were left alone.`
        : `"${entry.description.title}" was applied before it could be discarded, so the rest were left alone.`,
    })
    // Whether the drain may take this request. With the rule list unreadable, anything a rule
    // could cover counts, since the rule that covers it may be one this client never got to read.
    const drainMayTake = (entry: PendingChange) => live.current.rulesReady
      ? isAutoApproved(entry, live.current.rules)
      : couldBeAutoApproved(entry, live.current.rules)
    // Decisions this run actually sent, which is not how far down the queue it got.
    let applied = 0

    try {
      for (const [done, entry] of queue.entries()) {
        setProgress({ decision, done, total })
        // Resolved while the run was in flight -- by the drain, a collaborator, another tab. The
        // way this run wanted, there is nothing left to do; the other way, see `opposed`.
        if (!stillPending(entry.id)) {
          if (opposed(entry)) { stopForOpposed(entry); return }
          continue
        }

        // Applying takes the drain's turn into account; this run clears gates as it goes, and
        // each one it clears can start the drain on the request behind it.
        if (decision === 'approve' && drainMayTake(entry)) {
          await waitUntilGone(() => stillPending(entry.id), DRAIN_WAIT_MS)
          if (!stillPending(entry.id)) {
            if (opposed(entry)) { stopForOpposed(entry); return }
            continue
          }
        }

        // The latch can land mid-run, and it means the rest are read on their own. Read here,
        // with nothing left to await before the approval goes out, because the wait above can
        // outlast it and the kernel still honours an explicit approval while restricted.
        // Discarding is left alone: withdrawing a request applies nothing, and stopping would
        // strand the queue half-discarded.
        if (decision === 'approve' && live.current.rules.restricted) {
          setFailure({ decision, applied, total, reason: RESTRICTED_STOP })
          return
        }

        try {
          if (decision === 'approve') await overseer.approveAction(entry.id)
          else await overseer.rejectAction(entry.id)
        } catch (error) {
          // Refused, most likely, because another decision got there first or holds the request
          // now. Wait for that one to land and act on what it was, rather than report a refusal
          // the user can do nothing with.
          await waitUntilGone(() => stillPending(entry.id),
            drainMayTake(entry) ? DRAIN_WAIT_MS : RESOLVED_ELSEWHERE_SETTLE_MS)
          if (!stillPending(entry.id)) {
            if (opposed(entry)) { stopForOpposed(entry); return }
            continue
          }
          console.error(`Failed to ${decision} action ${entry.id}:`, error)
          setFailure({
            decision, applied, total,
            title: entry.description.title,
            reason: rpcFailureDescription(error),
          })
          return
        }
        applied++
      }
    } finally {
      running.current = false
      setProgress(null)
    }
  }, [overseer])

  const dismissFailure = useCallback(() => setFailure(null), [])

  return { run, progress, failure, dismissFailure }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Polls until the request has left the pending set, or until `ms` have passed. */
async function waitUntilGone(stillPending: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (stillPending() && Date.now() < deadline) {
    await sleep(DRAIN_POLL_MS)
  }
}

/** How a finished or in-flight run describes itself. */
export function describeBulkProgress({ decision, done, total }: BulkProgress): string {
  return decision === 'approve' ? `Applying ${done + 1} of ${total}…` : `Discarding ${done + 1} of ${total}…`
}

/** How a stopped run describes what it managed before it stopped. */
export function describeBulkFailure(
  { decision, applied, total, title, reason }: BulkFailure,
): string {
  const verb = decision === 'approve' ? 'Applied' : 'Discarded'
  const got = `${verb} ${applied} of ${total}.`
  if (title === undefined) return `${got} ${reason ?? 'The run stopped.'}`
  return `${got} "${title}" failed${reason ? `: ${reason}` : '.'}`
}
