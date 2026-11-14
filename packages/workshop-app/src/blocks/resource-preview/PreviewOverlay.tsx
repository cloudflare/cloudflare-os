import type { ReactNode } from 'react'

/** Room a preview leaves at the end of what it scrolls, so its overlay never hides the last of it. */
export const OVERLAY_CLEARANCE = 156

/**
 * Floats `children` over the bottom of a preview's main area, letting the page take every other
 * click. It rests as high as the chat's composer beside it: the composer's padding plus the
 * token/cost row under it.
 */
export const PreviewOverlay = ({ children }: { children: ReactNode }) => (
  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-6 sm:pb-8">{children}</div>
)
