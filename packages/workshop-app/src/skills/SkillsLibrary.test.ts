import { describe, expect, it, vi } from 'vitest'
import type { ContextApi, EnabledCollectionInfo } from '@gadgets/gatekeeper-context/src/context-types'
import { SkillsLibrary, type SkillsApi } from './SkillsLibrary'

const PERMISSIONS = { canEdit: true, canShare: true, canManageOwners: true, canDelete: true }
const READ_ONLY = { canEdit: false, canShare: false, canManageOwners: false, canDelete: false }

const collection = (id: string, source: 'private' | 'public', role?: 'owner' | 'editor' | 'viewer'): EnabledCollectionInfo => ({
  id,
  title: id === 'team' ? 'Team skills' : id === 'org' ? 'Acme' : 'Mine',
  description: '',
  source,
  lastUpdated: new Date(0),
  membership: role && { role, shared: role !== 'owner' },
})

const doc = (path: string, skillName?: string) => ({ path, name: path.split('/').at(-1)!, description: `${path} description`, contentType: 'text/markdown', skillName, lastUpdated: new Date(1) })

const fakeUi = (collections: EnabledCollectionInfo[]) => {
  const ui = {
    listEnabledContextCollections: vi.fn<ContextApi['listEnabledContextCollections']>(async () => collections),
    getViewerInfo: vi.fn<ContextApi['getViewerInfo']>(async () => ({ isAdmin: false, supportsGitCollections: false })),
    listContextDocuments: vi.fn<ContextApi['listContextDocuments']>(async (id: string) => (id === 'org'
      ? [doc('meeting-brief/SKILL.md', 'meeting-brief'), doc('notes.md')]
      : [doc('weekly-update/SKILL.md', 'weekly-update')])),
    getContextCollectionPermissions: vi.fn<ContextApi['getContextCollectionPermissions']>(async (id: string) => (id === 'org' ? READ_ONLY : PERMISSIONS)),
    createContextCollection: vi.fn<ContextApi['createContextCollection']>(async () => ({ id: 'made' }) as Awaited<ReturnType<ContextApi['createContextCollection']>>),
    createContextSkill: vi.fn<ContextApi['createContextSkill']>(async () => {}),
    renameContextSkill: vi.fn<ContextApi['renameContextSkill']>(async () => {}),
    shareContextCollection: vi.fn<ContextApi['shareContextCollection']>(async () => {}),
    getContextDocument: vi.fn<ContextApi['getContextDocument']>(async () => null),
  }
  return ui as typeof ui & ContextApi
}

const fakeApi = (ui: ContextApi | null, addable: string[] = []) => {
  const api = {
    getGatekeeperApp: vi.fn<SkillsApi['getGatekeeperApp']>(async () => (ui ? { iframeHtml: '', ui } : null)),
    listAddableGatekeepers: vi.fn<SkillsApi['listAddableGatekeepers']>(async () => addable.map((id) => ({ id }) as Awaited<ReturnType<SkillsApi['listAddableGatekeepers']>>[number])),
    provisionAmbientAccount: vi.fn<SkillsApi['provisionAmbientAccount']>(async () => {}),
    createGatekeeperUserSelection: vi.fn<SkillsApi['createGatekeeperUserSelection']>(async (_vendor, userId) => ({ ticket: `ticket-for-${userId}` }) as Awaited<ReturnType<SkillsApi['createGatekeeperUserSelection']>>),
  }
  return api as typeof api & SkillsApi
}

const ready = async (library: SkillsLibrary) => {
  await vi.waitFor(() => expect(library.getSnapshot().status).not.toBe('loading'))
  return library.getSnapshot()
}

describe('SkillsLibrary', () => {
  it('reads nothing until something wants the skills', async () => {
    const api = fakeApi(fakeUi([]))
    const library = new SkillsLibrary(() => api)
    expect(api.getGatekeeperApp).not.toHaveBeenCalled()
    library.retain()
    await ready(library)
    expect(api.getGatekeeperApp).toHaveBeenCalledWith('context')
  })

  it('says Skills are off, and whether one click turns them on', async () => {
    const offered = new SkillsLibrary(() => fakeApi(null, ['context']))
    offered.retain()
    expect(await ready(offered)).toEqual({ status: 'off', canTurnOn: true })

    const unoffered = new SkillsLibrary(() => fakeApi(null))
    unoffered.retain()
    expect(await ready(unoffered)).toEqual({ status: 'off', canTurnOn: false })
  })

  it('lists the viewer’s own collections, then what was shared, then everyone’s, with only their skills', async () => {
    const library = new SkillsLibrary(() => fakeApi(fakeUi([collection('org', 'public'), collection('team', 'private', 'editor'), collection('mine', 'private', 'owner')])))
    library.retain()
    const snapshot = await ready(library)
    if (snapshot.status !== 'ready') throw new Error(snapshot.status)
    expect(snapshot.collections.map(({ id, kind, shared }) => [id, kind, shared])).toEqual([['mine', 'mine', false], ['team', 'shared', true], ['org', 'everyone', true]])
    expect(snapshot.collections[2].skills.map(({ id, name }) => [id, name])).toEqual([['org/meeting-brief/SKILL.md', 'meeting-brief']])
  })

  it('makes a first skill in a collection of the viewer’s own, made for it', async () => {
    const ui = fakeUi([collection('org', 'public')])
    const library = new SkillsLibrary(() => fakeApi(ui))
    library.retain()
    await ready(library)
    const id = await library.create({ title: 'Meeting brief', description: 'Before meetings', instructions: 'Read the notes.' })
    expect(ui.createContextCollection).toHaveBeenCalledWith('My skills', expect.any(String), 'private')
    expect(ui.createContextSkill).toHaveBeenCalledWith('made', 'meeting-brief/SKILL.md', expect.objectContaining({ description: 'Before meetings' }))
    expect(id).toBe('made/meeting-brief/SKILL.md')
  })

  it('refuses a skill with no name to make, or no word on when to use it, before asking', async () => {
    const ui = fakeUi([])
    const library = new SkillsLibrary(() => fakeApi(ui))
    await expect(library.create({ title: '!!!', description: 'x', instructions: '' })).rejects.toThrow(/name/)
    await expect(library.create({ title: 'Brief', description: ' ', instructions: '' })).rejects.toThrow(/when/)
    expect(ui.createContextSkill).not.toHaveBeenCalled()
  })

  it('moves a renamed skill with its name, in the same folder', async () => {
    const ui = fakeUi([collection('mine', 'private', 'owner')])
    const library = new SkillsLibrary(() => fakeApi(ui))
    const skill = { id: 'mine/tools/brief/SKILL.md', collectionId: 'mine', path: 'tools/brief/SKILL.md', name: 'brief', description: '', lastUpdated: new Date(0) }
    expect(await library.rename(skill, 'Meeting brief')).toBe('mine/tools/meeting-brief/SKILL.md')
    expect(ui.renameContextSkill).toHaveBeenCalledWith('mine', 'tools/brief/SKILL.md', 'meeting-brief')
    expect(await library.rename(skill, 'brief')).toBe(skill.id)
  })

  it('shares with the person picked through a ticket for them', async () => {
    const ui = fakeUi([])
    const library = new SkillsLibrary(() => fakeApi(ui))
    await library.share('mine', 'ada', 'editor')
    expect(ui.shareContextCollection).toHaveBeenCalledWith('mine', 'ticket-for-ada', 'editor')
  })
})
