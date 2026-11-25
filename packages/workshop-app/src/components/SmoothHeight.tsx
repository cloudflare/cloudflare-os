import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { useReducedMotion } from '@gadgets/ui'

const TRANSITION = 'height 220ms cubic-bezier(0.25, 0.1, 0.25, 1)'

/**
 * Room for content that grows or shrinks as it is looked at, such as a reply streaming in: its height
 * eases to the content's, rather than jumping a line at a time. The first height is the content's,
 * with no easing, and with motion off there is none.
 */
export const SmoothHeight = ({ children, className }: { children: ReactNode; className?: string }) => {
  const room = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()

  useLayoutEffect(() => {
    const outer = room.current!
    const inner = content.current!
    const fit = (ease: boolean) => {
      outer.style.transition = ease && !reduced ? TRANSITION : 'none'
      outer.style.height = `${inner.getBoundingClientRect().height}px`
    }
    fit(false)
    const watch = new ResizeObserver(() => fit(true))
    watch.observe(inner)
    return () => watch.disconnect()
  }, [reduced])

  return (
    <div ref={room} className={cn('overflow-clip', className)}>
      <div ref={content}>{children}</div>
    </div>
  )
}
