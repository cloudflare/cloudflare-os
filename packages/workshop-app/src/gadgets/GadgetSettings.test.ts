import { describe, expect, it, vi } from 'vitest'
import { createOpenWorkspaceError, OPEN_WORKSPACE_ERROR_CODES, type WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { GadgetSettings, type GadgetSummary, type SettingsGadget, type SettingsOverseer } from './GadgetSettings'

const summary = (title: string, id = 7): GadgetSummary => ({ id, type: 'gadget', title } as GadgetSummary)

const fakeWorkspace = ({ subscribe }: { subscribe?: () => Promise<Disposable> } = {}) => {
  let subscriber: WorkpiecesSubscriber | undefined
  const broken: Array<(error: unknown) => void> = []
  const gadget = {
    setTitle: vi.fn<SettingsGadget['setTitle']>(async () => {}),
    setOutput: vi.fn<SettingsGadget['setOutput']>(async () => {}),
    remove: vi.fn<SettingsGadget['remove']>(async () => {}),
    listBindings: vi.fn<SettingsGadget['listBindings']>(async () => [{ name: 'GITHUB', target: 3, resourceTitle: 'cloudflare/gadgets', vendorId: 'github' }]),
    bindWithSuggestedName: vi.fn<SettingsGadget['bindWithSuggestedName']>(async () => 'FORECAST'),
    unbind: vi.fn<SettingsGadget['unbind']>(async () => {}),
    createBlueprint: vi.fn<SettingsGadget['createBlueprint']>(async (title = '') => ({ id: 'bp', title, description: '', version: 1, codeVersionDate: new Date() })),
    getThumbnail: vi.fn<SettingsGadget['getThumbnail']>(async () => null),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const overseer: SettingsOverseer = {
    getGadget: vi.fn<SettingsOverseer['getGadget']>(() => gadget),
    subscribeToWorkpieces: vi.fn<SettingsOverseer['subscribeToWorkpieces']>(subscribe ?? (async (given) => {
      subscriber = given
      return { [Symbol.dispose]: () => {} }
    })),
    onRpcBroken: (callback) => void broken.push(callback),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return { overseer, gadget, server: () => subscriber!, breaks: () => broken.forEach((callback) => callback(new Error('reset'))) }
}

describe('GadgetSettings', () => {
  it('shows the gadget as the workspace says, then what it is bound to', async () => {
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
      if (snapshot.status !== 'ready' || snapshot.bindings.status !== 'ready') throw new Error('not yet')
      expect(snapshot.gadget.title).toBe('Todo')
      expect(snapshot.bindings.items.map(({ name }) => name)).toEqual(['GITHUB'])
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

  it('binds a connection under the name its resource suggests, and reads its bindings again', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    expect(await settings.bind(12)).toBe('FORECAST')
    expect(gadget.bindWithSuggestedName).toHaveBeenCalledWith(12)
    expect(gadget.listBindings).toHaveBeenCalledTimes(2)
  })

  it('reads what it is bound to again after unbinding', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    await settings.unbind('GITHUB')
    expect(gadget.unbind).toHaveBeenCalledWith('GITHUB')
    expect(gadget.listBindings).toHaveBeenCalledTimes(2)
  })

  it('says what the gadget is through its client, and that it is a plain app with null', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    await settings.setKind({ noun: 'Tracker', icon: 'listChecks' })
    await settings.setKind(null)
    expect(gadget.setOutput.mock.calls).toEqual([[{ noun: 'Tracker', icon: 'listChecks' }], [null]])
  })

  it('publishes with its picture, unless it is more than the server takes', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    const picture = new Uint8Array([0xff, 0xd8])
    expect((await settings.publish('Todo', 'Keep tasks', picture)).id).toBe('bp')
    await settings.publish('Todo', '', new Uint8Array(1024 * 1024 + 1))
    await settings.publish('Todo', '', null)
    expect(gadget.createBlueprint.mock.calls).toEqual([
      ['Todo', 'Keep tasks', { mimeType: 'image/jpeg', content: picture }],
      ['Todo', '', undefined],
      ['Todo', '', undefined],
    ])
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
