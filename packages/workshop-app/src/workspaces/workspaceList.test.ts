import { describe, expect, it } from 'vitest'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { narrowList } from '@gadgets/ui'
import { workspaceList } from './workspaceList'

const NOW = new Date(2026, 10, 12, 15)
const workspace = (id: string, title = id): WorkspaceMetadataWithTimestamps => ({ id, title, created: NOW, lastActive: NOW })
const WORKSPACES = [workspace('mine'), workspace('team'), { ...workspace('lent'), owner: { type: 'user' as const, id: 'grace', name: 'Grace Hopper' } }]
const spec = workspaceList()
const left = (...ids: string[]) =>
  narrowList(WORKSPACES, { query: '', searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }).map(({ id }) => id)

const unreadOnly = (unread: ReadonlySet<string>) => {
  const filters = workspaceList(unread).filters!.filter(({ id }) => id === 'unread')
  return narrowList(WORKSPACES, { query: '', searchText: spec.searchText, filters }).map(({ id }) => id)
}

describe('workspaceList', () => {
  it('narrows to whose a workspace is', () => {
    expect(left('mine')).toEqual(['mine', 'team'])
    expect(left('shared')).toEqual(['lent'])
  })

  it('finds a workspace by its title or its owner', () => {
    expect(narrowList(WORKSPACES, { query: 'hopper', searchText: spec.searchText, filters: [] }).map(({ id }) => id)).toEqual(['lent'])
    expect(narrowList(WORKSPACES, { query: 'team', searchText: spec.searchText, filters: [] }).map(({ id }) => id)).toEqual(['team'])
  })

  it('narrows to the workspaces with anything unread, and to none before the account has said', () => {
    expect(unreadOnly(new Set(['team', 'mine']))).toEqual(['mine', 'team'])
    expect(unreadOnly(new Set())).toEqual([])
  })
})
