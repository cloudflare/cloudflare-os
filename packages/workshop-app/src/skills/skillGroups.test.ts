import { describe, expect, it } from 'vitest'
import { collectionDetail, skillGroups } from './skillGroups'
import type { SkillCollection } from './SkillsLibrary'

const PERMISSIONS = { canEdit: true, canShare: true, canManageOwners: true, canDelete: true }
const skill = (name: string, at: number, description = '') => ({ id: `c/${name}/SKILL.md`, collectionId: 'c', path: `${name}/SKILL.md`, name, description, lastUpdated: new Date(at) })
const collection = (id: string, kind: SkillCollection['kind'], skills: SkillCollection['skills']): SkillCollection => ({ id, title: id, kind, shared: kind !== 'mine', permissions: PERMISSIONS, skills })

const COLLECTIONS = [
  collection('mine', 'mine', [skill('weekly-update', 1), skill('meeting-brief', 3, 'Before a meeting')]),
  collection('empty-mine', 'mine', []),
  collection('team', 'shared', []),
  collection('org', 'everyone', [skill('release-notes', 2, 'When a version ships')]),
]

describe('skillGroups', () => {
  it('orders each collection’s skills, latest first or by name', () => {
    expect(skillGroups(COLLECTIONS, { sort: 'recent' })[0].skills.map(({ name }) => name)).toEqual(['meeting-brief', 'weekly-update'])
    expect(skillGroups(COLLECTIONS, { sort: 'name' })[0].skills.map(({ name }) => name)).toEqual(['meeting-brief', 'weekly-update'])
  })

  it('keeps the viewer’s own empty collection as a place to put one, but no one else’s', () => {
    expect(skillGroups(COLLECTIONS, { sort: 'recent' }).map(({ collection }) => collection.id)).toEqual(['mine', 'empty-mine', 'org'])
  })

  it('finds skills by every word of their name or what they are for, leaving out what has none', () => {
    expect(skillGroups(COLLECTIONS, { sort: 'recent', query: 'meeting' }).map(({ collection, skills }) => [collection.id, skills.map(({ name }) => name)])).toEqual([['mine', ['meeting-brief']]])
    expect(skillGroups(COLLECTIONS, { sort: 'recent', query: 'version ships' }).map(({ collection }) => collection.id)).toEqual(['org'])
    expect(skillGroups(COLLECTIONS, { sort: 'recent', query: 'nothing like it' })).toEqual([])
  })

  it('says who has a collection', () => {
    expect(collectionDetail(COLLECTIONS[0])).toBeUndefined()
    expect(collectionDetail({ ...COLLECTIONS[0], shared: true })).toBe('Shared')
    expect(collectionDetail({ ...COLLECTIONS[2], role: 'viewer' })).toBe('Shared with you to use')
    expect(collectionDetail(COLLECTIONS[3], 'Acme')).toBe('For everyone at Acme')
  })
})
