import { describe, expect, it } from 'vitest'
import { logoTone } from './logoTone'

// Pixels of one colour each, as a canvas gives them: RGBA, a byte each.
const pixels = (...colours: [number, number, number, number][]) => colours.flat()

describe('logoTone', () => {
  it('is dark for a logo drawn all in a near-black, which a dark surface would lose', () => {
    expect(logoTone(pixels([0x24, 0x29, 0x2e, 255], [0, 0, 0, 255], [0, 0, 0, 0]))).toBe('dark')
  })

  it('is light for one drawn all in white, which a light surface would lose', () => {
    expect(logoTone(pixels([255, 255, 255, 255], [240, 240, 245, 200]))).toBe('light')
  })

  it('is neither for one with colour, or with dark and light of its own', () => {
    expect(logoTone(pixels([0x5e, 0x6a, 0xd2, 255]))).toBeUndefined()
    expect(logoTone(pixels([0, 0, 0, 255], [255, 255, 255, 255]))).toBeUndefined()
  })

  it('goes by what is drawn, not by the smoothing at its edges or the room around it', () => {
    // A white fringe too faint to be seen does not make a black mark a mixed one.
    expect(logoTone(pixels([0, 0, 0, 255], [255, 255, 255, 40]))).toBe('dark')
    expect(logoTone(pixels([0, 0, 0, 0], [255, 255, 255, 0]))).toBeUndefined()
    expect(logoTone([])).toBeUndefined()
  })
})
