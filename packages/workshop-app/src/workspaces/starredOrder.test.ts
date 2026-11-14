import { describe, expect, it } from 'vitest'
import { orderStarred } from './starredOrder'

const ids = (workspaces: Array<{ id: string }>) => workspaces.map(({ id }) => id)
const of = (...list: string[]) => list.map((id) => ({ id }))

describe('orderStarred', () => {
  it('keeps the order they were put in', () => {
    expect(ids(orderStarred(of('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('puts one starred elsewhere first, as the latest starred, in the order it was given', () => {
    expect(ids(orderStarred(of('a', 'b', 'c', 'd'), ['c', 'a']))).toEqual(['b', 'd', 'c', 'a'])
  })

  it('leaves out what is no longer starred', () => {
    expect(ids(orderStarred(of('a', 'c'), ['c', 'b', 'a']))).toEqual(['c', 'a'])
  })

  it('with no order kept yet, keeps the order it was given', () => {
    expect(ids(orderStarred(of('a', 'b'), []))).toEqual(['a', 'b'])
  })
})
