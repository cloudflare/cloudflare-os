import { describe, expect, it } from 'vitest'
import { GadgetColors, parseGadgetColors, type GadgetColorsByKey } from './GadgetColors'

/** A place to keep colours that is only this test's, starting with `colors`. */
const storage = (colors: GadgetColorsByKey = {}) => {
  const held = { colors }
  return { held, read: () => held.colors, write: (next: GadgetColorsByKey) => { held.colors = next } }
}

describe('parseGadgetColors', () => {
  it('keeps the colours there are, and leaves out the rest', () => {
    expect(parseGadgetColors({ 'w/1': 'teal', 'w/2': 'toString', 'w/3': 7 })).toEqual({ 'w/1': 'teal' })
    expect(parseGadgetColors(['teal'])).toBeUndefined()
  })
})

describe('GadgetColors', () => {
  it('keeps a colour over what another tab kept meanwhile, and tells whoever listens', () => {
    const kept = storage({ 'w/1': 'red' })
    const colors = new GadgetColors(kept)
    kept.held.colors = { 'w/1': 'red', 'w/2': 'blue' }
    let told = 0
    colors.subscribe(() => told++)
    colors.set('w/3', 'green')
    expect(colors.snapshot()).toEqual({ 'w/1': 'red', 'w/2': 'blue', 'w/3': 'green' })
    expect(told).toBe(1)
  })

  it('keeps ink as no colour', () => {
    const colors = new GadgetColors(storage({ 'w/1': 'red' }))
    colors.set('w/1', 'contrast')
    expect(colors.snapshot()).toEqual({})
  })
})
