import { useEffect, useState } from 'react'

/**
 * Whether the pointer is within `within` pixels of the window's top, while `enabled`. A frame keeps
 * its pointer from the window, so where the pointer is over one is told with `report`, at its height
 * in the window: whichever heard of it last says where it is. Leaving the window is being far from
 * it. `report` is stable.
 */
export const usePointerNearTop = (enabled: boolean, within: number) => {
  const [near, setNear] = useState(false)
  const [report] = useState(() => (y: number) => setNear(y < within))
  // Where it was before is not where it is: it is heard of again once it moves.
  const [was, setWas] = useState(enabled)
  if (was !== enabled) {
    setWas(enabled)
    setNear(false)
  }
  useEffect(() => {
    if (!enabled) return
    const moved = (event: PointerEvent) => report(event.clientY)
    const left = () => setNear(false)
    window.addEventListener('pointermove', moved, { passive: true })
    document.documentElement.addEventListener('pointerleave', left)
    return () => {
      window.removeEventListener('pointermove', moved)
      document.documentElement.removeEventListener('pointerleave', left)
    }
  }, [enabled, report])
  return { near: enabled && near, report }
}
