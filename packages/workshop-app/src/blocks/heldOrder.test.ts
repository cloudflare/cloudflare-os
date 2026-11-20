import { describe, expect, it } from 'vitest'
import { heldOrder } from './heldOrder'

describe('heldOrder', () => {
  it('keeps what was shown where it was, however the list is ordered now', () => {
    expect(heldOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c'])
  })

  it('leaves out what has gone and puts what is new after the rest', () => {
    expect(heldOrder(['a', 'b', 'c'], ['d', 'c', 'a', 'e'])).toEqual(['a', 'c', 'd', 'e'])
  })
})
