import { describe, expect, it } from 'vitest'
import { withStar, withStarOrder } from './libraryStars'

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
