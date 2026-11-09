import type { ReactNode } from 'react'
import { CONTENT_CARD_CLASS, useBareShell } from './shellChrome'

/**
 * A page that can open a pane beside itself, as the design's Home and Library do for a file
 * (Figma "MacBook Pro 14\" - 9"). Without a pane the page sits in the shell's card; with one, the
 * page and the pane are two equal cards on the canvas, and on a phone the pane covers the page.
 * The page's own tree stays mounted either way, so opening a pane keeps its state.
 */
export function SplitPage({ children, pane, paneExpanded = false }: {
  children: ReactNode
  pane?: ReactNode
  /** The pane takes the whole width, as its Full screen button asks. */
  paneExpanded?: boolean
}) {
  const open = pane !== undefined && pane !== null && pane !== false
  useBareShell(open)
  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto ${open ? `${CONTENT_CARD_CLASS} max-md:hidden ${paneExpanded ? 'md:hidden' : ''}` : ''}`}>
        {children}
      </div>
      {open && (
        <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${CONTENT_CARD_CLASS}`}>
          {pane}
        </div>
      )}
    </div>
  )
}
