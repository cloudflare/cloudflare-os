import { describe, expect, it } from 'vitest'
import { narrowList } from '@/components/listView'
import { skillDetail, skillList, skillTags, type Skill } from './skillList'

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

const skill = (name: string, rest: Partial<Skill> = {}): Skill => ({
  id: name.toLowerCase(),
  name,
  description: `How to ${name.toLowerCase()}.`,
  source: { kind: 'mine' },
  updated: daysAgo(1),
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
      ['No tag', ['Travel']],
    ])
  })

  it('starts with the latest updated first', () => {
    expect(names(spec.orders[0].arrange(SKILLS, 1).flatMap(({ entries }) => entries.map(({ value }) => value)))).toEqual(['Travel', 'Incident', 'Report', 'Review'])
  })

  it('has a filter for each tag, in a menu of their own, once there is more than one', () => {
    expect(spec.filters!.filter(({ facet }) => facet === 'tag').map(({ label }) => label)).toEqual(['Engineering', 'Reports'])
    expect(spec.facetMenus).toEqual({ tag: 'Tag' })
    expect(skillList([SKILLS[0], SKILLS[2]]).filters!.filter(({ facet }) => facet === 'tag')).toEqual([])
  })

  it('narrows to whose they are and to a tag, either of two tags passing', () => {
    expect(left('', 'mine')).toEqual(['Review', 'Travel'])
    expect(left('', 'shared', 'organization')).toEqual(['Report', 'Incident'])
    expect(left('', 'mine', 'tag:Engineering')).toEqual(['Review'])
    expect(left('', 'tag:Engineering', 'tag:Reports')).toEqual(['Review', 'Report', 'Incident'])
  })

  it('finds a skill by its name, what it is for, its tag, and who shared it', () => {
    expect(left('travel')).toEqual(['Travel'])
    expect(left('how to report')).toEqual(['Report'])
    expect(left('engineering')).toEqual(['Review', 'Incident'])
    expect(left('grace')).toEqual(['Report'])
    expect(left('organization')).toEqual(['Incident'])
  })

  it('says whose a skill is before what it is for, where it is not the user’s own', () => {
    expect(skillDetail(SKILLS[0])).toBe('How to review.')
    expect(skillDetail(SKILLS[1])).toBe('Shared by Grace Hopper · How to report.')
    expect(skillDetail(SKILLS[3])).toBe('Organization · How to incident.')
  })
})
