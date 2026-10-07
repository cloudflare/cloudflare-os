// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  GadgetClient,
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import { useWorkspaceGadgets, type WorkspaceGadgets } from './useWorkspaceGadgets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const id = (n: number) => n as WorkpieceId

const summary = (n: number, extra: Partial<WorkpieceSummary> = {}): WorkpieceSummary =>
  ({ id: id(n), type: 'gadget', title: `Gadget ${n}`, commitId: 'a'.repeat(40), ...extra }) as WorkpieceSummary

type FakeGadgetStub = RpcStub<GadgetClient> & { dispose: ReturnType<typeof vi.fn<() => void>> }

// An overseer whose workpiece subscription is driven by hand, and whose gadget stubs record their
// disposal.
const fakeOverseer = () => {
  let subscriber: WorkpiecesSubscriber | null = null
  const unsubscribe = vi.fn<() => void>()
  const subscribeToWorkpieces = vi.fn<(target: WorkpiecesSubscriber) => Promise<Disposable>>(
    async (target) => {
      subscriber = target
      return { [Symbol.dispose]: unsubscribe }
    },
  )
  const stubs = new Map<WorkpieceId, FakeGadgetStub>()
  const getGadget = vi.fn<(gadgetId: WorkpieceId) => FakeGadgetStub>((gadgetId) => {
    const dispose = vi.fn<() => void>()
    const stub = { id: gadgetId, dispose, [Symbol.dispose]: dispose } as unknown as FakeGadgetStub
    stubs.set(gadgetId, stub)
    return stub
  })
  return {
    overseer: { subscribeToWorkpieces, getGadget } as unknown as RpcStub<Overseer>,
    getGadget,
    unsubscribe,
    stubs,
    // The subscriber's callbacks, as the workspace would invoke them.
    entry: (s: WorkpieceSummary) => act(async () => { subscriber!.entry(s) }),
    removed: (n: number) => act(async () => { subscriber!.removed(id(n)) }),
    ready: () => act(async () => { subscriber!.ready() }),
  }
}

const asId = (n: number | undefined) => (n === undefined ? undefined : id(n))

const flush = () => act(async () => { await Promise.resolve() })

describe('useWorkspaceGadgets', () => {
  let root: Root | undefined
  let latest: WorkspaceGadgets | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    latest = undefined
  })

  const Probe = ({ overseer, defaultGadgetId, requestedId }: {
    overseer: RpcStub<Overseer> | null
    defaultGadgetId: WorkpieceId | undefined
    requestedId: WorkpieceId | undefined
  }) => {
    latest = useWorkspaceGadgets(overseer, defaultGadgetId, requestedId)
    return null
  }

  const mount = async (
    overseer: RpcStub<Overseer> | null,
    defaultGadgetId: number | undefined,
    requestedId: number | undefined,
  ) => {
    root ??= createRoot(document.createElement('div'))
    await act(async () => root!.render(
      <Probe overseer={overseer} defaultGadgetId={asId(defaultGadgetId)} requestedId={asId(requestedId)} />,
    ))
    await flush()
  }

  it('lists nothing, and is not ready, until the initial listing completes', async () => {
    const fake = fakeOverseer()
    await mount(fake.overseer, 3, undefined)
    expect(latest).toEqual({ gadgets: [], selectedId: null, gadget: null, ready: false })

    await fake.entry(summary(3))
    expect(latest?.ready).toBe(false)
    expect(latest?.gadgets).toEqual([])
    expect(fake.getGadget).not.toHaveBeenCalled()

    await fake.ready()
    expect(latest?.ready).toBe(true)
    expect(latest?.gadgets.map(g => g.id)).toEqual([3])
    expect(latest?.selectedId).toBe(3)
    expect(latest?.gadget).toBe(fake.stubs.get(id(3)))
  })

  it('puts the default gadget first and the rest by id, and shows the default unasked', async () => {
    const fake = fakeOverseer()
    await mount(fake.overseer, 7, undefined)
    await fake.entry(summary(9))
    await fake.entry(summary(2))
    await fake.entry(summary(7))
    await fake.ready()

    expect(latest?.gadgets.map(g => g.id)).toEqual([7, 2, 9])
    expect(latest?.selectedId).toBe(7)
    expect(fake.getGadget).toHaveBeenCalledTimes(1)
    expect(fake.getGadget).toHaveBeenCalledWith(7)
  })

  it('leads with the lowest id when no default is recorded or the default is gone', async () => {
    const fake = fakeOverseer()
    await mount(fake.overseer, undefined, undefined)
    await fake.entry(summary(4))
    await fake.entry(summary(2))
    await fake.ready()
    expect(latest?.gadgets.map(g => g.id)).toEqual([2, 4])
    expect(latest?.selectedId).toBe(2)

    await mount(fake.overseer, 9, undefined)
    expect(latest?.gadgets.map(g => g.id)).toEqual([2, 4])
    expect(latest?.selectedId).toBe(2)
  })

  it('selects the requested gadget, falling back to the first for an id the workspace lacks', async () => {
    const fake = fakeOverseer()
    await mount(fake.overseer, 3, 5)
    await fake.entry(summary(3))
    await fake.entry(summary(5))
    await fake.ready()
    expect(latest?.selectedId).toBe(5)
    expect(latest?.gadget).toBe(fake.stubs.get(id(5)))

    await mount(fake.overseer, 3, 42)
    expect(latest?.selectedId).toBe(3)
    expect(latest?.gadget).toBe(fake.stubs.get(id(3)))

    // Removing the shown gadget falls back the same way.
    await mount(fake.overseer, 3, 5)
    expect(latest?.selectedId).toBe(5)
    await fake.removed(5)
    expect(latest?.gadgets.map(g => g.id)).toEqual([3])
    expect(latest?.selectedId).toBe(3)
  })

  it('disposes the previous stub on a switch, and never hands out a stub for another gadget', async () => {
    const fake = fakeOverseer()
    await mount(fake.overseer, 3, undefined)
    await fake.entry(summary(3))
    await fake.entry(summary(5))
    await fake.ready()
    const firstStub = fake.stubs.get(id(3))!
    expect(latest?.gadget).toBe(firstStub)

    await mount(fake.overseer, 3, 5)
    const otherStub = fake.stubs.get(id(5))!
    expect(firstStub.dispose).toHaveBeenCalledTimes(1)
    expect(otherStub.dispose).not.toHaveBeenCalled()
    expect(latest?.gadget).toBe(otherStub)
    expect(fake.getGadget).toHaveBeenCalledTimes(2)

    act(() => root?.unmount())
    root = undefined
    expect(otherStub.dispose).toHaveBeenCalledTimes(1)
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('lets go of one workspace’s subscription and stub when it is given another', async () => {
    const first = fakeOverseer()
    await mount(first.overseer, 3, undefined)
    await first.entry(summary(3))
    await first.ready()

    const second = fakeOverseer()
    await mount(second.overseer, 3, undefined)
    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    expect(first.stubs.get(id(3))!.dispose).toHaveBeenCalledTimes(1)
    // Nothing of the first workspace is reported for the second.
    expect(latest).toEqual({ gadgets: [], selectedId: null, gadget: null, ready: false })
  })

  it('disposes a subscription that arrives after the caller has gone', async () => {
    let resolve!: (subscription: Disposable) => void
    const unsubscribe = vi.fn<() => void>()
    const overseer = {
      subscribeToWorkpieces: () => new Promise<Disposable>((settle) => { resolve = settle }),
      getGadget: vi.fn<() => never>(),
    } as unknown as RpcStub<Overseer>
    await mount(overseer, undefined, undefined)

    act(() => root?.unmount())
    root = undefined
    await act(async () => { resolve({ [Symbol.dispose]: unsubscribe }) })

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('lists only permanent gadgets: no chat-pending drafts, no worktrees', async () => {
    const fake = fakeOverseer()
    await mount(fake.overseer, 3, undefined)
    await fake.entry(summary(3))
    await fake.entry(summary(4, { chatId: 11, commitId: undefined }))
    await fake.entry({ id: id(6), type: 'worktree', title: 'Scratch' } as unknown as WorkpieceSummary)
    await fake.entry(summary(8))
    await fake.ready()
    expect(latest?.gadgets.map(g => g.id)).toEqual([3, 8])

    // A draft that is accepted becomes permanent and joins the list.
    await fake.entry(summary(4))
    expect(latest?.gadgets.map(g => g.id)).toEqual([3, 4, 8])
  })

  it('reports nothing without an overseer', async () => {
    await mount(null, 3, 5)
    expect(latest).toEqual({ gadgets: [], selectedId: null, gadget: null, ready: false })
  })
})
