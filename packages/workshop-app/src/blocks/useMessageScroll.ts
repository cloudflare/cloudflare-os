import { useCallback, useLayoutEffect, useRef } from 'react'
import { useReducedMotion } from 'motion/react'
import { useStickToBottom } from 'use-stick-to-bottom'

type Anchor = { element: HTMLElement; offset: number }

/** The library owns following/escaping. Our page virtualization only corrects reading anchors
 * while following is paused, through the library's programmatic-scroll setter. */
export const useMessageScroll = () => {
  const reducedMotion = useReducedMotion()
  const animation = reducedMotion ? 'instant' : 'smooth'
  const { scrollRef, contentRef, state, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    initial: 'instant',
    resize: animation,
  })
  const anchors = useRef<Anchor[]>([])

  const capture = useCallback(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return
    const top = scroll.getBoundingClientRect().top
    // The floating header obscures the first strip of the scroller. Anchor the message the reader
    // can actually see, rather than a sliver of the previous row hidden behind that header.
    const visibleTop = top + (Number.parseFloat(getComputedStyle(scroll).getPropertyValue('--header-height')) || 0)
    const visible = (selector: string) => [...content.querySelectorAll<HTMLElement>(selector)]
      .find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > visibleTop && rect.top < top + scroll.clientHeight
      })
    // The page survives unmounting its rows. It is also the fallback when an updated message is
    // removed or when a fast scrollbar drag lands on a spacer that has not mounted its rows yet.
    anchors.current = [visible('[data-message-anchor]'), visible('[data-message-page]')]
      .filter((element): element is HTMLElement => !!element)
      .map((element) => ({ element, offset: element.getBoundingClientRect().top - top }))
  }, [scrollRef, contentRef])

  const reconcile = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    // `isAtBottom` also includes the library's near-bottom tolerance; state.isAtBottom is the
    // actual follow lock. Never anchor-correct while its scrolling animation owns the viewport.
    if (!state.isAtBottom) {
      const anchor = anchors.current.find(({ element }) => contentRef.current?.contains(element))
      if (anchor) {
        const delta = anchor.element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset
        // This setter marks the correction as programmatic, so the library doesn't mistake a
        // prepend or remeasurement for user input and change its follow/escape state.
        if (Math.abs(delta) > 0.5) state.scrollTop += delta
      }
    }
    capture()
  }, [scrollRef, contentRef, state, capture])

  const jumpToLatest = useCallback(() => {
    void scrollToBottom({ animation })
  }, [scrollToBottom, animation])

  useLayoutEffect(() => {
    const scroll = scrollRef.current!
    const content = contentRef.current!
    // Its initial ResizeObserver scroll runs on an animation frame. Place already-loaded history
    // before the first paint, using the same setter so the initial move doesn't release the lock.
    state.scrollTop = state.targetScrollTop
    capture()
    scroll.addEventListener('scroll', capture, { passive: true })
    // Keyboard scrolling animates natively. Release through the library before its next streaming
    // frame can cancel that animation; wheel escape is already handled by the library itself.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const upwardKey = ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
      const upwardSpace = event.key === ' ' && event.shiftKey && !target?.closest('button, [role="button"]')
      if (upwardKey || upwardSpace) stopScroll()
    }
    scroll.addEventListener('keydown', onKeyDown)
    const observer = new ResizeObserver((entries) => {
      reconcile()
      // The library observes content growth. A taller composer/shorter viewport can move the
      // bottom without resizing that content, so request the same follow behavior in that case.
      if (state.isAtBottom && entries.some(({ target }) => target === scroll)) {
        void scrollToBottom({ animation: 'instant', preserveScrollPosition: true, wait: true })
      }
    })
    observer.observe(scroll)
    observer.observe(content)
    return () => {
      observer.disconnect()
      scroll.removeEventListener('scroll', capture)
      scroll.removeEventListener('keydown', onKeyDown)
    }
  }, [scrollRef, contentRef, state, scrollToBottom, stopScroll, capture, reconcile])

  // Preserve React-driven replacements before paint; observers cover subsequent layout changes.
  useLayoutEffect(reconcile)

  return { scrollRef, contentRef, atBottom: isAtBottom, scrollToBottom: jumpToLatest, reconcile }
}
