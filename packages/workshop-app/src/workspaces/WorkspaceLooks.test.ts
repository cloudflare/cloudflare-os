import { describe, expect, it } from 'vitest'
import { parseLooks, WorkspaceLooks, type WorkspaceLooksById } from './WorkspaceLooks'

/** A place to keep looks that is only this test's, starting with `looks`. */
const storage = (looks: WorkspaceLooksById = {}) => {
  const held = { looks }
  return { held, read: () => held.looks, write: (next: WorkspaceLooksById) => { held.looks = next } }
}

describe('parseLooks', () => {
  it('keeps the shapes and colours there are', () => {
    expect(parseLooks({ a: { shape: 'house', color: 'teal' }, b: { shape: 'stack' } })).toEqual({ a: { shape: 'house', color: 'teal' }, b: { shape: 'stack' } })
  })

  it('leaves out a shape or a colour there is not, keeping the other', () => {
    expect(parseLooks({ a: { shape: 'toString', color: 'blue' }, b: { shape: 'cloud', color: 7 } })).toEqual({ a: { color: 'blue' }, b: { shape: 'cloud' } })
  })

  it('leaves out what is not a look, and takes nothing from what is not a record', () => {
    expect(parseLooks({ a: 'house', b: null, c: { shape: 'window' } })).toEqual({ c: { shape: 'window' } })
    expect(parseLooks(['house'])).toBeUndefined()
    expect(parseLooks('house')).toBeUndefined()
  })
})

describe('WorkspaceLooks', () => {
  it('starts with what was kept', () => {
    expect(new WorkspaceLooks(storage({ a: { shape: 'cloud' } })).snapshot()).toEqual({ a: { shape: 'cloud' } })
  })

  it('keeps a look that is set, and tells whoever is listening', () => {
    const kept = storage({ a: { shape: 'cloud' } })
    const looks = new WorkspaceLooks(kept)
    const before = looks.snapshot()
    let told = 0
    const stop = looks.subscribe(() => told++)

    looks.set('b', { shape: 'house', color: 'red' })
    expect(looks.snapshot()).toEqual({ a: { shape: 'cloud' }, b: { shape: 'house', color: 'red' } })
    expect(looks.snapshot()).not.toBe(before)
    expect(kept.held.looks).toEqual(looks.snapshot())
    expect(told).toBe(1)

    stop()
    looks.set('b', { shape: 'folder' })
    expect(told).toBe(1)
  })

  it('does not lose what another tab has kept since', () => {
    const kept = storage()
    const looks = new WorkspaceLooks(kept)
    kept.held.looks = { other: { color: 'pink' } }

    looks.set('a', { shape: 'stack' })
    expect(kept.held.looks).toEqual({ other: { color: 'pink' }, a: { shape: 'stack' } })
  })
})
