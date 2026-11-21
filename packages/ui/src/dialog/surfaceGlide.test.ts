import { describe, expect, it } from 'vitest'
import { glideSettled, glideStep } from './surfaceGlide'

// Steps a glide a frame at a time, as `SurfaceGlide` does, with `target` as it is at each time (ms).
const run = (from: number, target: (ms: number) => number, frames: number) => {
  let state = { height: from, velocity: 0 }
  const heights: number[] = []
  for (let frame = 1; frame <= frames; frame++) {
    state = glideStep({ ...state, target: target(frame * 16), dt: 0.016 })
    heights.push(state.height)
  }
  return { heights, state }
}

describe('glideStep', () => {
  it('goes to its target without going past it, and is there in about 280 ms', () => {
    const { heights } = run(300, () => 500, 30)
    expect(heights.every((height, index) => height <= 500 && height >= (heights[index - 1] ?? 300))).toBe(true)
    expect(500 - heights[17]!).toBeLessThan(3)
    expect(heights[1]! - 300).toBeGreaterThan(0)
  })

  it('shrinks as it grows', () => {
    const { heights } = run(500, () => 300, 30)
    expect(heights.every((height) => height >= 300)).toBe(true)
    expect(heights[17]! - 300).toBeLessThan(3)
  })

  it('turns toward a new target from where it is, rather than starting again', () => {
    const { heights } = run(300, (ms) => (ms < 80 ? 500 : 420), 40)
    // No step back to where it began, and no stop: the change of target bends the curve.
    const steps = heights.map((height, index) => height - (heights[index - 1] ?? 300))
    expect(steps.slice(0, 6).every((step) => step > 0)).toBe(true)
    expect(Math.max(...heights)).toBeLessThan(500)
    expect(heights.at(-1)).toBeCloseTo(420, 0)
  })

  it('is settled only once it is there and still', () => {
    expect(glideSettled({ height: 499.8, velocity: 2, target: 500 })).toBe(true)
    expect(glideSettled({ height: 499.8, velocity: 300, target: 500 })).toBe(false)
    expect(glideSettled({ height: 490, velocity: 0, target: 500 })).toBe(false)
  })
})
