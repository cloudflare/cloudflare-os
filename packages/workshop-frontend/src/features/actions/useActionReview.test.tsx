// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  ACTION_ERROR_CODES,
  ACTION_ERROR_MESSAGES,
  createActionError,
  type Overseer,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({ addToast: vi.fn<(toast: unknown) => void>() }))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

import { entry, flushFrames, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { UNKNOWN_BATCH_ERROR, useActionReview, type ActionReview } from './useActionReview'

const view = makeTestRoot()
let review: ActionReview

const Probe = ({ overseer, workspaceId = 'ws', active = true, connected = true }: {
  overseer: RpcStub<Overseer> | null
  workspaceId?: string
  active?: boolean
  connected?: boolean
}) => {
  review = useActionReview(overseer, { workspaceId, active, connected })
  return null
}

const group = (gatekeeperId: number) =>
  review.groups.find(g => g.gatekeeperId === gatekeeperId)!

const ids = (records: readonly { id: number }[]) => records.map(record => record.id)

// Connection 1 submitted 10/30/50, connection 0 submitted 0. Creation times are deliberately out
// of id order: the gatekeeper's publication order is the id order, not the clock.
const at = (minutes: number) => new Date(1700000000000 + minutes * 60_000)
const a10 = entry(10, { gatekeeperId: 1, createdAt: at(5) })
const a30 = entry(30, { gatekeeperId: 1, createdAt: at(1) })
const a50 = entry(50, { gatekeeperId: 1, createdAt: at(3) })
const b0 = entry(0, { gatekeeperId: 0, createdAt: at(2) })

/** A settled review of connection 1 (10/30/50) and connection 0 (0), boundaries captured. */
async function settledReview() {
  const server = makeOverseer()
  await view.render(<Probe overseer={server.overseer} />)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [a50, a30], nextBeforeId: 30 })
  await server.resolvePendingQuery({ entries: [b0, a10] })
  flushFrames()
  return server
}

afterEach(() => {
  view.cleanup()
  testState.addToast.mockClear()
  vi.restoreAllMocks()
})

describe('useActionReview batches', () => {
  it('reviews a connection in id order and applies through its own boundary', async () => {
    const server = makeOverseer()
    await view.render(<Probe overseer={server.overseer} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [a50, a30], nextBeforeId: 30 })
    flushFrames()

    // An incomplete pending snapshot can authorize nothing: a boundary captured now would cover
    // rows the user has not seen.
    expect(review.canEdit).toBe(false)
    expect(review.groups.flatMap(g => g.actions)).toEqual([])

    await server.resolvePendingQuery({ entries: [b0, a10] })
    flushFrames()

    expect(review.canEdit).toBe(true)
    expect(ids(group(1).actions)).toEqual([10, 30, 50])
    expect(group(1).throughId).toBe(50)
    expect(group(0).throughId).toBe(0)

    act(() => review.setVeto(1, 30, true))

    expect(group(1).vetoIds).toEqual([30])
    expect(ids(group(1).actions)).toEqual([10, 30, 50])
    expect(server.applyCalls).toEqual([])

    await act(async () => { void review.applyBatch(1) })
    await server.resolveApply()

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [30] }])
  })

  it('keeps the boundary when every included action is vetoed', async () => {
    const server = await settledReview()
    act(() => {
      review.setVeto(1, 10, true)
      review.setVeto(1, 30, true)
      review.setVeto(1, 50, true)
    })

    await act(async () => { void review.applyBatch(1) })
    await server.resolveApply()

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [10, 30, 50] }])
  })

  it('freezes arrivals behind an explicit inclusion and keeps drafts across tab switches', async () => {
    const server = await settledReview()
    act(() => review.setVeto(1, 30, true))
    await server.emit(entry(70, { gatekeeperId: 1, createdAt: at(9) }))
    await server.emit(entry(80, { gatekeeperId: 3, createdAt: at(10) }))
    flushFrames()

    expect(ids(group(1).actions)).toEqual([10, 30, 50])
    expect(ids(group(1).newActions)).toEqual([70])
    expect(ids(group(3).actions)).toEqual([])
    expect(group(3).throughId).toBeUndefined()

    await act(async () => { void review.applyBatch(1) })
    await server.resolveApply()
    await act(async () => { void review.applyBatch(3) })

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [30] }])

    // A successful batch never widens the boundary; closing the pane never loses the draft.
    await view.render(<Probe overseer={server.overseer} active={false} />)
    await view.render(<Probe overseer={server.overseer} />)

    expect(ids(group(1).actions)).toEqual([10, 30, 50])
    expect(group(1).vetoIds).toEqual([30])

    act(() => review.includeNewActions(1))

    expect(ids(group(1).actions)).toEqual([10, 30, 50, 70])
    expect(group(1).vetoIds).toEqual([30])
    expect(ids(group(3).actions)).toEqual([])
  })

  it('discards the draft when the workspace changes', async () => {
    const server = await settledReview()
    act(() => review.setVeto(1, 30, true))

    await view.render(<Probe overseer={server.overseer} workspaceId="other" />)

    expect(group(1).vetoIds).toEqual([])
  })

  it('reconciles decisions made elsewhere without advancing the boundary', async () => {
    const server = await settledReview()
    act(() => review.setVeto(1, 30, true))
    await server.emit(entry(30, { gatekeeperId: 1, createdAt: at(1), state: 'rejected' }))
    await server.emit(entry(50, { gatekeeperId: 1, createdAt: at(3), state: 'approved' }))
    await server.emit(entry(70, { gatekeeperId: 1, createdAt: at(9) }))
    flushFrames()

    expect(ids(group(1).actions)).toEqual([10])
    expect(group(1).vetoIds).toEqual([])
    expect(group(1).throughId).toBe(50)

    await act(async () => { void review.applyBatch(1) })
    await server.resolveApply()

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [] }])
  })

  it('keeps selections through a reconnect while mutation is disabled', async () => {
    const first = await settledReview()
    act(() => review.setVeto(1, 30, true))
    await act(async () => { void review.applyBatch(1) })

    const second = makeOverseer()
    await view.render(<Probe overseer={second.overseer} />)

    expect(review.canEdit).toBe(false)
    expect(group(1)).toBeUndefined()
    act(() => review.setVeto(1, 10, true))

    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [a50, a30, a10] })
    flushFrames()

    expect(ids(group(1).actions)).toEqual([10, 30, 50])
    expect(group(1).vetoIds).toEqual([30])

    // The old stub's refusal belongs to a connection nobody is looking at any more.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await first.rejectApply(new Error('old stub went away'))

    expect(group(1).error).toBeUndefined()
    expect(testState.addToast).not.toHaveBeenCalled()
  })

  it('leaves a refused batch fully reviewable and retries only when asked', async () => {
    const server = await settledReview()
    act(() => review.setVeto(1, 30, true))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await act(async () => { void review.applyBatch(1) })
    await server.rejectApply(createActionError(ACTION_ERROR_CODES.stopped))

    expect(group(1).error).toBe(ACTION_ERROR_MESSAGES[ACTION_ERROR_CODES.stopped])
    expect(testState.addToast).toHaveBeenCalledWith({
      title: ACTION_ERROR_MESSAGES[ACTION_ERROR_CODES.stopped],
      variant: 'error',
    })
    expect(ids(group(1).actions)).toEqual([10, 30, 50])
    expect(group(1).vetoIds).toEqual([30])
    expect(server.applyCalls).toHaveLength(1)

    // The failed action stays vetoable; selecting it is the way past the stop.
    await server.emit(entry(10, { gatekeeperId: 1, createdAt: at(5), failure: 'Resource changed upstream' }))
    flushFrames()
    act(() => review.setVeto(1, 10, true))

    await act(async () => { void review.applyBatch(1) })

    expect(group(1).error).toBeUndefined()
    expect(server.applyCalls).toEqual([
      { id: 50, vetoes: [30] },
      { id: 50, vetoes: [10, 30] },
    ])
  })

  it('says nothing when a refusal outlives the workspace it belongs to', async () => {
    const server = await settledReview()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { void review.applyBatch(1) })

    view.unmount()
    await server.rejectApply(createActionError(ACTION_ERROR_CODES.stopped))

    expect(testState.addToast).not.toHaveBeenCalled()
  })

  it('never surfaces diagnostics from an unrecognized refusal', async () => {
    const server = await settledReview()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await act(async () => { void review.applyBatch(1) })
    await server.rejectApply(new Error('private upstream diagnostic'))

    expect(group(1).error).toBe(UNKNOWN_BATCH_ERROR)
    expect(testState.addToast).toHaveBeenCalledWith({
      title: expect.not.stringContaining('private upstream diagnostic'),
      variant: 'error',
    })
  })

  it('submits one batch per click burst and leaves other connections usable', async () => {
    const server = await settledReview()

    await act(async () => {
      void review.applyBatch(1)
      void review.applyBatch(1)
    })

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [] }])
    expect(group(1).applying).toBe(true)
    expect(group(0).applying).toBe(false)
    act(() => review.setVeto(1, 10, true))
    expect(group(1).vetoIds).toEqual([])
    expect(review.blockedAutoApprovalConnections.has(1)).toBe(true)

    await act(async () => { void review.applyBatch(0) })

    expect(server.applyCalls).toEqual([{ id: 50, vetoes: [] }, { id: 0, vetoes: [] }])
  })
})
