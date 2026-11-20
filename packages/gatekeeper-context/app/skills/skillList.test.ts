import { describe, expect, it } from 'vitest'
import { narrowList } from '@gadgets/ui'
import { skillList, skillOwner, skillTags } from './skillList'
import type { Skill } from './SkillStore'

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

const skill = (name: string, rest: Partial<Skill> = {}): Skill => ({
  id: name.toLowerCase(),
  name,
  description: `How to ${name.toLowerCase()}.`,
  collectionId: 'collection',
  editable: true,
  source: { kind: 'mine' },
  updated: daysAgo(1),
  autoUse: true,
  files: [],
  ...rest,
})

const SKILLS = [
  skill('Review', { tag: 'Engineering', updated: daysAgo(3) }),
  skill('Report', { tag: 'Reports', source: { kind: 'shared', by: 'Grace Hopper' }, updated: daysAgo(2) }),
  skill('Travel', { updated: daysAgo(1) }),
  skill('Incident', { tag: 'Engineering', source: { kind: 'organization' }, updated: daysAgo(1.5) }),
]
const spec = skillList(SKILLS)
const names = (skills: Skill[]) => skills.map(({ name }) => name)
const left = (query: string, ...ids: string[]) =>
  names(narrowList(SKILLS, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }))

describe('skillList', () => {
  it('lists each tag once, by name', () => {
    expect(skillTags(SKILLS)).toEqual(['Engineering', 'Reports'])
  })

  it('groups by tag, each a group of its own however few it has, the latest updated first, and those with none last', () => {
    const byTag = spec.orders.find(({ id }) => id === 'tag')!
    expect(byTag.arrange(SKILLS, 4).map(({ label, entries }) => [label, names(entries.map(({ value }) => value))])).toEqual([
      ['Engineering', ['Incident', 'Review']],
      ['Reports', ['Report']],
      ['My skills', ['Travel']],
    ])
  })

  it('starts with the latest updated first', () => {
    expect(names(spec.orders[0].arrange(SKILLS, 1).flatMap(({ entries }) => entries.map(({ value }) => value)))).toEqual(['Travel', 'Incident', 'Report', 'Review'])
  })

  it('has a filter for each tag, in a menu of their own, once there is more than one', () => {
    expect(spec.filters!.filter(({ facet }) => facet === 'tag').map(({ label }) => label)).toEqual(['Engineering', 'Reports'])
    expect(spec.facetMenus).toEqual({ tag: 'Collection' })
    expect(skillList([SKILLS[0], SKILLS[2]]).filters!.filter(({ facet }) => facet === 'tag')).toEqual([])
  })

  it('narrows to whose they are and to a tag, either of two tags passing', () => {
    expect(left('', 'mine')).toEqual(['Review', 'Travel'])
    expect(left('', 'shared', 'organization')).toEqual(['Report', 'Incident'])
    expect(left('', 'mine', 'tag:Engineering')).toEqual(['Review'])
    expect(left('', 'tag:Engineering', 'tag:Reports')).toEqual(['Review', 'Report', 'Incident'])
  })

  it('leaves the organization’s out to start with, until they are asked for', () => {
    expect(left('', ...spec.startsNarrowedTo!)).toEqual(['Review', 'Report', 'Travel'])
  })

  it('finds a skill by its name, what it is for, its tag, and who shared it', () => {
    expect(left('travel')).toEqual(['Travel'])
    expect(left('how to report')).toEqual(['Report'])
    expect(left('engineering')).toEqual(['Review', 'Incident'])
    expect(left('grace')).toEqual(['Report'])
    expect(left('organization')).toEqual(['Incident'])
  })

  it('says whose a skill is: the user, whoever shared it, or the organization', () => {
    expect(skillOwner(SKILLS[0], 'Ada Lovelace')).toEqual({ kind: 'person', name: 'Ada Lovelace', you: true })
    expect(skillOwner(SKILLS[1], 'Ada Lovelace')).toEqual({ kind: 'person', name: 'Grace Hopper' })
    expect(skillOwner(SKILLS[3], 'Ada Lovelace')).toEqual({ kind: 'organization' })
  })
})
