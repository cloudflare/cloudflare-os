import { describe, expect, it } from 'vitest'
import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorAccess,
  CollaboratorInfo,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  PermissionEdge,
  ShareLinkInfo,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import {
  accessLabel,
  canChange,
  covers,
  grantOf,
  invitedBy,
  inviteRefusal,
  ownLinkOf,
  removalOutcome,
  type ShareTarget,
  shareKeyOf,
  shareStanding,
  protectedResources,
  withShareKey,
  workspaceOfPath,
} from './sharingRules'

const person = (id: string, name = id): AiChatAuthorInfo => ({ type: 'user', id, name })
const by = (sharer: string): PermissionEdge => ({ type: 'user', sharer, created: new Date(0) })
const BUILD: CollaboratorAccess = { role: 'build' }
const uses = (...gadgetIds: number[]): CollaboratorAccess => ({ role: 'use', gadgetIds })
const collaborator = (id: string, access: CollaboratorAccess = BUILD, addedBy: PermissionEdge[] = [by('ada')]): CollaboratorInfo => ({ profile: person(id), addedBy, access })
const WHOLE: ShareTarget = { kind: 'workspace' }
const gadget = (gadgetId: number, title = 'Budget'): ShareTarget => ({ kind: 'gadget', gadgetId, title })
const metadata = (change: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata => ({ id: 'ws', title: 'Engineering', ...change })
const ada = person('ada', 'Ada Lovelace')

describe('shareStanding', () => {
  it('takes the viewer to own a workspace whose metadata names no owner', () => {
    expect(shareStanding(metadata(), ada)).toEqual({ owner: ada, isOwner: true, canShare: true, ownerOnly: false })
  })

  it('lets someone who can edit share until only the owner may', () => {
    const owned = { owner: person('grace'), role: 'build' as const }
    expect(shareStanding(metadata(owned), ada).canShare).toBe(true)
    expect(shareStanding(metadata({ ...owned, ownerInvitesOnly: true }), ada).canShare).toBe(false)
    expect(shareStanding(metadata({ ownerInvitesOnly: true }), ada).canShare).toBe(true)
  })

  it('never lets someone who can only use it share', () => {
    expect(shareStanding(metadata({ owner: person('grace'), role: 'use' }), ada).canShare).toBe(false)
  })
})

describe('access', () => {
  it('grants the whole workspace, or one gadget', () => {
    expect(grantOf(WHOLE)).toBe('workspace')
    expect(grantOf(gadget(3))).toEqual({ gadgetId: 3 })
  })

  it('takes editing to cover everything, and using only the gadgets it names', () => {
    expect(covers(BUILD, gadget(3))).toBe(true)
    expect(covers(uses(3), gadget(3))).toBe(true)
    expect(covers(uses(4), gadget(3))).toBe(false)
    expect(covers(uses(3), WHOLE)).toBe(false)
  })

  it('says what someone may do in a few words', () => {
    expect(accessLabel(BUILD)).toBe('Member')
    expect(accessLabel(uses(3))).toBe('Uses a gadget')
    expect(accessLabel(uses(3, 4))).toBe('Uses 2 gadgets')
  })
})

describe('canChange', () => {
  const owner = shareStanding(metadata(), ada)
  const asMember = shareStanding(metadata({ owner: person('grace'), role: 'build' }), ada)

  it('lets the owner change anyone, and anyone else only who they added', () => {
    expect(canChange(collaborator('alan', BUILD, [by('grace')]), owner, 'ada')).toBe(true)
    expect(canChange(collaborator('alan', BUILD, [by('grace')]), asMember, 'ada')).toBe(false)
    expect(canChange(collaborator('alan', BUILD, [by('ada')]), asMember, 'ada')).toBe(true)
  })
})

describe('inviteRefusal', () => {
  const people = [collaborator('grace'), collaborator('alan', uses(3))]

  it('says why an invite would change nothing', () => {
    expect(inviteRefusal('ADA', WHOLE, ada, people)).toBe('Ada Lovelace owns this workspace.')
    expect(inviteRefusal('grace', gadget(3), ada, people)).toBe('grace is already a member of this workspace.')
    expect(inviteRefusal('alan', gadget(3), ada, people)).toBe('alan can already use Budget.')
  })

  it('lets someone who uses a gadget be let edit, or use another, and anyone new in', () => {
    expect(inviteRefusal('alan', WHOLE, ada, people)).toBeUndefined()
    expect(inviteRefusal('alan', gadget(4), ada, people)).toBeUndefined()
    expect(inviteRefusal('barbara', gadget(3), ada, people)).toBeUndefined()
  })
})

describe('links', () => {
  const created = new Date(0)
  const link = (linkId: string, change: Partial<ShareLinkInfo> = {}): ShareLinkInfo => ({ linkId, created, createdBy: ada, default: true, ...change })

  it('finds the viewer’s own link to what is being shared', () => {
    const links = [
      link('theirs', { createdBy: person('grace') }),
      link('extra', { default: undefined }),
      link('gadget', { role: 'use', gadgetId: 3 }),
      link('whole', { role: 'build' }),
    ]
    expect(ownLinkOf(links, WHOLE, 'ada')?.linkId).toBe('whole')
    expect(ownLinkOf(links, gadget(3), 'ada')?.linkId).toBe('gadget')
    expect(ownLinkOf(links, gadget(4), 'ada')).toBeUndefined()
    expect(ownLinkOf([link('old')], WHOLE, 'ada')?.linkId).toBe('old')
    expect(ownLinkOf([link('several', { role: 'use', gadgets: [{ id: 3, title: 'Budget' }, { id: 4, title: 'Plan' }] })], WHOLE, 'ada')).toBeUndefined()
  })

  it('carries the key in the fragment, and reads it back', () => {
    const url = withShareKey('https://os.example/app/ws-3', 'k3y')
    expect(url).toBe('https://os.example/app/ws-3#share=k3y')
    expect(shareKeyOf(new URL(url).hash)).toBe('k3y')
    expect(shareKeyOf('#share=')).toBeUndefined()
    expect(shareKeyOf('#other')).toBeUndefined()
  })

  it('finds the workspace a shared page is in', () => {
    expect(workspaceOfPath('/workspace/ws1')).toBe('ws1')
    expect(workspaceOfPath('/workspace/ws1/chat/2')).toBe('ws1')
    expect(workspaceOfPath('/app/ws1-3')).toBe('ws1')
    expect(workspaceOfPath('/library/ws1-file-abc')).toBe('ws1')
    expect(workspaceOfPath('/library')).toBeUndefined()
    expect(workspaceOfPath('/')).toBeUndefined()
  })
})

const affected = (id: string, sharers: string[], newAccess: CollaboratorAccess | null = null): AffectedCollaborator => ({
  profile: person(id),
  addedBy: sharers.map(by),
  oldAccess: BUILD,
  newAccess,
})

describe('removalOutcome', () => {
  it('separates who is removed from who would lose access through them', () => {
    const outcome = removalOutcome('grace', [affected('grace', ['ada']), affected('alan', ['grace'])])
    expect(outcome.left).toBe('nothing')
    expect(outcome.dependents.map(({ profile }) => profile.id)).toEqual(['alan'])
  })

  it('says when they keep using it, or keep all they had', () => {
    expect(removalOutcome('grace', [affected('grace', ['ada'], uses(3))]).left).toBe('use')
    expect(removalOutcome('grace', []).left).toBe('unchanged')
  })

  it('names who added each, or the link', () => {
    const names = new Map([['grace', 'Grace Hopper']])
    expect(invitedBy(affected('alan', ['grace', 'ada']), names)).toBe('Grace Hopper, ada')
    expect(invitedBy({ ...affected('alan', []), addedBy: [{ type: 'shareKey', keyId: 'k', created: new Date(0) }] }, names)).toBe('A link')
  })
})

const need = (gatekeeperId: number, vendorId: string): ObserverBindingNeed => ({ gatekeeperId, vendorId, resourceTitle: `Connection ${gatekeeperId}` })
const vendor = (id: string, displayName: string, autoProvisionsAccount = false) =>
  ({ id, description: { displayName, autoProvisionsAccount } }) as unknown as GatekeeperVendorInfo

describe('protectedResources', () => {
  const vendors = [vendor('google', 'Google'), vendor('scheduler', 'Scheduled Tasks', true)]
  const doc = { ...need(6, 'google'), resourceTitle: 'Plan', resourceUrl: 'https://docs.google.com/d/1' }

  it('lists each resource once, by its title, with its service and every connection that reads it', () => {
    const resources = protectedResources([need(2, 'scheduler'), need(5, 'Google'), need(5, 'google'), doc, { ...doc, gatekeeperId: 7 }, { ...doc, gatekeeperId: 8, resourceTitle: 'Plan, renamed' }], vendors)
    expect(resources?.map(({ title, url, needs }) => [title, url, needs.map(({ gatekeeperId }) => gatekeeperId)])).toEqual([
      ['Connection 5', undefined, [5]],
      ['Plan', 'https://docs.google.com/d/1', [6, 7, 8]],
    ])
    expect(resources?.[0]?.service).toEqual({ name: 'Google', logoUrl: undefined, color: undefined })
  })

  it('tells resources without an address apart by their titles, and waits for the services', () => {
    expect(protectedResources([need(1, 'google'), need(2, 'google'), { ...need(3, 'google'), resourceTitle: 'Connection 1' }], vendors)?.map(({ needs }) => needs.length)).toEqual([2, 1])
    expect(protectedResources([need(5, 'google')], undefined)).toBeUndefined()
  })
})
