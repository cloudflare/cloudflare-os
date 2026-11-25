import { describe, expect, it, vi } from 'vitest'
import type { UserPreferencesSubscriber } from '@gadgets/workshop-shared/api'
import { encodePreferences, MAX_STARRED_OUTPUTS } from '@/prefs/preferenceFields'
import { UserPreferences, type PreferencesBackend } from '@/prefs/UserPreferences'
import { keepStars, withStar, withStarOrder } from './libraryStars'

describe('withStar', () => {
  it('puts one newly starred first, and takes one unstarred out, leaving the others where they were', () => {
    expect(withStar(['a', 'b'], 'c', true)).toEqual(['c', 'a', 'b'])
    expect(withStar(['a', 'b', 'c'], 'b', false)).toEqual(['a', 'c'])
  })
})

describe('withStarOrder', () => {
  it('keeps the stars of outputs that are not listed, after those put in order', () => {
    expect(withStarOrder(['a', 'unread', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'unread'])
  })
})

describe('keepStars', () => {
  it('keeps the stars as outputs, within the bound, dropping the last', async () => {
    let server: UserPreferencesSubscriber | undefined
    const subscribe = vi.fn<PreferencesBackend['subscribe']>(async (given) => {
      server = given as unknown as UserPreferencesSubscriber
      return { [Symbol.dispose]: () => {} }
    })
    const store = new UserPreferences()
    store.start({ subscribe, update: async () => {} })
    await server!.updated(encodePreferences({}))

    const stars = Array.from({ length: MAX_STARRED_OUTPUTS + 1 }, (_, index) => `w/${index}`)
    keepStars(store, stars)
    const kept = store.getSnapshot().starredOutputs
    expect(kept).toHaveLength(MAX_STARRED_OUTPUTS)
    expect(kept[0]).toEqual({ workspaceId: 'w', workpieceId: 0 })
    expect(kept.at(-1)).toEqual({ workspaceId: 'w', workpieceId: MAX_STARRED_OUTPUTS - 1 })
  })
})
