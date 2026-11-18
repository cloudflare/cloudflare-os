import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'
import { removalOf, removeWorkspace, type RemovalApi } from './workspaceRemoval'

const fakeApi = ({ refuses = false } = {}) => {
  const overseer = {
    deleteSelf: vi.fn<Overseer['deleteSelf']>(async () => {
      if (refuses) throw new Error('The workspace couldn’t be reached.')
    }),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const api = {
    dismissSharedWorkspace: vi.fn<AuthenticatedApi['dismissSharedWorkspace']>(async () => {}),
    openWorkspace: vi.fn<(workspaceId: string) => typeof overseer>(() => overseer),
  } satisfies RemovalApi
  return { api, overseer }
}

describe('removalOf', () => {
  it('deletes the viewer’s own workspace, and removes one shared with them from their list', () => {
    expect(removalOf({})).toBe('delete')
    expect(removalOf({ owner: { type: 'user', id: 'grace', name: 'Grace Hopper' } })).toBe('dismiss')
  })
})

describe('removeWorkspace', () => {
  it('deletes a workspace through the workspace itself, and lets it go', async () => {
    const { api, overseer } = fakeApi()
    await removeWorkspace(api, 'ws', 'delete')
    expect(api.openWorkspace).toHaveBeenCalledWith('ws')
    expect(overseer.deleteSelf).toHaveBeenCalledOnce()
    expect(overseer[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(api.dismissSharedWorkspace).not.toHaveBeenCalled()
  })

  it('removes a shared workspace from the list without opening it', async () => {
    const { api } = fakeApi()
    await removeWorkspace(api, 'ws', 'dismiss')
    expect(api.dismissSharedWorkspace).toHaveBeenCalledWith('ws')
    expect(api.openWorkspace).not.toHaveBeenCalled()
  })

  it('says why a workspace could not be deleted, and lets it go all the same', async () => {
    const { api, overseer } = fakeApi({ refuses: true })
    await expect(removeWorkspace(api, 'ws', 'delete')).rejects.toThrow('The workspace couldn’t be reached.')
    expect(overseer[Symbol.dispose]).toHaveBeenCalledOnce()
  })
})
