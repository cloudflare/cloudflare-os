import type { ReactNode } from 'react'

export type ScrollRowProps = {
  /** What is on it, for a reader: "Most used templates". */
  'aria-label': string
  /** Each as wide as it says itself. */
  children: ReactNode
}

/**
 * Several things on one line, however short the line: those there is no room for are scrolled to
 * along it, each coming to rest at the line's start.
 */
export const ScrollRow = ({ 'aria-label': label, children }: ScrollRowProps) => (
  // Room under them for the scrollbar, where the system draws one all along.
  <div role="group" aria-label={label} className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-2 *:shrink-0 *:snap-start">
    {children}
  </div>
)
