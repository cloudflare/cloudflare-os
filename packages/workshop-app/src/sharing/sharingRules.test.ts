import { describe, expect, it } from 'vitest'
import type { AffectedCollaborator, AiChatAuthorInfo, CollaboratorInfo, PermissionEdge, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import {
  canChange,
  gadgetLinksOf,
  gadgetShareRefusal,
  holdersOf,
  invitedBy,
  levelOf,
  membersOf,
  removalOutcome,
  shareKeyOf,
  shareStanding,
  withShareKey,
  workspaceInviteRefusal,
  workspaceOfPath,
} from './sharingRules'

const person = (id: string, name = id): AiChatAuthorInfo => ({ type: 'user', id, name })
const by = (sharer: string): PermissionEdge => ({ type: 'user', sharer, created: new Date(0) })
const member = (id: string, addedBy: PermissionEdge[] = [by('ada')]): CollaboratorInfo => ({ profile: person(id), addedBy, access: { role: 'build' } })
const holder = (id: string, gadgetIds: number[], viewOnly?: number[]): CollaboratorInfo => ({
  profile: person(id),
  addedBy: [by('ada')],
  access: { role: 'use', gadgetIds, viewOnly },
})
const metadata = (change: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata => ({ id: 'ws', title: 'Engineering', ...change })
const ada = person('ada', 'Ada Lovelace')

describe('shareStanding', () => {
  it('takes the viewer to own a workspace whose metadata names no owner', () => {
    expect(shareStanding(metadata(), ada)).toEqual({ owner: ada, isOwner: true, canShare: true, ownerOnly: false })
  })

  it('lets a member share until only the owner may', () => {
    const owned = { owner: person('grace'), role: 'build' as const }
    expect(shareStanding(metadata(owned), ada).canShare).toBe(true)
    expect(shareStanding(metadata({ ...owned, ownerInvitesOnly: true }), ada).canShare).toBe(false)
    expect(shareStanding(metadata({ ownerInvitesOnly: true }), ada).canShare).toBe(true)
  })

  it('never lets someone who can only use gadgets share', () => {
    expect(shareStanding(metadata({ owner: person('grace'), role: 'use' }), ada).canShare).toBe(false)
  })
})

describe('who has what', () => {
  const people = [member('grace'), holder('alan', [3, 4], [4]), member('ada')]

  it('tells members and gadget holders apart', () => {
    expect(membersOf(people, ada).map(({ profile }) => profile.id)).toEqual(['grace'])
    expect(holdersOf(people, 3).map(({ profile }) => profile.id)).toEqual(['alan'])
    expect(holdersOf(people, 5)).toEqual([])
  })

  it('reads a gadget given to view only as view', () => {
    expect(levelOf(people[1], 3)).toBe('use')
    expect(levelOf(people[1], 4)).toBe('view')
    expect(levelOf(people[0], 4)).toBe('use')
  })
})

describe('canChange', () => {
  const owner = shareStanding(metadata(), ada)
  const asMember = shareStanding(metadata({ owner: person('grace'), role: 'build' }), ada)

  it('lets the owner change anyone, and anyone else only who they added', () => {
    expect(canChange(member('alan', [by('grace')]), owner, 'ada')).toBe(true)
    expect(canChange(member('alan', [by('grace')]), asMember, 'ada')).toBe(false)
    expect(canChange(member('alan', [by('ada')]), asMember, 'ada')).toBe(true)
  })
})

describe('refusals', () => {
  it('says why an invite to the workspace would change nothing', () => {
    expect(workspaceInviteRefusal('ADA', ada, [])).toBe('Ada Lovelace owns this workspace.')
    expect(workspaceInviteRefusal('grace', ada, [member('grace')])).toBe('grace is already a member of this workspace.')
    expect(workspaceInviteRefusal('grace', ada, [member('grace')], 'chat')).toBe('grace already has this chat.')
    expect(workspaceInviteRefusal('alan', ada, [member('grace')])).toBeUndefined()
  })

  it('says why sharing a gadget would change nothing', () => {
    const people = [member('grace'), holder('alan', [3])]
    expect(gadgetShareRefusal('ada', ada, people, 3)).toMatch(/owns this workspace/)
    expect(gadgetShareRefusal('grace', ada, people, 3)).toMatch(/is a member of this workspace/)
    expect(gadgetShareRefusal('alan', ada, people, 3)).toBe('This gadget is already shared with alan.')
    expect(gadgetShareRefusal('alan', ada, people, 4)).toBeUndefined()
    expect(gadgetShareRefusal('barbara', ada, people, 3)).toBeUndefined()
  })
})

describe('links', () => {
  it('takes every link to use the gadget to be its link', () => {
    const created = new Date(0)
    const links = [
      { linkId: 'a', created, createdBy: ada, role: 'use' as const, gadgetId: 3 },
      { linkId: 'b', created, createdBy: ada, role: 'build' as const },
      { linkId: 'c', created, createdBy: ada, role: 'use' as const, gadgetId: 4 },
      { linkId: 'd', created, createdBy: ada, role: 'use' as const, gadgetId: 3 },
    ]
    expect(gadgetLinksOf(links, 3)).toEqual(['a', 'd'])
  })

  it('carries the key in the fragment, and reads it back', () => {
    const url = withShareKey('https://os.example/app/ws-3?chat=1', 'k3y')
    expect(url).toBe('https://os.example/app/ws-3?chat=1#share=k3y')
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

const affected = (id: string, sharers: string[]): AffectedCollaborator => ({
  profile: person(id),
  addedBy: sharers.map(by),
  oldAccess: { role: 'build' },
} as AffectedCollaborator)

describe('removalOutcome', () => {
  it('separates who is removed from who would lose access through them', () => {
    const outcome = removalOutcome('grace', [affected('grace', ['ada']), affected('alan', ['grace'])])
    expect(outcome.losesAccess).toBe(true)
    expect(outcome.dependents.map(({ profile }) => profile.id)).toEqual(['alan'])
    expect(removalOutcome('grace', []).losesAccess).toBe(false)
  })

  it('names who added each, or the link', () => {
    const names = new Map([['grace', 'Grace Hopper']])
    expect(invitedBy(affected('alan', ['grace', 'ada']), names)).toBe('Grace Hopper, ada')
    expect(invitedBy({ ...affected('alan', []), addedBy: [{ type: 'shareKey', keyId: 'k', created: new Date(0) } as PermissionEdge] }, names)).toBe('A link')
  })
})
