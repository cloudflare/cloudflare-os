import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, CollaboratorInfo } from '@gadgets/workshop-shared/api'
import { workspaceMembers } from './workspaceMembers'

const person = (id: string): AiChatAuthorInfo => ({ type: 'user', id, name: id })
const collaborator = (id: string, role?: CollaboratorInfo['role']): CollaboratorInfo => ({ profile: person(id), addedBy: [], role })

describe('workspaceMembers', () => {
  it('puts the owner first, then the collaborators in the order given', () => {
    const members = workspaceMembers(person('ada'), [collaborator('grace', 'use'), collaborator('alan', 'build')])
    expect(members.map(({ profile, role }) => [profile.id, role])).toEqual([['ada', 'owner'], ['grace', 'use'], ['alan', 'build']])
  })

  it('lists the owner once, should the collaborators include them', () => {
    expect(workspaceMembers(person('ada'), [collaborator('ada', 'build')]).map(({ role }) => role)).toEqual(['owner'])
  })

  it('takes a collaborator added before roles to be able to build', () => {
    expect(workspaceMembers(person('ada'), [collaborator('grace')])[1].role).toBe('build')
  })
})
