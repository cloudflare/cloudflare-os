// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import type { AutoApprovalRules } from './autoApprovalRules'
import type { PendingChange } from './pendingChangeGroups'
import type { ActionOutcome } from './useActionOutcomes'
import { describeBulkFailure, useBulkResolve, type BulkResolve } from './useBulkResolve'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const APPEND = { tag: 'append', label: 'Append a slide' }

function request(id: number, autoApprovable = false, gatekeeperId = 1): PendingChange {
  return {
    id,
    gatekeeperId,
    resourceTitle: 'Road trip 2026',
    createdAt: new Date('2026-11-11T00:00:00Z'),
    state: 'pending',
    type: 'action',
    description: {
      title: `Write ${id}`, description: '', implementsRevert: false,
      autoApprovable, actionKind: APPEND,
    },
  } as PendingChange
}

/** No rule covers anything, which is every case but the drain tests. */
const NO_RULES: AutoApprovalRules = { isEnabled: () => false, restricted: false }

/** A rule covers the "append" kind on connection 1, as the drain would see it. */
const APPEND_COVERED: AutoApprovalRules = {
  isEnabled: (gatekeeperId, tag) => gatekeeperId === 1 && tag === 'append',
  restricted: false,
}

/**
 * Mounts the hook over an overseer that records every decision in the order it arrives and
 * settles it only when the test says so, so interleaving is observable rather than assumed.
 */
async function mount(
  live?: { pending: number[], records?: PendingChange[] },
  initialRules: AutoApprovalRules = NO_RULES,
) {
  const calls: string[] = []
  // How requests were resolved elsewhere, which the real hook learns from the entry stream.
  const outcomes = new Map<number, ActionOutcome>()
  const parked: Array<{ resolve: () => void, reject: (err: unknown) => void }> = []
  const park = (label: string) => {
    calls.push(label)
    return new Promise<void>((resolve, reject) => parked.push({ resolve, reject }))
  }
  const overseer = {
    approveAction: (id: number) => park(`approve:${id}`),
    rejectAction: (id: number) => park(`reject:${id}`),
  } as unknown as RpcStub<Overseer>

  let bulk: BulkResolve | undefined
  let rerender: (() => void) | undefined
  let applyRules: ((rules: AutoApprovalRules) => void) | undefined
  let applyRulesReady: ((ready: boolean) => void) | undefined
  const Probe = () => {
    const [, tick] = useState(0)
    const [rules, setRules] = useState(initialRules)
    const [rulesReady, setRulesReady] = useState(true)
    rerender = () => tick(n => n + 1)
    applyRules = setRules
    applyRulesReady = setRulesReady
    // Without a live snapshot the hook is told the set is not ready, which is how it behaves
    // before the subscription settles: it trusts nothing and sends every decision itself. Ids
    // alone stand in where only membership matters; `records` supplies the real entries for the
    // tests that turn on what a rule covers.
    bulk = useBulkResolve(overseer, {
      pending: (live?.pending ?? []).map(id =>
        live?.records?.find(record => record.id === id) ?? ({ id } as PendingChange)),
      pendingReady: live !== undefined,
      rules,
      rulesReady,
      outcome: (id: number) => outcomes.get(id),
    })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))

  return {
    calls,
    get current() { return bulk! },
    /**
     * Starts a run and flushes the state it sets before its first await, so the test sees the
     * progress a user would. The returned promise settles once every decision has.
     */
    start(entries: PendingChange[], decision: 'approve' | 'deny') {
      let run!: Promise<void>
      act(() => { run = bulk!.run(entries, decision) })
      return run
    },
    /** Changes the workspace's rules, as the Activity switches would mid-run. */
    async setRules(rules: AutoApprovalRules) {
      await act(async () => applyRules!(rules))
    },
    /** Loses or regains the rule list, as a refresh that fails or recovers would. */
    async setRulesReady(ready: boolean) {
      await act(async () => applyRulesReady!(ready))
    },
    /** Approves a request elsewhere, as the drain or a collaborator would. */
    async resolveElsewhere(id: number) {
      if (!live) throw new Error('No live snapshot')
      outcomes.set(id, 'approved')
      live.pending = live.pending.filter(other => other !== id)
      await act(async () => rerender!())
    },
    /** Someone else denies a request, which the subscription reports as a rejection. */
    async rejectElsewhere(id: number) {
      if (!live) throw new Error('No live snapshot')
      outcomes.set(id, 'rejected')
      live.pending = live.pending.filter(other => other !== id)
      await act(async () => rerender!())
    },
    /**
     * Approves a request elsewhere in a hidden tab: the entry stream reports it, but the pending
     * snapshot is rebuilt only on an animation frame, so it does not move and nothing renders.
     */
    resolveUnseen(id: number) {
      outcomes.set(id, 'approved')
    },
    /** Settles the oldest decision still in flight. */
    async settle(err?: unknown) {
      const next = parked.shift()
      if (!next) throw new Error('No decision in flight')
      await act(async () => err === undefined ? next.resolve() : next.reject(err))
    },
  }
}

describe('useBulkResolve', () => {
  it('resolves one at a time, in the order given', async () => {
    const harness = await mount()
    const run = harness.start([request(1), request(2), request(3)], 'approve')

    // Never concurrent: the next decision is not sent until the previous one returns, because
    // the workspace object's input gate is open across each gatekeeper call.
    expect(harness.calls).toEqual(['approve:1'])
    await harness.settle()
    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    await harness.settle()
    await harness.settle()
    await run

    expect(harness.calls).toEqual(['approve:1', 'approve:2', 'approve:3'])
    expect(harness.current.progress).toBeNull()
    expect(harness.current.failure).toBeNull()
  })

  it('reports how far a run has got while it runs', async () => {
    const harness = await mount()
    const run = harness.start([request(1), request(2)], 'deny')

    expect(harness.current.progress).toEqual({ decision: 'deny', done: 0, total: 2 })
    await harness.settle()
    expect(harness.current.progress).toEqual({ decision: 'deny', done: 1, total: 2 })
    await harness.settle()
    await run
  })

  it('stops at the first failure and says what it managed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mount()
    const run = harness.start([request(1), request(2), request(3)], 'approve')

    await harness.settle()
    await harness.settle(new Error('The provider failed.'))
    // A failure is only reported once the run has given the pending set its moment to catch up,
    // so the state lands after the decision rather than inside it.
    await act(async () => { await run })

    // Nothing past the failure: each request was described against a world where the earlier
    // ones landed, so applying #3 over a failed #2 would apply it to a state nobody checked.
    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    expect(harness.current.failure).toEqual({
      decision: 'approve', applied: 1, total: 3, title: 'Write 2', reason: 'The provider failed.',
    })
    expect(describeBulkFailure(harness.current.failure!))
      .toBe('Applied 1 of 3. "Write 2" failed: The provider failed.')
  })

  it('stops an apply when someone else denies a request it was going to skip', async () => {
    const harness = await mount({ pending: [1, 2, 3] })
    const run = harness.start([request(1), request(2), request(3)], 'approve')

    // Denied by another approver while #1's call is still out. Gone from the pending set is not
    // the outcome this run wanted: #3 was described against a world where #2's effect landed,
    // and a run that skipped #2 in silence would apply #3 over a state nobody produced.
    await harness.rejectElsewhere(2)
    await harness.settle()
    await act(async () => { await run })

    expect(harness.calls).toEqual(['approve:1'])
    expect(harness.current.failure).toEqual({
      decision: 'approve', applied: 1, total: 3,
      reason: '"Write 2" was denied elsewhere, so the rest were left alone.',
    })
    expect(describeBulkFailure(harness.current.failure!)).toBe(
      'Applied 1 of 3. "Write 2" was denied elsewhere, so the rest were left alone.')
  })

  it('discards past a request someone else denied, since that is what it wanted', async () => {
    const harness = await mount({ pending: [1, 2, 3] })
    const run = harness.start([request(1), request(2), request(3)], 'deny')

    // Newest first, so #3 is in flight. A withdrawal applies nothing, so nothing here was built
    // on #2 having landed and a denial elsewhere is simply the outcome already asked for.
    await harness.rejectElsewhere(2)
    await harness.settle()
    await harness.settle()
    await run

    expect(harness.calls).toEqual(['reject:3', 'reject:1'])
    expect(harness.current.failure).toBeNull()
  })

  it('refuses to start a second run over the first', async () => {
    const harness = await mount()
    const first = harness.start([request(1), request(2)], 'approve')
    await harness.start([request(3)], 'deny')

    expect(harness.calls).toEqual(['approve:1'])
    await harness.settle()
    await harness.settle()
    await first
  })

  it('clears a previous failure when the next run starts, and on demand', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mount()
    const failing = harness.start([request(1)], 'approve')
    await harness.settle(new Error('nope'))
    await act(async () => { await failing })
    expect(harness.current.failure).not.toBeNull()

    act(() => harness.current.dismissFailure())
    expect(harness.current.failure).toBeNull()

    const failingAgain = harness.start([request(1)], 'approve')
    await harness.settle(new Error('nope'))
    await act(async () => { await failingAgain })
    expect(harness.current.failure).not.toBeNull()

    const clean = harness.start([request(2)], 'approve')
    expect(harness.current.failure).toBeNull()
    await harness.settle()
    await clean
  })

  it('withdraws newest first, so the drain is never released onto what it is discarding', async () => {
    // `[manual 1, covered 2]`. Withdrawing 1 first would kick the drain onto 2 -- the request the
    // user just asked to discard -- before its own withdrawal arrived. The gate goes last.
    const harness = await mount(
      { pending: [1, 2], records: [request(1), request(2, true)] }, APPEND_COVERED)
    const run = harness.start([request(1), request(2, true)], 'deny')

    await harness.settle()
    await harness.settle()
    await run

    expect(harness.calls).toEqual(['reject:2', 'reject:1'])
    expect(harness.current.failure).toBeNull()
  })

  it('says a discarded request was applied, when the drain had it first', async () => {
    // A drain already applying 1 is invisible from here. The workspace refuses a withdrawal on
    // a request whose apply is still in flight; once that apply lands, the run says what the user
    // is owed knowing -- it was applied, not discarded -- rather than the refusal it got.
    vi.useFakeTimers()
    const queue = [request(1, true), request(2)]
    const harness = await mount({ pending: [1, 2], records: queue }, APPEND_COVERED)
    const run = harness.start(queue, 'deny')

    await harness.settle()
    await harness.settle(new Error('Action is not pending: 1'))
    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await run

    expect(harness.calls).toEqual(['reject:2', 'reject:1'])
    expect(harness.current.failure).toEqual({
      decision: 'deny', applied: 1, total: 2,
      reason: '"Write 1" was applied before it could be discarded, so the rest were left alone.',
    })
  })

  it('gives the drain its turn on a covered request, then decides it itself', async () => {
    // [gate 1, covered 2]. Running out of patience proves nothing: the drain may be slow, or may
    // have stopped at a gate this run is not deciding. The run sends its own approval, which the
    // workspace refuses if the drain is still applying 2, so the wait is about order, not safety.
    vi.useFakeTimers()
    const harness = await mount({ pending: [1, 2] }, APPEND_COVERED)
    const run = harness.start([request(1), request(2, true)], 'approve')

    await harness.settle()
    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(harness.calls).toEqual(['approve:1'])

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    await harness.settle()
    await run

    expect(harness.current.failure).toBeNull()
  })

  it('carries on once a slow drain lands the request it refused the run over', async () => {
    // [gate 1, covered 2, gate 3]. The drain is still mid-apply on 2 when the wait runs out, so
    // the run's own approval is refused. That is the drain doing what the user asked, slowly: the
    // run waits for it to land and then sends 3, which stacks on it.
    vi.useFakeTimers()
    const harness = await mount({ pending: [1, 2, 3] }, APPEND_COVERED)
    const run = harness.start([request(1), request(2, true), request(3)], 'approve')

    await harness.settle()
    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await harness.settle(new Error('Action is not pending: 2'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(harness.calls).toEqual(['approve:1', 'approve:2'])

    await harness.resolveElsewhere(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(harness.calls).toEqual(['approve:1', 'approve:2', 'approve:3'])
    await harness.settle()
    await run

    expect(harness.current.failure).toBeNull()
  })

  it('reports a refusal whose request never lands, and sends nothing past it', async () => {
    // Nothing resolves 2 in the time the drain is given -- a provider call that hangs, or a
    // refusal that was not about another decision at all. 3 stacks on 2, so it is not sent.
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mount({ pending: [1, 2, 3] }, APPEND_COVERED)
    const run = harness.start([request(1), request(2, true), request(3)], 'approve')

    await harness.settle()
    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await harness.settle(new Error('Action is not pending: 2'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await run

    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    expect(harness.current.failure).toEqual({
      decision: 'approve', applied: 1, total: 3, title: 'Write 2', reason: 'Action is not pending: 2',
    })
  })

  it('sees the drain take a request in a hidden tab, where the snapshot stands still', async () => {
    // A background tab may draw no animation frames, so the pending snapshot never shows 2
    // leaving. The entry stream still says it was applied, and that is enough to move on rather
    // than wait out the drain's turn, send a decision of its own and report the refusal.
    vi.useFakeTimers()
    const harness = await mount({ pending: [1, 2, 3] }, APPEND_COVERED)
    const run = harness.start([request(1), request(2, true), request(3)], 'approve')

    await harness.settle()
    harness.resolveUnseen(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(harness.calls).toEqual(['approve:1', 'approve:3'])
    await harness.settle()
    await run

    expect(harness.current.failure).toBeNull()
  })

  it('counts only what it decided when it reports a partial run', async () => {
    // [gate 1, covered 2, gate 3]: the drain takes 2 and 3 fails. One request applied by this
    // run, however far down the queue it got.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mount({ pending: [1, 2, 3] }, APPEND_COVERED)
    const run = harness.start([request(1), request(2, true), request(3)], 'approve')

    await harness.settle()
    await harness.resolveElsewhere(1)
    await harness.resolveElsewhere(2)
    await vi.waitFor(() => expect(harness.calls).toEqual(['approve:1', 'approve:3']))
    await harness.settle(new Error('nope'))
    await act(async () => { await run })

    expect(harness.current.failure).toMatchObject({ applied: 1, total: 3, title: 'Write 3' })
    expect(describeBulkFailure(harness.current.failure!))
      .toBe('Applied 1 of 3. "Write 3" failed: nope')
  })

  it('does not report a failure for a request resolved just before its decision', async () => {
    // The pending set lags whoever resolved it, so the request still looks pending when the run
    // decides it and the backend refuses. That is the outcome the user asked for, not a failure.
    vi.useFakeTimers()
    const harness = await mount({ pending: [1, 2] })
    const run = harness.start([request(1), request(2)], 'approve')

    await harness.settle(new Error('Action is not pending: 1'))
    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    await harness.settle()
    await run

    expect(harness.current.failure).toBeNull()
  })

  it('gives the drain its turn even at the head of a fresh run', async () => {
    // The kernel starts a drain the moment a covered request is submitted, so one can be mid-
    // apply before this run exists. [covered 1, manual 2]: 2 stacks on 1, so it waits too.
    vi.useFakeTimers()
    const harness = await mount({ pending: [1, 2] }, APPEND_COVERED)
    const run = harness.start([request(1, true), request(2)], 'approve')

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(harness.calls).toEqual([])

    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(harness.calls).toEqual(['approve:2'])
    await harness.settle()
    await run
  })

  it('waits for the drain to take a covered request before sending the next gate', async () => {
    // [gate 1, covered 2, gate 3] on one connection. Approving 1 kicks the drain, which applies
    // 2 detached from our call. Sending 3 meanwhile would apply it over a request that was its
    // prerequisite, which is the ordering the sequential loop exists to keep.
    const harness = await mount({ pending: [1, 2, 3] }, APPEND_COVERED)
    const run = harness.start(
      [request(1), request(2, true), request(3)], 'approve')

    await harness.settle()
    await harness.resolveElsewhere(1)
    expect(harness.calls).toEqual(['approve:1'])

    // Still nothing: the drain has not finished with 2.
    await harness.resolveElsewhere(2)
    await vi.waitFor(() => expect(harness.calls).toEqual(['approve:1', 'approve:3']))
    await harness.settle()
    await run

    expect(harness.current.failure).toBeNull()
  })

  it('skips a request something else resolved while the run was in flight', async () => {
    const harness = await mount({ pending: [1, 2] })
    const run = harness.start([request(1), request(2)], 'approve')

    await harness.resolveElsewhere(2)
    await harness.settle()
    await run

    // No second call, and no "failed" for a request that is no longer waiting on anyone.
    expect(harness.calls).toEqual(['approve:1'])
    expect(harness.current.failure).toBeNull()
  })

  it('reads the rules live, so one enabled mid-run gives the drain that request', async () => {
    // [gate 1, auto-approvable 2 with its rule off, gate 3]. Turning the rule on while 1 is in
    // flight makes the backend start applying 2; a run still holding the old snapshot would race
    // it there and stop on the refusal.
    vi.useFakeTimers()
    const harness = await mount({ pending: [1, 2, 3] })
    const run = harness.start([request(1), request(2, true), request(3)], 'approve')

    expect(harness.calls).toEqual(['approve:1'])
    await harness.setRules(APPEND_COVERED)
    await harness.settle()
    await harness.resolveElsewhere(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(harness.calls).toEqual(['approve:1'])

    await harness.resolveElsewhere(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(harness.calls).toEqual(['approve:1', 'approve:3'])
    await harness.settle()
    await run
  })

  it('waits for what a rule could cover while the rule list is unreadable', async () => {
    // A refresh that fails empties the rule list, and a rule a collaborator enabled may never
    // have reached this client at all -- so a list nobody can read is not a list saying "no
    // rule covers this". [gate 1, auto-approvable 2]: the list goes unreadable while 1 is in
    // flight, and 2 gets the drain's turn rather than a race.
    vi.useFakeTimers()
    const queue = [request(1), request(2, true)]
    const harness = await mount({ pending: [1, 2], records: queue }, NO_RULES)
    const run = harness.start(queue, 'approve')

    expect(harness.calls).toEqual(['approve:1'])
    await harness.setRulesReady(false)
    await harness.settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(harness.calls).toEqual(['approve:1'])

    await harness.resolveElsewhere(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await run
    expect(harness.current.failure).toBeNull()
  })

  it('stops applying when the restricted-data latch turns on under it', async () => {
    // An observation the agent makes sets the latch, so it can land mid-run. The tray drops its
    // bulk controls the moment it does; a run already going would otherwise carry on applying a
    // batch the user authorised over a workspace that had not read sensitive data yet.
    const harness = await mount({ pending: [1, 2, 3] })
    const run = harness.start([request(1), request(2), request(3)], 'approve')

    await harness.settle()
    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    await harness.setRules({ isEnabled: () => false, restricted: true })
    await harness.settle()
    await run

    expect(harness.calls).toEqual(['approve:1', 'approve:2'])
    expect(harness.current.failure).toEqual({
      decision: 'approve', applied: 2, total: 3,
      reason: 'This workspace has read sensitive data, so the rest are reviewed on their own.',
    })
    expect(describeBulkFailure(harness.current.failure!)).toBe(
      'Applied 2 of 3. This workspace has read sensitive data, so the rest are reviewed on their own.')
  })

  it('reads the latch again after waiting on the drain, before approving anything', async () => {
    // [covered 1, manual 2]. The run waits on 1 for the drain, and the latch lands meanwhile --
    // the drain stops for it, so 1 is still here when the wait runs out. The kernel honours an
    // explicit approval while restricted, so the approval the run would send next is exactly
    // the batch apply restricted mode rules out.
    vi.useFakeTimers()
    const queue = [request(1, true), request(2)]
    const harness = await mount({ pending: [1, 2], records: queue }, APPEND_COVERED)
    const run = harness.start(queue, 'approve')

    await harness.setRules({ isEnabled: () => true, restricted: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await run

    expect(harness.calls).toEqual([])
    expect(harness.current.failure).toEqual({
      decision: 'approve', applied: 0, total: 2,
      reason: 'This workspace has read sensitive data, so the rest are reviewed on their own.',
    })
  })

  it('carries on discarding while restricted, since withdrawing applies nothing', async () => {
    const harness = await mount({ pending: [1, 2] }, { isEnabled: () => false, restricted: true })
    const run = harness.start([request(1), request(2)], 'deny')

    await harness.settle()
    await harness.settle()
    await run

    expect(harness.calls).toEqual(['reject:2', 'reject:1'])
    expect(harness.current.failure).toBeNull()
  })

  it('does nothing when given no requests', async () => {
    const harness = await mount()
    await harness.start([], 'approve')

    expect(harness.calls).toEqual([])
    expect(harness.current.progress).toBeNull()
  })
})
