import { useEffect, type RefObject } from 'react'

const clamp = (value: number) => Math.min(Math.max(value, 0), 1)

/**
 * Sets `--chat-fade-top` and `--chat-fade-bottom` (see `.chat-fade` in styles.css) from a
 * scroller's position, for browsers that cannot drive them with a scroll-driven animation. Where
 * they can, this does nothing and the animation owns both.
 */
export const useScrollFadeFallback = (scroller: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const element = scroller.current
    if (!element || CSS.supports('animation-timeline: scroll()')) return
    // The same 3rem the animation ranges use.
    const range = 3 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)

    const update = () => {
      const max = element.scrollHeight - element.clientHeight
      const fromFirst = element.scrollTop
      const fromNewest = max - element.scrollTop
      element.style.setProperty('--chat-fade-top', String(max > 0 ? clamp(fromFirst / range) : 0))
      element.style.setProperty('--chat-fade-bottom', String(max > 0 ? clamp(fromNewest / range) : 0))
    }

    update()
    element.addEventListener('scroll', update, { passive: true })
    // The messages growing changes how far there is to scroll without a scroll event.
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
      element.style.removeProperty('--chat-fade-top')
      element.style.removeProperty('--chat-fade-bottom')
    }
  }, [scroller])
}
