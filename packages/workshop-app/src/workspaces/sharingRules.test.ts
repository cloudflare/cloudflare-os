import { describe, expect, it } from 'vitest'
import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorInfo,
  CollaboratorRole,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  PermissionEdge,
  ShareLinkInfo,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import {
  canChange,
  invitedBy,
  inviteRefusal,
  listed,
  removalOutcome,
  roleOf,
  shareKeyOf,
  shareStanding,
  signInServices,
  withShareKey,
  workspaceLinksOf,
  workspaceOfPath,
} from './sharingRules'

const person = (id: string, name = id): AiChatAuthorInfo => ({ type: 'user', id, name })
const by = (sharer: string): PermissionEdge => ({ type: 'user', sharer, created: new Date(0) })
const collaborator = (id: string, role?: CollaboratorRole, addedBy: PermissionEdge[] = [by('ada')]): CollaboratorInfo => ({ profile: person(id), addedBy, role })
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

describe('roleOf', () => {
  it('takes someone added before roles to be able to edit', () => {
    expect(roleOf(collaborator('grace'))).toBe('build')
    expect(roleOf(collaborator('grace', 'use'))).toBe('use')
  })
})

describe('canChange', () => {
  const owner = shareStanding(metadata(), ada)
  const asMember = shareStanding(metadata({ owner: person('grace'), role: 'build' }), ada)

  it('lets the owner change anyone, and anyone else only who they added', () => {
    expect(canChange(collaborator('alan', 'build', [by('grace')]), owner, 'ada')).toBe(true)
    expect(canChange(collaborator('alan', 'build', [by('grace')]), asMember, 'ada')).toBe(false)
    expect(canChange(collaborator('alan', 'build', [by('ada')]), asMember, 'ada')).toBe(true)
  })
})

describe('inviteRefusal', () => {
  const people = [collaborator('grace', 'build'), collaborator('alan', 'use')]

  it('says why an invite would change nothing', () => {
    expect(inviteRefusal('ADA', 'build', ada, people)).toBe('Ada Lovelace owns this workspace.')
    expect(inviteRefusal('grace', 'use', ada, people)).toBe('grace can already edit this workspace.')
    expect(inviteRefusal('alan', 'use', ada, people)).toBe('alan can already use this workspace.')
  })

  it('lets someone who can only use it be let edit, and anyone new in', () => {
    expect(inviteRefusal('alan', 'build', ada, people)).toBeUndefined()
    expect(inviteRefusal('barbara', 'use', ada, people)).toBeUndefined()
  })
})

describe('links', () => {
  const created = new Date(0)
  const link = (linkId: string, role?: CollaboratorRole): ShareLinkInfo => ({ linkId, created, createdBy: ada, role })

  it('takes every link to be the workspace’s one, letting people edit if any does', () => {
    expect(workspaceLinksOf([link('a', 'use'), link('b', 'build'), link('c', 'use')])).toEqual({ linkIds: ['a', 'b', 'c'], role: 'build', shown: 'b' })
    expect(workspaceLinksOf([link('a', 'use')])).toEqual({ linkIds: ['a'], role: 'use', shown: 'a' })
    expect(workspaceLinksOf([link('old')])).toMatchObject({ role: 'build', shown: 'old' })
    expect(workspaceLinksOf([])).toBeUndefined()
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

const affected = (id: string, sharers: string[], newRole: CollaboratorRole | null = null): AffectedCollaborator => ({
  profile: person(id),
  addedBy: sharers.map(by),
  oldRole: 'build',
  newRole,
})

describe('removalOutcome', () => {
  it('separates who is removed from who would lose access through them', () => {
    const outcome = removalOutcome('grace', [affected('grace', ['ada']), affected('alan', ['grace'])])
    expect(outcome.left).toBe('nothing')
    expect(outcome.dependents.map(({ profile }) => profile.id)).toEqual(['alan'])
  })

  it('says when they keep using it, or keep all they had', () => {
    expect(removalOutcome('grace', [affected('grace', ['ada'], 'use')]).left).toBe('use')
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

describe('signInServices', () => {
  const vendors = [vendor('google', 'Google'), vendor('scheduler', 'Scheduled Tasks', true), vendor('context', 'Skills', true), vendor('slack', 'Slack')]

  it('names each service that needs a sign-in once, leaving out those that set themselves up', () => {
    expect(signInServices([need(1, 'context'), need(2, 'scheduler'), need(5, 'Google'), need(6, 'google'), need(7, 'slack')], vendors))
      .toEqual(['Google', 'Slack'])
  })

  it('names none when every connection sets itself up, and waits for the services', () => {
    expect(signInServices([need(1, 'context'), need(2, 'scheduler')], vendors)).toEqual([])
    expect(signInServices([need(5, 'google')], undefined)).toBeUndefined()
  })

  it('lists them as a sentence does', () => {
    expect(listed(['Google'])).toBe('Google')
    expect(listed(['Google', 'Slack', 'GitHub'])).toBe('Google, Slack and GitHub')
  })
})
