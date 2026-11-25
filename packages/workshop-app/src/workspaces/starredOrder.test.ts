import { describe, expect, it } from 'vitest'
import { orderStarred } from './starredOrder'

const ids = (workspaces: Array<{ id: string }>) => workspaces.map(({ id }) => id)

describe('orderStarred', () => {
  it('keeps the order they were put in, passing over ids that are not starred', () => {
    expect(ids(orderStarred([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['c', 'gone', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('puts one with no place first, in the order it was given', () => {
    expect(ids(orderStarred([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], ['c', 'a']))).toEqual(['b', 'd', 'c', 'a'])
  })

  it('with no order kept yet, keeps the order it was given', () => {
    expect(ids(orderStarred([{ id: 'a' }, { id: 'b' }], []))).toEqual(['a', 'b'])
  })
})
