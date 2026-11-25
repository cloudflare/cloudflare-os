import { describe, expect, it } from 'vitest'
import { narrowList } from '@gadgets/ui'
import { memberList } from './memberList'
import type { WorkspaceMember } from './workspaceMembers'

const member = (id: string, name: string, role: WorkspaceMember['role'] = 'build'): WorkspaceMember => ({ profile: { type: 'user', id, name }, role })
const MEMBERS = [member('me', 'Zed Owner', 'owner'), member('grace', 'Grace Hopper'), member('alan', 'Alan Turing')]

const ids = (order: string) =>
  memberList.orders.find(({ id }) => id === order)!.arrange(MEMBERS, 1).flatMap(({ entries }) => entries.map(({ value }) => value.profile.id))

describe('memberList', () => {
  it('keeps the owner first, then the others as given, until ordered by name', () => {
    expect(ids('owner')).toEqual(['me', 'grace', 'alan'])
    expect(ids('name')).toEqual(['alan', 'grace', 'me'])
  })

  it('puts everyone in one group', () => {
    expect(memberList.orders[1].arrange(MEMBERS, 1)).toHaveLength(1)
  })

  it('searches by name', () => {
    const found = narrowList(MEMBERS, { query: 'hopper', searchText: memberList.searchText, filters: [] })
    expect(found.map(({ profile }) => profile.id)).toEqual(['grace'])
  })
})
