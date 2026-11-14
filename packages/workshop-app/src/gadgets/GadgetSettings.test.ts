import { describe, expect, it, vi } from 'vitest'
import { createOpenWorkspaceError, OPEN_WORKSPACE_ERROR_CODES, type BoundHookInfo, type WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { GadgetSettings, type GadgetSummary, type SettingsGadget, type SettingsOverseer } from './GadgetSettings'

const summary = (title: string, id = 7): GadgetSummary => ({ id, type: 'gadget', title } as GadgetSummary)
const hook = (id: number, gadgetId: number) => ({ id, gadgetId, gatekeeperId: 3, description: { title: `Hook ${id}` }, enabled: true }) as unknown as BoundHookInfo

const fakeWorkspace = ({ subscribe }: { subscribe?: () => Promise<Disposable> } = {}) => {
  let subscriber: WorkpiecesSubscriber | undefined
  const broken: Array<(error: unknown) => void> = []
  const gadget = {
    setTitle: vi.fn<SettingsGadget['setTitle']>(async () => {}),
    remove: vi.fn<SettingsGadget['remove']>(async () => {}),
    listBindings: vi.fn<SettingsGadget['listBindings']>(async () => [{ name: 'GITHUB', target: 3, resourceTitle: 'cloudflare/gadgets', vendorId: 'github' }]),
    unbind: vi.fn<SettingsGadget['unbind']>(async () => {}),
    createBlueprint: vi.fn<SettingsGadget['createBlueprint']>(),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const overseer: SettingsOverseer = {
    getGadget: vi.fn<SettingsOverseer['getGadget']>(() => gadget),
    subscribeToWorkpieces: vi.fn<SettingsOverseer['subscribeToWorkpieces']>(subscribe ?? (async (given) => {
      subscriber = given
      return { [Symbol.dispose]: () => {} }
    })),
    listHooks: vi.fn<SettingsOverseer['listHooks']>(async () => [hook(1, 7), hook(2, 8)]),
    deleteHook: vi.fn<SettingsOverseer['deleteHook']>(async () => {}),
    enableHook: vi.fn<SettingsOverseer['enableHook']>(async () => {}),
    disableHook: vi.fn<SettingsOverseer['disableHook']>(async () => {}),
    onRpcBroken: (callback) => void broken.push(callback),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return { overseer, gadget, server: () => subscriber!, breaks: () => broken.forEach((callback) => callback(new Error('reset'))) }
}

describe('GadgetSettings', () => {
  it('shows the gadget as the workspace says, then what it is bound to and its own hooks', async () => {
    const { overseer, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Other', 8))
    expect(settings.getSnapshot().status).toBe('loading')
    server().entry(summary('Todo'))
    server().ready()
    await vi.waitFor(() => {
      const snapshot = settings.getSnapshot()
      if (snapshot.status !== 'ready' || snapshot.hooks.status !== 'ready' || snapshot.bindings.status !== 'ready') throw new Error('not yet')
      expect(snapshot.gadget.title).toBe('Todo')
      expect(snapshot.bindings.items.map(({ name }) => name)).toEqual(['GITHUB'])
      expect(snapshot.hooks.items.map(({ id }) => id)).toEqual([1])
    })

    // A new title, from anywhere, keeps the lists.
    server().entry(summary('Today'))
    const after = settings.getSnapshot()
    expect(after.status === 'ready' && [after.gadget.title, after.bindings.status]).toEqual(['Today', 'ready'])
  })

  it('is gone when the workspace has no such gadget, or it is deleted', async () => {
    const { overseer, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().ready()
    expect(settings.getSnapshot().status).toBe('gone')

    const second = fakeWorkspace()
    const deleted = new GadgetSettings(() => second.overseer, 7)
    deleted.start()
    await vi.waitFor(() => expect(second.overseer.subscribeToWorkpieces).toHaveBeenCalled())
    second.server().entry(summary('Todo'))
    second.server().ready()
    second.server().removed(7)
    expect(deleted.getSnapshot().status).toBe('gone')
  })

  it('tells a workspace the viewer has no access to from one that could not be opened', async () => {
    const denied = fakeWorkspace({ subscribe: () => Promise.reject(createOpenWorkspaceError(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied)) })
    const settings = new GadgetSettings(() => denied.overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(settings.getSnapshot().status).toBe('denied'))

    const failing = fakeWorkspace({ subscribe: () => Promise.reject(new Error('Network down')) })
    const other = new GadgetSettings(() => failing.overseer, 7)
    other.start()
    await vi.waitFor(() => expect(other.getSnapshot()).toEqual({ status: 'failed', message: 'Network down' }))
  })

  it('says nothing failed while the app’s connection is down', async () => {
    const failing = fakeWorkspace({ subscribe: () => Promise.reject(new Error('Network down')) })
    const settings = new GadgetSettings(() => failing.overseer, 7, { connection: { down: true } })
    settings.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settings.getSnapshot().status).toBe('loading')
  })

  it('reads its lists again after unbinding or deleting a hook', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    await settings.unbind('GITHUB')
    expect(gadget.unbind).toHaveBeenCalledWith('GITHUB')
    expect(gadget.listBindings).toHaveBeenCalledTimes(2)
    await settings.deleteHook(1)
    expect(overseer.deleteHook).toHaveBeenCalledWith(1)
    expect(overseer.listHooks).toHaveBeenCalledTimes(3)
  })

  it('opens the workspace again once it restarted, and lets the old one go', async () => {
    vi.useFakeTimers()
    try {
      const first = fakeWorkspace()
      const second = fakeWorkspace()
      const open = vi.fn<() => SettingsOverseer>().mockReturnValueOnce(first.overseer).mockReturnValueOnce(second.overseer)
      const settings = new GadgetSettings(open, 7)
      settings.start()
      first.breaks()
      await vi.advanceTimersByTimeAsync(1000)
      expect(open).toHaveBeenCalledTimes(2)
      expect(first.overseer[Symbol.dispose]).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
