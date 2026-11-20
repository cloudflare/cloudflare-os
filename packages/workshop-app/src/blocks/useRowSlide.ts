import { useLayoutEffect, useRef, type RefObject } from 'react'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { motionTransition } from '@/hooks/motionTransition'
import { isMotionOff } from '@/prefs/motion'

const SLIDE = { type: 'spring', duration: 0.45, bounce: 0.1 } as const
const ARRIVE = { duration: 0.25, ease: 'easeOut' } as const

/** How far a slide has an element moved from where it is laid out, now. */
export const slidBy = (element: Element) => {
  const { transform } = getComputedStyle(element)
  return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
}

/**
 * Slides a list's rows (its children that match `rowSelector`) from where they were to where they
 * are now laid out, whenever that changes, as when the list is put in another order, and fades in
 * the ones that are new. The surfaces drawn under the rows (`surfaces`, as `useWorkspaceUnderlay`'s)
 * slide with the row they are on. Call it after `useWorkspaceUnderlay`, whose surfaces it moves
 * once they are placed.
 */
export const useRowSlide = (listRef: RefObject<HTMLElement | null>, rowSelector: string, surfaces: readonly RefObject<HTMLElement | null>[]) => {
  // Where each row was laid out, from the list's top, when last seen.
  const tops = useRef(new WeakMap<Element, number>())
  const slides = useRef(new WeakMap<Element, AnimationPlaybackControls>())
  const seen = useRef(false)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const listTop = list.getBoundingClientRect().top
    const rows = Array.from(list.querySelectorAll<HTMLElement>(`:scope > ${rowSelector}`))
    const motion = seen.current && !isMotionOff()
    seen.current = true
    // How far each row that moved has to come, by where its top is laid out now.
    const moved = new Map<number, number>()

    const slide = (element: HTMLElement, from: number) => {
      slides.current.get(element)?.stop()
      slides.current.set(element, animate(element, { y: [from, 0] }, motionTransition(SLIDE)))
    }

    for (const row of rows) {
      const by = slidBy(row)
      const top = row.getBoundingClientRect().top - listTop - by
      const was = tops.current.get(row)
      tops.current.set(row, top)
      if (!motion) continue
      if (was === undefined) {
        animate(row, { opacity: [0, 1] }, motionTransition(ARRIVE))
        continue
      }
      // Where it was seen, as far along as a slide had it, to where it is now.
      const from = was + by - top
      if (was === top || Math.abs(from) < 0.5) continue
      moved.set(Math.round(top), from)
      slide(row, from)
    }

    if (moved.size === 0) return
    for (const ref of surfaces) {
      const surface = ref.current
      if (!surface || Number.parseFloat(surface.style.height) === 0) continue
      const from = moved.get(Math.round(Number.parseFloat(surface.style.top)))
      if (from !== undefined) slide(surface, from)
    }
  })
}
