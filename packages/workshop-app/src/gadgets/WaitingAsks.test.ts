import { describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry, OutputSummary } from '@gadgets/workshop-shared/api'
import { gadgetKey, WaitingAsks, type SweepApi, type SweepOverseer } from './WaitingAsks'

const pending = (id: number, gatekeeperId: number, chatId?: number): ActionLogEntry => ({
  id,
  type: 'action',
  state: 'pending',
  gatekeeperId,
  chatId,
  resourceTitle: 'Q3 notes',
  createdAt: new Date(0),
  description: { title: 'Append', description: '', implementsRevert: false, autoApprovable: true },
})

const output = (workspaceId: string, workpieceId: number, role?: OutputSummary['role']): OutputSummary => ({
  workspaceId,
  workpieceId,
  title: 'Gadget',
  workspaceTitle: workspaceId,
  created: new Date(0),
  lastActive: new Date(0),
  role,
})

// Two workspaces: `a` waits on gadget 7's connection, twice, one of which gadget 8 shares, and on a
// chat's, which is the chat's; `b` waits on nothing; `c` is only used, and is never read.
const fakeApi = (outputs = [output('a', 7), output('a', 8), output('b', 1), output('c', 2, 'use')]) => {
  const opened: string[] = []
  const disposed: string[] = []
  const failing = new Set<string>()
  const workspaces: Record<string, { pending: ActionLogEntry[]; bindings: Record<number, number[]> }> = {
    a: { pending: [pending(1, 3), pending(2, 4), pending(3, 3, 20)], bindings: { 7: [3, 4], 8: [4] } },
    b: { pending: [], bindings: { 1: [5] } },
  }
  const api: SweepApi = {
    listOutputs: vi.fn<SweepApi['listOutputs']>(async () => ({ outputs })),
    openWorkspace: (id) => {
      opened.push(id)
      const workspace = workspaces[id]
      const overseer: SweepOverseer = {
        listActions: async () => {
          if (failing.has(id)) throw new Error('The workspace could not be reached.')
          return { entries: workspace.pending }
        },
        listChats: async () => [{ id: 20 }],
        getGadget: (gadgetId) => ({
          listBindings: async () => (workspace.bindings[gadgetId] ?? []).map((target) => ({ name: 'X', target, resourceTitle: 'X' })),
          [Symbol.dispose]: () => {},
        }),
        [Symbol.dispose]: () => void disposed.push(id),
      }
      return overseer
    },
  }
  return { api, opened, disposed, failing }
}

describe('WaitingAsks', () => {
  it('sweeps the workspaces the user builds in, counting each ask once, and not what a chat asks', async () => {
    const { api, opened, disposed } = fakeApi()
    const waiting = new WaitingAsks(() => api)
    await waiting.sweep()
    expect(opened.toSorted()).toEqual(['a', 'b'])
    expect(disposed.toSorted()).toEqual(['a', 'b'])
    const { total, byGadget } = waiting.getSnapshot()
    expect(total).toBe(2)
    expect(byGadget).toEqual(new Map([[gadgetKey('a', 7), 2], [gadgetKey('a', 8), 1]]))
  })

  it('takes what a gadget shown reports over what a sweep reads of it, until it is let go', async () => {
    const { api } = fakeApi()
    const waiting = new WaitingAsks(() => api)
    waiting.report('a', 7, [])
    await waiting.sweep()
    expect(waiting.getSnapshot().byGadget.get(gadgetKey('a', 7))).toBeUndefined()
    expect(waiting.getSnapshot().total).toBe(1)
    waiting.release('a', 7)
    await waiting.sweep()
    expect(waiting.getSnapshot().byGadget.get(gadgetKey('a', 7))).toBe(2)
  })

  it('sweeps again only once what it read is old, and once at a time', async () => {
    let now = 0
    const { api } = fakeApi()
    const waiting = new WaitingAsks(() => api, { now: () => now })
    await Promise.all([waiting.refresh(60_000), waiting.sweep()])
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
    now = 30_000
    await waiting.refresh(60_000)
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
    now = 61_000
    await waiting.refresh(60_000)
    expect(api.listOutputs).toHaveBeenCalledTimes(2)
  })

  it('keeps what it knew of a workspace that could not be read, and forgets one no longer listed', async () => {
    const outputs = [output('a', 7)]
    const { api, failing } = fakeApi(outputs)
    const listeners = vi.fn<() => void>()
    const waiting = new WaitingAsks(() => api)
    waiting.subscribe(listeners)
    await waiting.sweep()
    expect(waiting.getSnapshot().total).toBe(2)
    failing.add('a')
    await waiting.sweep()
    expect(waiting.getSnapshot().total).toBe(2)
    outputs.length = 0
    await waiting.sweep()
    expect(waiting.getSnapshot().total).toBe(0)
    expect(listeners).toHaveBeenCalledTimes(2)
  })
})
