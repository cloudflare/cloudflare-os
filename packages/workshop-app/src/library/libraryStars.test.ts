import { describe, expect, it } from 'vitest'
import { byStarOrder, withStarOrder } from './libraryStars'

const keyed = (...keys: string[]) => keys.map((key) => ({ key }))

describe('byStarOrder', () => {
  it('puts those starred since first, as given, then the rest in the order kept', () => {
    expect(byStarOrder(keyed('new', 'a', 'b', 'newer'), ['b', 'gone', 'a'])).toEqual(keyed('new', 'newer', 'b', 'a'))
  })
})

describe('withStarOrder', () => {
  it('keeps the stars of entries that are not listed, after those put in order', () => {
    expect(withStarOrder(['a', 'unread', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'unread'])
  })
})
