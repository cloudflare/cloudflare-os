import { describe, expect, it } from 'vitest'
import { spaceRing } from './ringSpacing'

const shares = (spacing: Map<string, number>) => Object.fromEntries([...spacing].map(([key, share]) => [key, Number(share.toFixed(4))]))

describe('spaceRing', () => {
  it('spaces those on a new ring evenly, in their order', () => {
    expect(shares(spaceRing(new Map(), ['a', 'b', 'c', 'd']))).toEqual({ a: 0, b: 0.25, c: 0.5, d: 0.75 })
  })

  it('closes the gap one leaves with those either side of it moving towards it as much as each other', () => {
    const was = spaceRing(new Map(), ['a', 'b', 'c', 'd'])
    expect(shares(spaceRing(was, ['a', 'c', 'd']))).toEqual({ a: 0.0833, c: 0.4167, d: 0.75 })
  })

  it('makes room for one coming in after the rest, those on the ring moving as little as they can', () => {
    const was = spaceRing(new Map(), ['a', 'b', 'c'])
    expect(shares(spaceRing(was, ['a', 'b', 'c', 'd']))).toEqual({ a: 0.0833, b: 0.3333, c: 0.5833, d: 0.8333 })
  })

  it('keeps the order round the ring however the keys are ordered now', () => {
    const was = new Map([['a', 0.9], ['b', 1.4]])
    expect(shares(spaceRing(was, ['b', 'a']))).toEqual({ a: 0.9, b: 1.4 })
  })

  it('starts afresh once the ring has emptied', () => {
    const emptied = spaceRing(spaceRing(new Map(), ['a', 'b']), [])
    expect(emptied.size).toBe(0)
    expect(shares(spaceRing(emptied, ['c', 'd']))).toEqual({ c: 0, d: 0.5 })
  })
})
