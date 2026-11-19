import { describe, expect, it } from 'vitest'
import { resolveTransition } from './motionTransition'

describe('resolveTransition', () => {
  const bouncy = { type: 'spring', duration: 0.3, bounce: 0.1 } as const

  it('leaves a transition as written at full', () => {
    expect(resolveTransition(bouncy, 'full')).toBe(bouncy)
  })

  it('takes the bounce out of a spring at calm, over the same time', () => {
    expect(resolveTransition(bouncy, 'calm')).toEqual({ type: 'spring', duration: 0.3, bounce: 0 })
  })

  it('has a spring with no bounce given settle without one at calm, as motion would bounce it by default', () => {
    expect(resolveTransition({ type: 'spring', duration: 0.3 }, 'calm')).toEqual({ type: 'spring', duration: 0.3, bounce: 0 })
  })

  it('critically damps a spring given by its forces at calm', () => {
    const resolved = resolveTransition({ type: 'spring', mass: 0.7, stiffness: 500, damping: 18 }, 'calm')
    expect(resolved).toMatchObject({ stiffness: 500, mass: 0.7 })
    expect((resolved as { damping: number }).damping).toBeCloseTo(2 * Math.sqrt(500 * 0.7))
  })

  it('does not touch what is not a spring at calm', () => {
    const tween = { duration: 0.18, ease: 'easeOut' } as const
    expect(resolveTransition(tween, 'calm')).toBe(tween)
  })

  it('takes no time at off, delay included', () => {
    expect(resolveTransition({ ...bouncy, delay: 0.2 }, 'off')).toEqual({ duration: 0 })
  })
})
