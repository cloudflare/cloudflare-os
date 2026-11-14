import { describe, expect, it } from 'vitest'
import type { BlueprintMetadata, BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { blueprintDetail, blueprintEntries, blueprintGroups } from './blueprintEntries'

const metadata = (title: string, lastUpdated: string, extra: Partial<BlueprintMetadata> = {}): BlueprintMetadata => ({
  title,
  description: `${title}, described`,
  author: { type: 'user', id: 'ada', name: 'Ada' },
  created: new Date('2026-01-01'),
  version: 1,
  lastUpdated: new Date(lastUpdated),
  bindings: {},
  ...extra,
})

const info = (id: string, title: string, lastUpdated: string): BlueprintPublicInfo => ({ id, metadata: metadata(title, lastUpdated), screenshotUrl: `/blueprint-screenshot/${id}` })

describe('blueprintEntries', () => {
  it('lists each blueprint once, however many ways the user has it', () => {
    const entries = blueprintEntries({
      featured: [info('a', 'Tip jar', '2026-03-01')],
      library: [{ id: 'a', metadata: metadata('Tip jar', '2026-03-01'), addedAt: new Date(), uploaded: false }],
      own: [
        { summary: { id: 'b', title: 'Standup', description: '', source: { type: 'deletedWorkspace' }, version: 1, lastUpdated: new Date('2026-02-01') }, info: null },
        // Added, not published: listed from the library, where it is.
        { summary: { id: 'z', title: 'Imported', description: '', source: { type: 'imported' }, version: 1, lastUpdated: new Date('2026-02-01') } },
      ],
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: 'a', featured: true, saved: { uploaded: false }, picture: '/blueprint-screenshot/a' })
    // Its public record could not be read: what the user's own summary says of it.
    expect(entries[1]).toMatchObject({ id: 'b', title: 'Standup', author: 'You', featured: false, published: { type: 'deletedWorkspace' } })
  })

  it('draws a saved one with its picture, from its metadata', () => {
    const [entry] = blueprintEntries({
      featured: [],
      library: [{ id: 'c', metadata: metadata('Planner', '2026-03-01', { screenshot: true }), addedAt: new Date(), uploaded: true }],
      own: [],
    })
    expect(entry.picture).toMatch(/^\/blueprint-screenshot\/c\?v=/)
  })
})

describe('blueprintGroups', () => {
  const entries = blueprintEntries({
    featured: [info('a', 'Tip jar', '2026-03-01'), info('b', 'Budget', '2026-04-01')],
    library: [
      { id: 'b', metadata: metadata('Budget', '2026-04-01'), addedAt: new Date(), uploaded: false },
      { id: 'c', metadata: metadata('Atlas', '2026-01-01'), addedAt: new Date(), uploaded: false },
    ],
    own: [],
  })

  it('puts the featured first, then the user’s own not among them, latest first', () => {
    expect(blueprintGroups(entries, { sort: 'recent', query: '' }).map(({ key, entries: listed }) => [key, listed.map(({ id }) => id)]))
      .toEqual([['featured', ['b', 'a']], ['yours', ['c']]])
  })

  it('orders by name, and finds by the words typed, leaving out a group with none', () => {
    expect(blueprintGroups(entries, { sort: 'name', query: '' })[0].entries.map(({ id }) => id)).toEqual(['b', 'a'])
    expect(blueprintGroups(entries, { sort: 'recent', query: 'atl desc' }).map(({ key }) => key)).toEqual(['yours'])
  })
})

describe('blueprintDetail', () => {
  it('says who made it and what it needs', () => {
    expect(blueprintDetail({ author: 'Ada', needs: 0 })).toBe('By Ada · Ready to use')
    expect(blueprintDetail({ author: 'Ada', needs: 2, published: { type: 'deletedWorkspace' } })).toBe('By you · Needs 2 things')
  })
})
