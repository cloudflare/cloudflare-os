import { describe, expect, it, vi } from 'vitest'
import { createOpenWorkspaceError, OPEN_WORKSPACE_ERROR_CODES, type AgentSpawnerInfo, type GatekeeperCreationSpec, type WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { bindingNameProblem, describeBinding, freeBindingName, GadgetSettings, groupBindings, InvalidBindingName, type GadgetSummary, type SettingsGadget, type SettingsOverseer } from './GadgetSettings'

const summary = (title: string, id = 7): GadgetSummary => ({ id, type: 'gadget', title })

const SPAWNERS: AgentSpawnerInfo[] = [{ id: 4, config: { displayName: 'Triage', modelId: 'sonnet' }, modelName: 'Claude Sonnet', bindings: [{ gadgetId: 7, name: 'TRIAGE' }] }]
const MODEL: GatekeeperCreationSpec = { type: 'aiModel', modelId: 'haiku', provider: 'anthropic', modelName: 'Claude Haiku' }

const fakeWorkspace = ({ subscribe }: { subscribe?: () => Promise<Disposable> } = {}) => {
  let subscriber: WorkpiecesSubscriber | undefined
  const broken: Array<(error: unknown) => void> = []
  const gadget = {
    setTitle: vi.fn<SettingsGadget['setTitle']>(async () => {}),
    remove: vi.fn<SettingsGadget['remove']>(async () => {}),
    listBindings: vi.fn<SettingsGadget['listBindings']>(async () => [
      { name: 'GITHUB', target: 3, resourceTitle: 'cloudflare/gadgets', vendorId: 'github', kind: 'gatekeeper' },
      { name: 'TRIAGE', target: 4, resourceTitle: 'Triage', kind: 'agentSpawner' },
      { name: 'LLM', target: 5, resourceTitle: 'Claude Haiku', kind: 'aiModel' },
    ]),
    rebind: vi.fn<SettingsGadget['rebind']>(async () => {}),
    unbind: vi.fn<SettingsGadget['unbind']>(async () => {}),
    renameBinding: vi.fn<SettingsGadget['renameBinding']>(async () => {}),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const gatekeepers: Array<{ id: number; dispose: () => void }> = []
  const minted: Array<{ modelId: string; dispose: () => void }> = []
  const overseer: SettingsOverseer = {
    getGadget: vi.fn<SettingsOverseer['getGadget']>(() => gadget),
    getGatekeeperById: vi.fn<SettingsOverseer['getGatekeeperById']>((id) => {
      const dispose = vi.fn<() => void>()
      gatekeepers.push({ id, dispose })
      return { getCreationSpec: async () => MODEL, [Symbol.dispose]: dispose }
    }),
    listAgentSpawners: vi.fn<SettingsOverseer['listAgentSpawners']>(async () => SPAWNERS),
    newAiModelGatekeeper: vi.fn<SettingsOverseer['newAiModelGatekeeper']>((modelId) => {
      const dispose = vi.fn<() => void>()
      minted.push({ modelId, dispose })
      return { getId: async () => 40 + minted.length, [Symbol.dispose]: dispose }
    }),
    subscribeToWorkpieces: vi.fn<SettingsOverseer['subscribeToWorkpieces']>(subscribe ?? (async (given) => {
      subscriber = given
      return { [Symbol.dispose]: () => {} }
    })),
    onRpcBroken: (callback) => void broken.push(callback),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return { overseer, gadget, gatekeepers, minted, server: () => subscriber!, breaks: () => broken.forEach((callback) => callback(new Error('reset'))) }
}

describe('describeBinding', () => {
  const binding = { name: 'X', target: 4, resourceTitle: 'X' }
  it('says an agent and its model, a model, and a service apart, by what each reaches', () => {
    expect(describeBinding({ ...binding, kind: 'agentSpawner' }, { spawners: SPAWNERS })).toEqual({ ...binding, kind: 'agent', model: 'Claude Sonnet' })
    expect(describeBinding({ ...binding, kind: 'aiModel' }, { spec: MODEL })).toEqual({ ...binding, kind: 'model', model: 'Claude Haiku', modelId: 'haiku' })
    expect(describeBinding({ ...binding, vendorId: 'google', kind: 'gatekeeper' })).toEqual({ ...binding, vendorId: 'google', kind: 'service' })
    // One whose kind is not recorded says what its title says.
    expect(describeBinding(binding)).toEqual({ ...binding, kind: 'service' })
  })

  it('names no model for an agent that runs none, or whose spawner is not listed', () => {
    const none: AgentSpawnerInfo = { id: 4, config: { displayName: 'Inbox', modelId: null }, bindings: [] }
    expect(describeBinding({ ...binding, kind: 'agentSpawner' }, { spawners: [none] })).toEqual({ ...binding, kind: 'agent' })
    expect(describeBinding({ ...binding, kind: 'agentSpawner' })).toEqual({ ...binding, kind: 'agent' })
  })
})

describe('groupBindings', () => {
  it('lists the agents apart from what it reaches, a model among the latter', () => {
    const service = describeBinding({ name: 'A', target: 1, resourceTitle: 'A', vendorId: 'github' })
    const agent = describeBinding({ name: 'B', target: 4, resourceTitle: 'B', kind: 'agentSpawner' }, { spawners: SPAWNERS })
    const model = describeBinding({ name: 'C', target: 3, resourceTitle: 'C', kind: 'aiModel' }, { spec: MODEL })
    expect(groupBindings([agent, service, model])).toEqual({ connections: [service, model], agents: [agent] })
  })
})

describe('bindingNameProblem', () => {
  it('takes a name code can reach it by that the gadget has no other by', () => {
    expect(bindingNameProblem('CALENDAR', ['GITHUB'])).toBeUndefined()
    expect(bindingNameProblem('team_calendar2', [])).toBeUndefined()
  })

  it('says why it refuses one, without naming the name again', () => {
    expect(bindingNameProblem('', [])).toBe('It needs a name.')
    expect(bindingNameProblem('2FA', [])).toBe('Binding names must be JavaScript identifiers (letters, digits, and \'_\', not starting with a digit).')
    expect(bindingNameProblem('MY-CALENDAR', [])).toMatch(/^Binding names must be JavaScript identifiers/)
    expect(bindingNameProblem('class', [])).toBe('This is a reserved word in JavaScript.')
    expect(bindingNameProblem('constructor', [])).toBe('This name collides with a built-in object property.')
    expect(bindingNameProblem('GITHUB', ['GITHUB'])).toBe('It already has env.GITHUB. Choose another name.')
  })
})

describe('freeBindingName', () => {
  it('takes the name where it is free, else the first numbered one that is', () => {
    expect(freeBindingName('LLM', ['GITHUB'])).toBe('LLM')
    expect(freeBindingName('LLM', ['LLM', 'LLM_2', 'LLM_4'])).toBe('LLM_3')
  })
})

const readyWorkspace = async () => {
  const workspace = fakeWorkspace()
  const settings = new GadgetSettings(() => workspace.overseer, 7)
  settings.start()
  await vi.waitFor(() => expect(workspace.overseer.subscribeToWorkpieces).toHaveBeenCalled())
  workspace.server().entry(summary('Todo'))
  await vi.waitFor(() => {
    const snapshot = settings.getSnapshot()
    expect(snapshot.status === 'ready' && snapshot.bindings.status).toBe('ready')
  })
  return { ...workspace, settings }
}

describe('GadgetSettings', () => {
  it('shows the gadget as the workspace says, then what it is bound to, asking only a model’s connection which model it is', async () => {
    const { overseer, gatekeepers, server } = fakeWorkspace()
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
      expect(snapshot.bindings.items.map(({ name, kind, model }) => [name, kind, model])).toEqual([['GITHUB', 'service', undefined], ['TRIAGE', 'agent', 'Claude Sonnet'], ['LLM', 'model', 'Claude Haiku']])
    })
    expect(gatekeepers.map(({ id }) => id)).toEqual([5])
    expect(gatekeepers[0].dispose).toHaveBeenCalled()
    expect(overseer.listAgentSpawners).toHaveBeenCalledTimes(1)

    // A new title, from anywhere, keeps the list.
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

  it('renames a binding and reads them again, refusing a name it cannot have without asking', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    await vi.waitFor(() => {
      const snapshot = settings.getSnapshot()
      expect(snapshot.status === 'ready' && snapshot.bindings.status).toBe('ready')
    })

    await expect(settings.renameBinding('GITHUB', 'TRIAGE')).rejects.toThrow(InvalidBindingName)
    await expect(settings.renameBinding('GITHUB', 'my repo')).rejects.toThrow(InvalidBindingName)
    expect(gadget.renameBinding).not.toHaveBeenCalled()

    await settings.renameBinding('GITHUB', 'REPO')
    expect(gadget.renameBinding).toHaveBeenCalledWith('GITHUB', 'REPO')
    expect(gadget.listBindings).toHaveBeenCalledTimes(2)

    // What the server refuses is said as it said it.
    gadget.renameBinding.mockRejectedValueOnce(new Error('Binding name is reserved'))
    const refused = settings.renameBinding('TRIAGE', 'GADGET')
    await expect(refused).rejects.toThrow('Binding name is reserved')
    await expect(refused).rejects.not.toBeInstanceOf(InvalidBindingName)
  })

  it('changes a model under the same name in one step, from the target it read', async () => {
    const { settings, gadget, minted } = await readyWorkspace()
    await settings.changeModel('LLM', 'haiku')
    expect(minted).toEqual([])

    await settings.changeModel('LLM', 'sonnet')
    expect(gadget.rebind).toHaveBeenCalledWith('LLM', 5, 41)

    // What the server refuses, such as a binding changed meanwhile, is said as it said it.
    gadget.rebind.mockRejectedValueOnce(new Error('The binding LLM has changed since it was read.'))
    await expect(settings.changeModel('LLM', 'opus')).rejects.toThrow('changed since it was read')
    await expect(settings.changeModel('NOPE', 'opus')).rejects.toThrow('It no longer has env.NOPE.')
  })

  it('renames and deletes through its client, and says so while it is still loading', async () => {
    const { overseer, gadget, server } = fakeWorkspace()
    const settings = new GadgetSettings(() => overseer, 7)
    await expect(settings.rename('Today')).rejects.toThrow('still loading')
    settings.start()
    await vi.waitFor(() => expect(overseer.subscribeToWorkpieces).toHaveBeenCalled())
    server().entry(summary('Todo'))
    await settings.rename('Today')
    await settings.remove()
    expect(gadget.setTitle).toHaveBeenCalledWith('Today')
    expect(gadget.remove).toHaveBeenCalled()
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
