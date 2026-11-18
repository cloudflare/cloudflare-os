import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import { LiveWorkspace, sameLiveFields, type LiveWorkspaceFields, type MetadataOverseer } from './LiveWorkspace'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const metadata = (change: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata => ({ id: 'w', title: 'Plans', ...change })

/** Each connection to the workspace, and what a test needs to act as the server through it. */
type Connection = {
  callback?: (metadata: WorkspaceMetadata) => void
  dispose: () => void
  leaseDispose: () => void
  broken: Set<(error: unknown) => void>
}

const fakeWorkspace = () => {
  const opened: Connection[] = []
  let refuse = false
  const open = vi.fn<() => MetadataOverseer>(() => {
    const connection: Connection = { dispose: vi.fn<() => void>(), leaseDispose: vi.fn<() => void>(), broken: new Set() }
    opened.push(connection)
    return {
      subscribeToMetadata: (callback) => {
        if (refuse) return Promise.reject(new Error('unreachable'))
        connection.callback = callback as (metadata: WorkspaceMetadata) => void
        return Promise.resolve({ [Symbol.dispose]: connection.leaseDispose })
      },
      onRpcBroken: (callback) => void connection.broken.add(callback),
      [Symbol.dispose]: connection.dispose,
    }
  })
  return { open, opened, latest: () => opened.at(-1)!, refuse: (on: boolean) => (refuse = on) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('LiveWorkspace', () => {
  it('says what the workspace says of itself each time it does, and only what the list keeps', () => {
    const workspace = fakeWorkspace()
    const changes: LiveWorkspaceFields[] = []
    new LiveWorkspace(workspace.open, (fields) => changes.push(fields)).start()

    workspace.latest().callback!(metadata({ pinned: true, totalCost: 3 }))
    workspace.latest().callback!(metadata({ title: 'Roadmap', role: 'use' }))

    expect(changes).toEqual([
      { title: 'Plans', role: undefined, owner: undefined, containsRestrictedData: undefined, ownerInvitesOnly: undefined },
      { title: 'Roadmap', role: 'use', owner: undefined, containsRestrictedData: undefined, ownerInvitesOnly: undefined },
    ])
  })

  it('connects again, once, with growing waits, after the workspace restarts', async () => {
    vi.useFakeTimers()
    const workspace = fakeWorkspace()
    new LiveWorkspace(workspace.open, () => {}).start()
    const first = workspace.latest()

    workspace.refuse(true)
    first.broken.forEach((callback) => callback(new Error('reset')))
    first.broken.forEach((callback) => callback(new Error('reset')))
    await flush()
    expect(first.dispose).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1000)
    expect(workspace.open).toHaveBeenCalledTimes(2)
    // That one could not subscribe either: the next waits twice as long.
    await vi.advanceTimersByTimeAsync(1000)
    expect(workspace.open).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(workspace.open).toHaveBeenCalledTimes(3)
  })

  it('lets go of the workspace when stopped, and hears nothing from it after', async () => {
    const workspace = fakeWorkspace()
    const onChange = vi.fn<(fields: LiveWorkspaceFields) => void>()
    const live = new LiveWorkspace(workspace.open, onChange)
    live.start()
    const connection = workspace.latest()
    live.stop()
    await flush()

    expect(connection.leaseDispose).toHaveBeenCalledOnce()
    expect(connection.dispose).toHaveBeenCalledOnce()
    connection.callback!(metadata())
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('sameLiveFields', () => {
  it('takes a role the workspace leaves out as building, and absent flags as off', () => {
    expect(sameLiveFields({ title: 'Plans', role: 'build', containsRestrictedData: false }, { title: 'Plans' })).toBe(true)
    expect(sameLiveFields({ title: 'Plans' }, { title: 'Plans', role: 'use' })).toBe(false)
    expect(sameLiveFields({ title: 'Plans', owner: { type: 'user', id: 'a', name: 'Ada' } }, { title: 'Plans' })).toBe(false)
  })
})
