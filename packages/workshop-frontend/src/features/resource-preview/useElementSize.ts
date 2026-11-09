import { useLayoutEffect, useRef, useState } from 'react'

type Size = { width: number; height: number }

/**
 * The size inside the borders of the element given `ref`, padding included, kept current as it
 * resizes. Measured before the first paint, so what is sized to it never shows at a guess first.
 */
export const useElementSize = <T extends HTMLElement>() => {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}
