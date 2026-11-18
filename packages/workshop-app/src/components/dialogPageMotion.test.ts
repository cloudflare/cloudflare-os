import { describe, expect, it } from 'vitest'
import { PAGE_SHIFT, pageMotion } from './dialogPageMotion'

const list = { width: 544, height: 600 }
const form = { width: 640, height: 340 }
const of = (animations: ReturnType<typeof pageMotion>, target: string) => animations.filter((each) => each.target === target)

describe('pageMotion', () => {
  it('takes the surface from one page’s size to the other’s', () => {
    const [surface] = of(pageMotion({ from: list, to: form, forward: true, reduced: false }), 'surface')
    expect(surface?.keyframes).toEqual([{ width: '544px', height: '600px' }, { width: '640px', height: '340px' }])
  })

  it('leaves the surface alone where the pages are one size', () => {
    expect(of(pageMotion({ from: list, to: list, forward: true, reduced: false }), 'surface')).toEqual([])
  })

  it('brings a deeper page in from the right and sends the other off to the left, and the reverse going back', () => {
    const forward = pageMotion({ from: list, to: form, forward: true, reduced: false })
    expect(of(forward, 'incoming')[0]?.keyframes[0]).toEqual({ left: `${PAGE_SHIFT}px` })
    expect(of(forward, 'outgoing')[0]?.keyframes[1]).toEqual({ marginLeft: `${-PAGE_SHIFT}px` })
    const back = pageMotion({ from: form, to: list, forward: false, reduced: false })
    expect(of(back, 'incoming')[0]?.keyframes[0]).toEqual({ left: `${-PAGE_SHIFT}px` })
    expect(of(back, 'outgoing')[0]?.keyframes[1]).toEqual({ marginLeft: `${PAGE_SHIFT}px` })
  })

  it('holds the leaving page at its end, as it is drawn until everything has finished', () => {
    for (const { options } of of(pageMotion({ from: list, to: form, forward: true, reduced: false }), 'outgoing')) expect(options.fill).toBe('forwards')
  })

  it('only fades the pages with reduced motion, over a surface already at its size', () => {
    const reduced = pageMotion({ from: list, to: form, forward: true, reduced: true })
    expect(of(reduced, 'surface')).toEqual([])
    expect(reduced.flatMap(({ keyframes }) => keyframes.flatMap(Object.keys))).toEqual(['opacity', 'opacity', 'opacity', 'opacity'])
  })
})
