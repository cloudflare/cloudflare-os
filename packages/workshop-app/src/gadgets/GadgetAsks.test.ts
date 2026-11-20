import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionsSubscriber, GadgetBindingInfo } from '@gadgets/workshop-shared/api'
import type { Ask } from './askGroups'
import { GadgetAsks, HOLD_MS, type AsksGadget, type AsksOverseer } from './GadgetAsks'

const ask = (id: number, change: Partial<Ask> = {}): Ask => ({
  id,
  type: 'action',
  state: 'pending',
  gatekeeperId: 3,
  from: 'gadget',
  gadgetId: 7,
  resourceTitle: 'Q3 notes',
  createdAt: new Date(0),
  ...change,
  description: { title: `Append line ${id}`, description: '', implementsRevert: false, autoApprovable: true, actionKind: { tag: 'append', label: 'Append to document' } },
})

const APPEND = { tag: 'append', label: 'Append to document' }

const fakeWorkspace = ({ pending = [ask(1), ask(2, { gatekeeperId: 8 })], bindings = [{ name: 'NOTES', target: 3, resourceTitle: 'Q3 notes', vendorId: 'google' }] }: {
  pending?: Ask[]
  bindings?: GadgetBindingInfo[]
} = {}) => {
  let subscriber: ActionsSubscriber | undefined
  const broken: Array<(error: unknown) => void> = []
  const calls: string[] = []
  const listBindings = vi.fn<AsksGadget['listBindings']>(async () => bindings)
  const overseer: AsksOverseer = {
    getGadget: () => ({ listBindings, [Symbol.dispose]: () => {} }),
    subscribeToActions: async (given) => {
      subscriber = given
      return { [Symbol.dispose]: () => {} }
    },
    listActions: async ({ beforeId } = {}) => (beforeId === undefined
      ? { entries: pending.slice(0, 1), nextBeforeId: pending.length > 1 ? pending[0].id : undefined }
      : { entries: pending.slice(1) }),
    listChats: vi.fn<AsksOverseer['listChats']>(async () => [{ id: 12, spawnerName: 'Researcher', spawnedByGadgetId: 7 }, { id: 14, spawnerName: 'Other', spawnedByGadgetId: 8 }]),
    approveAction: async (id) => void calls.push(`approve ${id}`),
    rejectAction: async (id) => void calls.push(`reject ${id}`),
    setAutoApprovedActionKind: async (gatekeeperId, kind) => void calls.push(`allow ${gatekeeperId}:${kind.tag}`),
    removeAutoApprovedActionKind: async (gatekeeperId, tag) => void calls.push(`disallow ${gatekeeperId}:${tag}`),
    onRpcBroken: (callback) => void broken.push(callback),
    [Symbol.dispose]: () => {},
  }
  return { overseer, calls, listBindings, server: () => subscriber!, breaks: () => broken.forEach((callback) => callback(new Error('reset'))) }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('GadgetAsks', () => {
  it('lists everything waiting, every page of it, with what the gadget reaches and the agents it started', async () => {
    const { overseer } = fakeWorkspace({ bindings: [{ name: 'NOTES', target: 3, resourceTitle: 'Q3 notes', vendorId: 'google' }, { name: 'RESEARCH', target: 9, resourceTitle: 'Researcher' }] })
    const asks = new GadgetAsks(() => overseer, 7)
    asks.start()
    expect(asks.getSnapshot()).toEqual({ status: 'loading' })
    await settle()
    const snapshot = asks.getSnapshot()
    expect(snapshot.status).toBe('ready')
    if (snapshot.status !== 'ready') return
    expect(snapshot.pending.map(({ id }) => id)).toEqual([1, 2])
    expect([...snapshot.targets]).toEqual([3, 9])
    expect(snapshot.vendors.get(3)).toBe('google')
    expect(snapshot.agents).toEqual(new Map([[12, 'Researcher']]))
  })

  it('holds back what arrives for a moment, as a standing rule may let it through, and drops what is decided', async () => {
    const { overseer, server } = fakeWorkspace()
    const asks = new GadgetAsks(() => overseer, 7)
    asks.start()
    await settle()
    const ids = () => {
      const snapshot = asks.getSnapshot()
      return snapshot.status === 'ready' ? snapshot.pending.map(({ id }) => id) : []
    }
    server().entry(ask(5))
    expect(ids()).toEqual([1, 2])
    server().entry({ ...ask(6) })
    server().entry({ ...ask(6), state: 'approved', autoApproved: true })
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(ids()).toEqual([1, 2, 5])
    server().entry({ ...ask(1), state: 'rejected' })
    expect(ids()).toEqual([2, 5])
  })

  it('reads what the gadget reaches again for what came through a connection it was not known to have', async () => {
    const { overseer, server, listBindings } = fakeWorkspace()
    const asks = new GadgetAsks(() => overseer, 7, { chatId: 4 })
    asks.start()
    await settle()
    expect(listBindings).toHaveBeenLastCalledWith(4)
    server().entry(ask(5, { gatekeeperId: 3 }))
    expect(listBindings).toHaveBeenCalledTimes(1)
    server().entry(ask(6, { gatekeeperId: 11 }))
    expect(listBindings).toHaveBeenCalledTimes(2)
  })

  it('reads the runs again for what came from a chat not yet known, which may be an agent just started', async () => {
    const { overseer, server } = fakeWorkspace()
    const asks = new GadgetAsks(() => overseer, 7)
    asks.start()
    await settle()
    server().entry(ask(5, { chatId: 12 }))
    expect(overseer.listChats).toHaveBeenCalledTimes(1)
    server().entry(ask(6, { chatId: 13 }))
    expect(overseer.listChats).toHaveBeenCalledTimes(2)
    expect(overseer.listChats).toHaveBeenLastCalledWith({ kind: 'runs' })
  })

  it('approves oldest first and denies newest first, only what still waits', async () => {
    const { overseer, calls } = fakeWorkspace({ pending: [ask(1), ask(2), ask(3)] })
    const asks = new GadgetAsks(() => overseer, 7)
    asks.start()
    await settle()
    await asks.approve([ask(2), ask(1), ask(40)])
    await asks.deny([ask(1), ask(3)])
    expect(calls).toEqual(['approve 1', 'approve 2', 'reject 3', 'reject 1'])
  })

  it('allows a kind for good, then approves what the workspace did not get to first', async () => {
    const { overseer, calls } = fakeWorkspace({ pending: [ask(1), ask(2)] })
    overseer.approveAction = async (id) => {
      calls.push(`approve ${id}`)
      if (id === 1) throw new Error('Action is not pending: 1')
    }
    const asks = new GadgetAsks(() => overseer, 7)
    asks.start()
    await settle()
    await asks.allow(3, APPEND, [ask(2), ask(1)])
    await asks.disallow(3, APPEND)
    expect(calls).toEqual(['allow 3:append', 'approve 1', 'approve 2', 'disallow 3:append'])
  })

  it('opens the workspace again once it is lost, keeping what is shown meanwhile', async () => {
    const first = fakeWorkspace()
    const second = fakeWorkspace({ pending: [ask(9)] })
    const open = vi.fn<() => AsksOverseer>().mockReturnValueOnce(first.overseer).mockReturnValueOnce(second.overseer)
    const asks = new GadgetAsks(open, 7)
    asks.start()
    await settle()
    first.breaks()
    expect(asks.getSnapshot().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(1000)
    const snapshot = asks.getSnapshot()
    expect(snapshot.status === 'ready' && snapshot.pending.map(({ id }) => id)).toEqual([9])
  })

  it('refuses a decision before anything was read', async () => {
    const { overseer } = fakeWorkspace()
    const asks = new GadgetAsks(() => overseer, 7)
    asks.start()
    await expect(asks.approve([ask(1)])).rejects.toThrow('still loading')
  })
})
