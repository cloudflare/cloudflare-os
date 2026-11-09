import { useLayoutEffect, useRef, type ReactNode } from 'react'

/**
 * Eases its content's changes of height, as when a request card, once answered, folds into the
 * line that records it, or a receipt opens to its details. Measured after layout and before
 * paint, so the first frame already starts from the old height.
 */
export function SmoothHeight({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = outer.current
    const content = inner.current
    if (!box || !content || typeof ResizeObserver === 'undefined') return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let last = content.offsetHeight
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight
      const from = last
      last = next
      if (reduced || from === next || from === 0) return
      box.animate([{ height: `${from}px` }, { height: `${next}px` }], {
        duration: 320,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
      })
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  return (
    // Clipped only beyond the card's shadow, so the content may spill no further than that.
    <div ref={outer} style={{ overflow: 'clip', overflowClipMargin: '12px' }}>
      <div ref={inner}>{children}</div>
    </div>
  )
}
