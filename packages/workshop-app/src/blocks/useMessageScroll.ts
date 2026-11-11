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

  // Ends a move to a row that is still under way.
  const abandon = useRef<() => void>(undefined)

  /**
   * Brings a row into view, in the middle of what can be seen if it fits, and points it out.
   *
   * The way there is measured afresh every frame rather than set off once: the conversation
   * changes under a move (reaching its start fetches earlier history, pages mount and are
   * measured), and each such change is reconciled by setting the scroll position, which stops a
   * scroll the browser was animating wherever it had got to.
   */
  const scrollToRow = useCallback((id: string, page: number) => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return
    // Following the end of the conversation would pull the view straight back.
    stopScroll()
    abandon.current?.()
    const still = animation === 'instant'
    const find = () => content.querySelector<HTMLElement>(`[data-message-anchor="${CSS.escape(id)}"]`)
    /** How far the view has to move for an element to be in its place. */
    const distanceTo = (element: HTMLElement) => {
      const style = getComputedStyle(scroll)
      const view = scroll.getBoundingClientRect()
      const target = element.getBoundingClientRect()
      // The header floats over the top of the scroller and the composer over its bottom.
      const top = view.top + (Number.parseFloat(style.getPropertyValue('--header-height')) || 0)
      const bottom = view.bottom - (Number.parseFloat(style.getPropertyValue('--composer-half')) || 0)
      return target.top - top - Math.max(12, (bottom - top - target.height) / 2)
    }
    const moveBy = (distance: number) => {
      state.scrollTop += distance
      // Where the reader now is. The scroll event that would record it comes a frame later, and
      // a page that mounts before then would be reconciled against where they were.
      capture()
    }
    // The row is marked for a while, and what is in it shows that its own way (a message's
    // bubble darkens, see MessageBubble.css). Marked afresh, it shows it again from the start.
    const pointOut = (row: HTMLElement, delay: number) => setTimeout(() => {
      row.removeAttribute('data-pointed-out')
      void row.offsetWidth
      row.setAttribute('data-pointed-out', '')
      void Promise.allSettled(row.getAnimations({ subtree: true }).map(({ finished }) => finished))
        .then(() => row.removeAttribute('data-pointed-out'))
    }, delay)
    // Whether the way to somewhere runs over a page that is only a spacer while off screen.
    const crossesSpacer = (distance: number) => {
      const view = scroll.getBoundingClientRect()
      const from = Math.min(view.top, view.top + distance)
      const to = Math.max(view.bottom, view.bottom + distance)
      return [...content.querySelectorAll('[data-message-page][aria-hidden="true"]')].some((spacer) => {
        const { top, bottom } = spacer.getBoundingClientRect()
        return bottom > from && top < to
      })
    }

    const row = find()
    const total = row ? distanceTo(row) : 0
    let frame = 0

    if (row && (still || !crossesSpacer(total))) {
      if (still) moveBy(total)
      else {
        // Scrolled there over what is on the page, easing in and out, for longer the further it
        // is. The reader taking over ends it.
        const duration = Math.min(600, 250 + Math.abs(total) / 8)
        const started = performance.now()
        const takeovers = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
        const end = () => {
          cancelAnimationFrame(frame)
          for (const type of takeovers) scroll.removeEventListener(type, end)
          abandon.current = undefined
        }
        const step = (now: number) => {
          if (!content.contains(row)) return end()
          const progress = Math.min(1, (now - started) / duration)
          const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
          moveBy(distanceTo(row) - total * (1 - eased))
          if (progress < 1) frame = requestAnimationFrame(step)
          else end()
        }
        for (const type of takeovers) scroll.addEventListener(type, end, { passive: true })
        abandon.current = end
        frame = requestAnimationFrame(step)
      }
      pointOut(row, still ? 0 : 250)
      return
    }

    // There is nothing on the way to scroll over: the row's page, or one before it, is only a
    // spacer. So the conversation fades out, is put where the row is, and fades back in there.
    // Going to a spacer brings its rows back a frame or two later, and mounting moves things,
    // so the view is put right until the row has stayed in its place.
    const spacer = content.querySelector<HTMLElement>(`[data-message-page="${page}"]`)
    if (!row && !spacer) return
    const out = still ? undefined : content.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-out', fill: 'forwards' })
    let abandoned = false
    abandon.current = () => {
      abandoned = true
      cancelAnimationFrame(frame)
      out?.cancel()
      abandon.current = undefined
    }
    let frames = 40
    let settled = 0
    const arrive = () => {
      if (abandoned) return
      const mounted = find()
      const target = mounted ?? spacer
      const distance = target && content.contains(target) ? distanceTo(target) : 0
      if (Math.abs(distance) >= 1) {
        moveBy(distance)
        settled = 0
      } else if (mounted) settled++
      if (settled < 2 && frames-- > 0) return void (frame = requestAnimationFrame(arrive))
      abandon.current = undefined
      if (out) {
        out.cancel()
        content.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
      }
      if (mounted) pointOut(mounted, out ? 200 : 0)
    }
    if (out) void out.finished.then(arrive, () => {})
    else arrive()
  }, [scrollRef, contentRef, state, stopScroll, animation, capture])

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

  return { scrollRef, contentRef, atBottom: isAtBottom, scrollToBottom: jumpToLatest, scrollToRow, reconcile }
}
