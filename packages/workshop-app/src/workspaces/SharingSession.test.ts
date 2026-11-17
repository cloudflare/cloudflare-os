import { describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, CollaboratorInfo, Overseer, ShareLinkInfo, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import { SharingSession, type SharingOverseer, type SharingSource } from './SharingSession'

const ada: AiChatAuthorInfo = { type: 'user', id: 'ada', name: 'Ada' }
const grace: CollaboratorInfo = { profile: { type: 'user', id: 'grace', name: 'Grace' }, addedBy: [], role: 'use' }
const link = (linkId: string, role: 'build' | 'use' = 'use'): ShareLinkInfo => ({ linkId, created: new Date(0), createdBy: ada, role })

const fakeOverseer = ({ collaborators = [] as CollaboratorInfo[], links = [] as ShareLinkInfo[], metadata = {} as Partial<WorkspaceMetadata> } = {}) => {
  let people = collaborators
  let broken: ((error: unknown) => void) | undefined
  const overseer = {
    getMetadata: vi.fn<Overseer['getMetadata']>(async () => ({ id: 'ws', title: 'Engineering', ...metadata })),
    listCollaborators: vi.fn<Overseer['listCollaborators']>(async () => people),
    listObserverRequirements: vi.fn<Overseer['listObserverRequirements']>(async () => []),
    addCollaborator: vi.fn<Overseer['addCollaborator']>(async (username) => {
      if (username !== 'grace') return null
      people = [...people, grace]
      return grace
    }),
    previewRemoveCollaborator: vi.fn<Overseer['previewRemoveCollaborator']>(async () => [
      { profile: grace.profile, addedBy: [], oldRole: 'use', newRole: null },
    ]),
    removeCollaborator: vi.fn<Overseer['removeCollaborator']>(async () => {
      people = []
      return []
    }),
    listShareLinks: vi.fn<Overseer['listShareLinks']>(async () => links),
    createShareLink: vi.fn<Overseer['createShareLink']>(async () => ({ key: 'fresh', linkId: 'new' })),
    newShareLinkKey: vi.fn<Overseer['newShareLinkKey']>(async () => ({ key: 'again' })),
    previewRevokeShareLink: vi.fn<Overseer['previewRevokeShareLink']>(async () => [
      { profile: grace.profile, addedBy: [], oldRole: 'use', newRole: null },
    ]),
    revokeShareLink: vi.fn<Overseer['revokeShareLink']>(async () => []),
    onRpcBroken: (callback: (error: unknown) => void) => { broken = callback },
    [Symbol.dispose]: vi.fn<() => void>(),
  } satisfies SharingOverseer
  return { overseer, breakIt: () => broken?.(new Error('restarted')) }
}

const PAGE = 'https://os.example/workspace/ws'
const sharing = (overseer: SharingOverseer, open = () => overseer): SharingSource => ({ open, sharing: { page: PAGE, vendors: async () => [] } })

const ready = async (session: SharingSession) => {
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('ready'))
  const snapshot = session.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error('not ready')
  return snapshot
}

describe('SharingSession', () => {
  it('reads only who it is shared with for a page that lists them', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession({ open: () => overseer })
    session.start()
    expect((await ready(session)).collaborators).toEqual([grace])
    expect(session.getSnapshot()).toMatchObject({ link: undefined })
    expect(overseer.listShareLinks).not.toHaveBeenCalled()
    expect(overseer.listObserverRequirements).not.toHaveBeenCalled()
  })

  it('asks nothing of who else has it for someone who can only use it', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace], metadata: { owner: ada, role: 'use' } })
    const session = new SharingSession(sharing(overseer))
    session.start()
    expect((await ready(session)).collaborators).toEqual([])
    expect(overseer.listCollaborators).not.toHaveBeenCalled()
    expect(overseer.listShareLinks).not.toHaveBeenCalled()
  })

  it('reads what each role must have access to when shared', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ requirements: { build: [], use: [] }, vendors: [] }))
    expect(overseer.listObserverRequirements).toHaveBeenCalledWith('build')
    expect(overseer.listObserverRequirements).toHaveBeenCalledWith('use')
  })

  it('lists whoever was invited before saying so', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer))
    session.start()
    await ready(session)
    expect(await session.invite('nobody', 'build')).toBeNull()
    expect(await session.invite('grace', 'use')).toBe(grace)
    expect((await ready(session)).collaborators).toEqual([grace])
    expect(overseer.addCollaborator).toHaveBeenLastCalledWith('grace', 'use')
  })

  it('previews and removes someone, reading the people again', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession(sharing(overseer))
    session.start()
    await ready(session)
    expect(await session.previewRemoval('grace')).toEqual({ left: 'nothing', dependents: [] })
    await session.remove('grace', [])
    expect(overseer.removeCollaborator).toHaveBeenCalledWith('grace', [])
    expect((await ready(session)).collaborators).toEqual([])
  })

  it('mints a key for the link as soon as the link is known to be on', async () => {
    const { overseer } = fakeOverseer({ links: [link('old')] })
    const session = new SharingSession(sharing(overseer))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      link: { status: 'on', role: 'use', linkIds: ['old'], url: `${PAGE}#share=again` },
    }))
    expect(overseer.newShareLinkKey).toHaveBeenCalledWith('old')
  })

  it('turns the link off keeping everyone who came in by it, and on again with a new one', async () => {
    const { overseer } = fakeOverseer({ links: [link('old')] })
    const session = new SharingSession(sharing(overseer))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on' } }))
    await session.setLink('off')
    expect(overseer.revokeShareLink).toHaveBeenCalledWith('old', ['grace'])
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'off' } })
    await session.setLink('build')
    expect(overseer.createShareLink).toHaveBeenCalledWith('build')
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', role: 'build', linkIds: ['new'], url: `${PAGE}#share=fresh` } })
  })

  it('makes another link in place of the old one to change what it lets people do', async () => {
    const { overseer } = fakeOverseer({ links: [link('old', 'build')] })
    const session = new SharingSession(sharing(overseer))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', role: 'build' } }))
    await session.setLink('use')
    expect(overseer.createShareLink).toHaveBeenCalledWith('use')
    expect(overseer.revokeShareLink).toHaveBeenCalledWith('old', ['grace'])
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', role: 'use', linkIds: ['new'] } })
  })

  it('says why it could not be read, and is safe to stop before anything arrives', async () => {
    const { overseer } = fakeOverseer()
    overseer.getMetadata.mockRejectedValueOnce(new Error('No access'))
    const session = new SharingSession(sharing(overseer))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toEqual({ status: 'failed', message: 'No access' }))
    session.start()
    session.stop()
    expect(overseer[Symbol.dispose]).toHaveBeenCalledTimes(2)
  })

  it('opens the workspace again once it can no longer be reached, keeping what is shown', async () => {
    vi.useFakeTimers()
    try {
      const { overseer, breakIt } = fakeOverseer({ collaborators: [grace] })
      const open = vi.fn<() => SharingOverseer>(() => overseer)
      const session = new SharingSession({ open })
      session.start()
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('ready'))
      breakIt()
      expect(session.getSnapshot().status).toBe('ready')
      await vi.advanceTimersByTimeAsync(1000)
      expect(open).toHaveBeenCalledTimes(2)
      session.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
