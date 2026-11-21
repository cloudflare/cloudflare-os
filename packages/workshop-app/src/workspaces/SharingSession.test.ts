import { describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, CollaboratorInfo, Overseer, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import { SharingSession, type SharingOverseer, type SharingSource } from './SharingSession'
import type { ShareTarget } from './sharingRules'

const ada: AiChatAuthorInfo = { type: 'user', id: 'ada', name: 'Ada' }
const grace: CollaboratorInfo = { profile: { type: 'user', id: 'grace', name: 'Grace' }, addedBy: [], access: { role: 'use', gadgetIds: [3] } }
const lost = [{ profile: grace.profile, addedBy: [], oldAccess: grace.access, newAccess: null }]

const fakeOverseer = ({ collaborators = [] as CollaboratorInfo[], own = undefined as string | undefined, metadata = {} as Partial<WorkspaceMetadata> } = {}) => {
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
    previewRemoveCollaborator: vi.fn<Overseer['previewRemoveCollaborator']>(async () => lost),
    removeCollaborator: vi.fn<Overseer['removeCollaborator']>(async () => {
      people = []
      return []
    }),
    // Beside the viewer's own default link to the budget, if any: someone else's, one that is not
    // a default, and one to another gadget.
    listShareLinks: vi.fn<Overseer['listShareLinks']>(async () => [
      { linkId: 'grace', created: new Date(0), createdBy: grace.profile, role: 'use', gadgetId: 3, default: true },
      { linkId: 'extra', created: new Date(0), createdBy: ada, role: 'use', gadgetId: 3 },
      { linkId: 'other', created: new Date(0), createdBy: ada, role: 'use', gadgetId: 4, default: true },
      ...(own ? [{ linkId: own, created: new Date(0), createdBy: ada, role: 'use' as const, gadgetId: 3, default: true as const }] : []),
    ]),
    createShareLink: vi.fn<Overseer['createShareLink']>(async () => ({ key: 'fresh', linkId: 'new' })),
    newShareLinkKey: vi.fn<Overseer['newShareLinkKey']>(async () => ({ key: 'again' })),
    revokeShareLink: vi.fn<Overseer['revokeShareLink']>(async () => []),
    onRpcBroken: (callback: (error: unknown) => void) => { broken = callback },
    [Symbol.dispose]: vi.fn<() => void>(),
  } satisfies SharingOverseer
  return { overseer, breakIt: () => broken?.(new Error('restarted')) }
}

const PAGE = 'https://os.example/workspace/ws'
const WHOLE: ShareTarget = { kind: 'workspace' }
const BUDGET: ShareTarget = { kind: 'gadget', gadgetId: 3, title: 'Budget' }
const sharing = (overseer: SharingOverseer, target: ShareTarget = WHOLE): SharingSource => ({
  open: () => overseer,
  sharing: { target, page: PAGE, viewerId: 'ada', vendors: async () => [] },
})

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

  it('reads what whoever it is shared with must have access to', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ requirements: [], vendors: [] }))
    expect(overseer.listObserverRequirements).toHaveBeenCalledExactlyOnceWith({ gadgetId: 3 })
  })

  it('lists whoever was invited before saying so', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer))
    session.start()
    await ready(session)
    expect(await session.invite('nobody')).toBeNull()
    expect(await session.invite('grace')).toBe(grace)
    expect((await ready(session)).collaborators).toEqual([grace])
    expect(overseer.addCollaborator).toHaveBeenLastCalledWith('grace', 'workspace')
  })

  it('shares one gadget to use', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await ready(session)
    await session.invite('grace')
    expect(overseer.addCollaborator).toHaveBeenLastCalledWith('grace', { gadgetId: 3 })
  })

  it('shares one gadget to view only', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await ready(session)
    await session.invite('grace', 'view')
    expect(overseer.addCollaborator).toHaveBeenLastCalledWith('grace', { gadgetId: 3, mode: 'view' })
  })

  it('lets someone who views a gadget use it, and narrows them to a view in one call', async () => {
    const viewer: CollaboratorInfo = { ...grace, access: { role: 'use', gadgetIds: [3], viewOnly: [3] } }
    const { overseer } = fakeOverseer({ collaborators: [viewer] })
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await ready(session)
    expect(await session.changeAccess('grace', 'use')).toBe('use')
    expect(overseer.addCollaborator).toHaveBeenLastCalledWith('grace', { gadgetId: 3 })
    overseer.removeCollaborator.mockResolvedValueOnce([{ profile: grace.profile, addedBy: [], oldAccess: grace.access, newAccess: viewer.access }])
    expect(await session.changeAccess('grace', 'view')).toBe('view')
    expect(overseer.removeCollaborator).toHaveBeenLastCalledWith('grace', [], 3, true)
  })

  it('says they still use it when narrowing changed nothing, as someone else shared it with them', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await ready(session)
    expect(await session.changeAccess('grace', 'view')).toBe('use')
  })

  it('previews and removes someone, reading the people again', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession(sharing(overseer))
    session.start()
    await ready(session)
    expect(await session.previewRemoval('grace')).toEqual({ left: 'nothing', dependents: [] })
    await session.remove('grace', [])
    expect(overseer.removeCollaborator).toHaveBeenCalledWith('grace', [], undefined)
    expect((await ready(session)).collaborators).toEqual([])
  })

  it('takes someone off a shared gadget alone', async () => {
    const { overseer } = fakeOverseer({ collaborators: [grace] })
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await ready(session)
    await session.previewRemoval('grace')
    await session.remove('grace', [])
    expect(overseer.previewRemoveCollaborator).toHaveBeenCalledWith('grace', 3)
    expect(overseer.removeCollaborator).toHaveBeenCalledWith('grace', [], 3)
  })

  it('finds the viewer’s own link with one call, and mints its key only to copy it', async () => {
    const { overseer } = fakeOverseer({ own: 'own' })
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', linkId: 'own' } }))
    expect(overseer.listShareLinks).toHaveBeenCalledOnce()
    expect(overseer.newShareLinkKey).not.toHaveBeenCalled()
    expect(await session.linkToCopy()).toBe(`${PAGE}#share=again`)
    expect(overseer.newShareLinkKey).toHaveBeenCalledExactlyOnceWith('own')
  })

  it('takes the link to be off when the viewer has none of their own, and copies the page', async () => {
    const { overseer } = fakeOverseer()
    const session = new SharingSession(sharing(overseer))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'off' } }))
    expect(await session.linkToCopy()).toBe(PAGE)
    expect(overseer.newShareLinkKey).not.toHaveBeenCalled()
  })

  it('turns the link off keeping everyone who came in by it, and on again with a new one', async () => {
    const { overseer } = fakeOverseer({ own: 'old' })
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on' } }))
    await session.setLink('off')
    expect(overseer.revokeShareLink).toHaveBeenCalledWith('old', 'everyone')
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'off' } })
    await session.setLink('use')
    expect(overseer.createShareLink).toHaveBeenCalledWith({ gadgetId: 3 }, undefined, { default: true })
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', linkId: 'new', url: `${PAGE}#share=fresh` } })
    expect(await session.linkToCopy()).toBe(`${PAGE}#share=fresh`)
    expect(overseer.newShareLinkKey).not.toHaveBeenCalled()
  })

  it('changes what the link gives by making the new one before turning the old one off', async () => {
    const { overseer } = fakeOverseer({ own: 'old' })
    const session = new SharingSession(sharing(overseer, BUDGET))
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', access: 'use' } }))
    await session.setLink('view')
    expect(overseer.createShareLink).toHaveBeenCalledWith({ gadgetId: 3, mode: 'view' }, undefined, { default: true })
    expect(overseer.createShareLink.mock.invocationCallOrder[0]).toBeLessThan(overseer.revokeShareLink.mock.invocationCallOrder[0])
    expect(overseer.revokeShareLink).toHaveBeenCalledWith('old', 'everyone')
    expect(session.getSnapshot()).toMatchObject({ link: { status: 'on', linkId: 'new', access: 'view' } })
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
