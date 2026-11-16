import { describe, expect, it } from 'vitest'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { narrowList } from '@/components/listView'
import { workspaceList } from './workspaceList'
import type { WorkspaceMember } from './workspaceMembers'

const NOW = new Date(2026, 10, 12, 15)
const workspace = (id: string, title = id): WorkspaceMetadataWithTimestamps => ({ id, title, created: NOW, lastActive: NOW })
const member = (id: string, name = id): WorkspaceMember => ({ profile: { type: 'user', id, name }, role: 'build' })

const WORKSPACES = [workspace('alone'), workspace('pair'), workspace('team'), workspace('unknown')]
const MEMBERSHIPS = new Map([
  ['alone', [member('me')]],
  ['pair', [member('me'), member('grace', 'Grace Hopper')]],
  ['team', [member('grace', 'Grace Hopper'), member('me'), member('alan', 'Alan Turing')]],
])
const spec = workspaceList(WORKSPACES, MEMBERSHIPS, 'me')
const memberOptions = spec.filters!.filter(({ facet }) => facet === 'member')
const left = (...ids: string[]) =>
  narrowList(WORKSPACES, { query: '', searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }).map(({ id }) => id)

describe('workspaceList', () => {
  it('has a filter for nobody else, then one for each other person by name', () => {
    expect(memberOptions.map(({ id, label }) => [id, label])).toEqual([
      ['member:none', 'No one else'],
      ['member:with:alan', 'Alan Turing'],
      ['member:with:grace', 'Grace Hopper'],
    ])
  })

  it('has no filters for members until someone else is known of', () => {
    expect(workspaceList(WORKSPACES, new Map([['alone', [member('me')]]]), 'me').filters!.some(({ facet }) => facet === 'member')).toBe(false)
  })

  it('narrows to the workspaces a person has access to, taking people as alternatives', () => {
    expect(left('member:with:grace')).toEqual(['pair', 'team'])
    expect(left('member:with:alan', 'member:none')).toEqual(['alone', 'team'])
  })

  it('finds a workspace by who has access to it', () => {
    expect(narrowList(WORKSPACES, { query: 'turing', searchText: spec.searchText, filters: [] }).map(({ id }) => id)).toEqual(['team'])
  })
})
