import { describe, expect, it } from 'vitest'
import { canLeave, collectionAccess, collectionDetail, skillCount } from './collectionList'
import type { SkillCollection } from './SkillStore'

const collection = (rest: Partial<SkillCollection> = {}): SkillCollection => ({
  id: 'c',
  title: 'Team',
  description: '',
  source: { kind: 'mine' },
  role: 'owner',
  shared: false,
  permissions: { canEdit: true, canShare: true, canManageOwners: true, canDelete: true },
  untagged: false,
  skillCount: 0,
  updated: new Date(2026, 10, 17),
  ...rest,
})

describe('collectionList', () => {
  it('counts skills in words', () => {
    expect([0, 1, 4].map(skillCount)).toEqual(['No skills', '1 skill', '4 skills'])
  })

  it('says who has a collection besides the user, and nothing while it is only theirs', () => {
    expect(collectionAccess(collection())).toBeUndefined()
    expect(collectionAccess(collection({ shared: true }))).toBe('Shared')
    expect(collectionAccess(collection({ source: { kind: 'shared', by: 'Grace Hopper' }, role: 'viewer', shared: true }))).toBe('Shared by Grace Hopper')
    expect(collectionAccess(collection({ source: { kind: 'organization' }, role: undefined }))).toBe('Organization')
    expect(collectionDetail(collection({ skillCount: 3, shared: true }))).toBe('3 skills · Shared')
    expect(collectionDetail(collection({ skillCount: 1 }))).toBe('1 skill')
  })

  it('lets the user leave only what somebody else shared with them, and not as its owner', () => {
    expect(canLeave(collection())).toBe(false)
    expect(canLeave(collection({ source: { kind: 'shared', by: 'Grace' }, role: 'editor' }))).toBe(true)
    expect(canLeave(collection({ source: { kind: 'shared', by: 'Grace' }, role: 'owner' }))).toBe(false)
    expect(canLeave(collection({ source: { kind: 'organization' }, role: undefined }))).toBe(false)
  })
})
