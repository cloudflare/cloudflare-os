import { describe, expect, it } from 'vitest'
import type {
  BlueprintLibrarySummary,
  BlueprintPublicInfo,
  BlueprintUserSummary,
} from '@gadgets/workshop-shared/api'
import { groupBlueprintChoices } from './blueprintChoices'

const published = (id: string, title: string, version = 1): BlueprintPublicInfo => ({
  id,
  metadata: {
    title,
    description: `${title} description`,
    author: { type: 'user', id: 'alice@example.com', name: 'Alice' },
    created: new Date(0),
    version,
    lastUpdated: new Date(0),
    bindings: {},
  },
})

const owned = (id: string, title: string): BlueprintUserSummary => ({
  id,
  title,
  description: '',
  source: { type: 'imported' },
  version: 1,
  lastUpdated: new Date(0),
})

const saved = (id: string, title: string): BlueprintLibrarySummary => ({
  ...published(id, title),
  addedAt: new Date(0),
  uploaded: false,
})

const NOTHING = { followed: null, linked: null, own: [], library: [], featured: [] }

const idsBySource = (groups: ReturnType<typeof groupBlueprintChoices>) =>
  groups.map(group => [group.source, group.choices.map(choice => choice.id)])

describe('groupBlueprintChoices', () => {
  it('lists the followed blueprint first, then a pasted link, the user\'s own, and featured', () => {
    const groups = groupBlueprintChoices({
      followed: published('followed', 'Followed', 4),
      linked: published('linked', 'Linked'),
      own: [owned('own', 'Mine')],
      library: [saved('saved', 'Saved')],
      featured: [published('featured', 'Featured')],
    })

    expect(idsBySource(groups)).toEqual([
      ['followed', ['followed']],
      ['linked', ['linked']],
      ['yours', ['own', 'saved']],
      ['featured', ['featured']],
    ])
    expect(groups[0].choices[0]).toEqual({
      id: 'followed', title: 'Followed', description: 'Followed description', version: 4,
    })
  })

  // Otherwise the preselected row would have a twin that reads as a different blueprint.
  it('lists a blueprint known from several sources once, under the first', () => {
    const groups = groupBlueprintChoices({
      followed: published('a', 'A'),
      linked: published('a', 'A'),
      own: [owned('a', 'A'), owned('b', 'B')],
      library: [saved('b', 'B')],
      featured: [published('b', 'B'), published('c', 'C')],
    })

    expect(idsBySource(groups)).toEqual([
      ['followed', ['a']],
      ['yours', ['b']],
      ['featured', ['c']],
    ])
  })

  it('orders the user\'s own and saved blueprints together, by title', () => {
    const groups = groupBlueprintChoices({
      ...NOTHING,
      own: [owned('z', 'Zebra')],
      library: [saved('m', 'Mango'), saved('a', 'Apple')],
    })

    expect(idsBySource(groups)).toEqual([['yours', ['a', 'm', 'z']]])
  })

  it('offers nothing when there is nothing to offer', () => {
    expect(groupBlueprintChoices(NOTHING)).toEqual([])
  })

  it('names a blueprint that has no title', () => {
    const [group] = groupBlueprintChoices({ ...NOTHING, own: [owned('a', '')] })
    expect(group.choices[0].title).toBe('Untitled blueprint')
  })
})
