import { useEffect, useState } from 'react'

const HINT_DURATION_MS = 4000

/**
 * The brief "Press Esc to exit full screen" banner over a full-screen gadget, shown for a few
 * seconds after it mounts. Not a Kumo toast: the full-screen overlay sits above the toast layer,
 * and toasts render bottom-right rather than top-center.
 */
export const FullscreenExitHint = () => {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), HINT_DURATION_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 transform"
    >
      <div className="rounded-full border border-kumo-line bg-kumo-base/90 px-4 py-1.5 text-[13px] leading-[18px] text-kumo-default shadow-md backdrop-blur-sm">
        Press <kbd className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 text-[11px] font-medium">Esc</kbd> to exit full screen
      </div>
    </div>
  )
}
