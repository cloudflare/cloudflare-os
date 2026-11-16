import { describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, CollaboratorInfo, Overseer, ShareLinkInfo } from '@gadgets/workshop-shared/api'
import { SharingSession, type SharingOverseer } from './SharingSession'

const ada: AiChatAuthorInfo = { type: 'user', id: 'ada', name: 'Ada' }
const grace: CollaboratorInfo = { profile: { type: 'user', id: 'grace', name: 'Grace' }, addedBy: [], access: { role: 'use', gadgetIds: [3] } }
const link = (linkId: string, gadgetId: number): ShareLinkInfo => ({ linkId, created: new Date(0), createdBy: ada, role: 'use', gadgetId })

const fakeOverseer = ({ collaborators = [] as CollaboratorInfo[], links = [] as ShareLinkInfo[] } = {}) => {
  let people = collaborators
  let broken: ((error: unknown) => void) | undefined
  const overseer = {
    getMetadata: vi.fn<Overseer['getMetadata']>(async () => ({ id: 'ws', title: 'Engineering' })),
    listCollaborators: vi.fn<Overseer['listCollaborators']>(async () => people),
    listObserverRequirements: vi.fn<Overseer['listObserverRequirements']>(async () => []),
    addCollaborator: vi.fn<Overseer['addCollaborator']>(async (username) => {
      if (username !== 'grace') return null
      people = [...people, grace]
      return grace
    }),
    setCollaboratorGadgetAccess: vi.fn<Overseer['setCollaboratorGadgetAccess']>(async () => []),
    previewRemoveCollaborator: vi.fn<Overseer['previewRemoveCollaborator']>(async () => [
      { profile: grace.profile, addedBy: [], oldAccess: grace.access, newAccess: null },
    ]),
    removeCollaborator: vi.fn<Overseer['removeCollaborator']>(async () => {
      people = []
      return []
    }),
    listShareLinks: vi.fn<Overseer['listShareLinks']>(async () => links),
    createShareLink: vi.fn<Overseer['createShareLink']>(async () => ({ key: 'fresh', linkId: 'new' })),
    newShareLinkKey: vi.fn<Overseer['newShareLinkKey']>(async () => ({ key: 'again' })),
    previewRevokeShareLink: vi.fn<Overseer['previewRevokeShareLink']>(async () => [
      { profile: grace.profile, addedBy: [], oldAccess: grace.access, newAccess: null },
    ]),
    revokeShareLink: vi.fn<Overseer['revokeShareLink']>(async () => []),
    onRpcBroken: (callback: (error: unknown) => void) => { broken = callback },
    [Symbol.dispose]: vi.fn<() => void>(),
  } satisfies SharingOverseer
  return { overseer, breakIt: () => broken?.(new Error('restarted')) }
}

const ready = async (session: SharingSession) => {
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('ready'))
  const snapshot = session.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error('not ready')
  return snapshot
}

const GADGET = { id: 3, page: 'https://os.example/app/ws-3' }

describe('SharingSession', () => {
  it('reads who it is shared with, and what they must have access to', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession(() => overseer)
    session.start()
    expect((await ready(session)).collaborators).toEqual([grace])
    expect(overseer.listObserverRequirements).toHaveBeenCalledWith('workspace')
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ requirements: [] }))
    expect(session.getSnapshot()).not.toHaveProperty('link', expect.anything())
  })

  it('lists whoever was invited before saying so', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(() => overseer)
    session.start()
    await ready(session)
    expect(await session.invite('nobody', 'workspace')).toBeNull()
    expect(await session.invite('grace', { gadgetId: 3 })).toBe(grace)
    expect((await ready(session)).collaborators).toEqual([grace])
    expect(overseer.addCollaborator).toHaveBeenLastCalledWith('grace', { gadgetId: 3 })
  })

  it('previews and removes only the gadget’s grants from a gadget’s dialog', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession(() => overseer, { gadget: GADGET })
    session.start()
    await ready(session)
    expect(await session.previewRemoval('grace')).toEqual({ losesAccess: true, dependents: [] })
    expect(overseer.previewRemoveCollaborator).toHaveBeenCalledWith('grace', 3)
    await session.remove('grace', [])
    expect(overseer.removeCollaborator).toHaveBeenCalledWith('grace', [], 3)
    expect((await ready(session)).collaborators).toEqual([])
  })

  it('mints a key for a gadget’s link as soon as the link is known to be on', async () => {
    const { overseer } = fakeOverseer({ links: [link('old', 3), link('other', 4)] })
    const session = new SharingSession(() => overseer, { gadget: GADGET })
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      link: { status: 'on', level: 'use', linkIds: ['old'], url: 'https://os.example/app/ws-3#share=again' },
    }))
    expect(overseer.newShareLinkKey).toHaveBeenCalledWith('old')
  })

  it('turns the link off keeping everyone who came in by it, and on again with a new one', async () => {
    const { overseer } = fakeOverseer({ links: [link('old', 3)] })
    const session = new SharingSession(() => overseer, { gadget: GADGET })
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on' } }))
    await session.setLink('off')
    expect(overseer.revokeShareLink).toHaveBeenCalledWith('old', ['grace'])
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'off' } })
    await session.setLink('use')
    expect(overseer.createShareLink).toHaveBeenCalledWith({ gadgetId: 3 })
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', level: 'use', linkIds: ['new'], url: 'https://os.example/app/ws-3#share=fresh' } })
  })

  it('makes the link only show the gadget’s view with a new one, keeping whoever came in by the old', async () => {
    const { overseer } = fakeOverseer({ links: [link('old', 3)] })
    const session = new SharingSession(() => overseer, { gadget: GADGET })
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', level: 'use' } }))
    await session.setLink('view')
    expect(overseer.createShareLink).toHaveBeenCalledWith({ gadgetId: 3, viewOnly: true })
    expect(overseer.revokeShareLink).toHaveBeenCalledWith('old', ['grace'])
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', level: 'view', linkIds: ['new'] } })
  })

  it('says why it could not be read, and is safe to stop before anything arrives', async () => {
    const { overseer } = fakeOverseer()
    overseer.getMetadata.mockRejectedValueOnce(new Error('No access'))
    const session = new SharingSession(() => overseer)
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
      const session = new SharingSession(open)
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
