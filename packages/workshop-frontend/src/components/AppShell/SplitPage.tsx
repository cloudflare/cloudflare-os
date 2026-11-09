import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { CONTENT_CARD_CLASS, useBareShell } from './shellChrome'

// The canvas between the two cards, which is also the handle that resizes them (as the
// workspace's is).
const GUTTER = 12
const MIN_PAGE_WIDTH = 440
const MIN_PANE_WIDTH = 360
// How far an arrow key moves the gutter.
const KEY_STEP = 32
const PANE_WIDTH_STORAGE_KEY = 'split-page-pane-width'

const readPaneWidth = (): number | null => {
  try {
    const stored = Number(window.localStorage.getItem(PANE_WIDTH_STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}

const writePaneWidth = (width: number | null) => {
  try {
    if (width === null) window.localStorage.removeItem(PANE_WIDTH_STORAGE_KEY)
    else window.localStorage.setItem(PANE_WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // private mode / sandboxed iframes: the width just isn't remembered
  }
}

// The pane's width within a row `available` wide, leaving the page its minimum.
const clampPaneWidth = (width: number, available: number) =>
  Math.max(MIN_PANE_WIDTH, Math.min(available - GUTTER - MIN_PAGE_WIDTH, width))

/**
 * A page that can open a pane beside itself, as the design's Home and Library do for a file
 * (Figma "MacBook Pro 14\" - 9"). Without a pane the page sits in the shell's card; with one, the
 * page and the pane are two cards on the canvas, equal until the gutter between them is dragged
 * (the width is remembered, and a double-click on the gutter evens them again). On a phone the
 * pane covers the page. The page's own tree stays mounted either way, so opening a pane keeps
 * its state.
 */
export function SplitPage({ children, pane, paneExpanded = false }: {
  children: ReactNode
  pane?: ReactNode
  /** The pane takes the whole width, as its Full screen button asks. */
  paneExpanded?: boolean
}) {
  const open = pane !== undefined && pane !== null && pane !== false
  useBareShell(open)
  // Null while the cards are even.
  const [paneWidth, setPaneWidth] = useState(readPaneWidth)
  const [resizing, setResizing] = useState(false)
  // How far right of the pane's left edge the gutter was grabbed, so pressing it moves nothing.
  const grabRef = useRef(0)

  // Pointer capture keeps the drag going across a pane's iframe; this keeps the cursor and stops
  // the page's text being selected while it does.
  useEffect(() => {
    if (!resizing) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [resizing])

  const widthAt = (e: PointerEvent<HTMLDivElement>) => {
    const row = e.currentTarget.parentElement!.getBoundingClientRect()
    return clampPaneWidth(row.right - e.clientX + grabRef.current, row.width)
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    // The gutter's right edge is the pane's left.
    grabRef.current = e.currentTarget.getBoundingClientRect().right - e.clientX
    setResizing(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) setPaneWidth(widthAt(e))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    const width = e.type === 'pointercancel' ? paneWidth : widthAt(e)
    setPaneWidth(width)
    writePaneWidth(width)
    setResizing(false)
  }
  const resetWidth = () => {
    setPaneWidth(null)
    writePaneWidth(null)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? KEY_STEP : e.key === 'ArrowRight' ? -KEY_STEP : 0
    if (step === 0) return
    e.preventDefault()
    const row = e.currentTarget.parentElement!.getBoundingClientRect()
    const current = paneWidth ?? (row.width - GUTTER) / 2
    const width = clampPaneWidth(current + step, row.width)
    setPaneWidth(width)
    writePaneWidth(width)
  }

  const split = open && !paneExpanded
  return (
    <div className="flex h-full min-h-0">
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto ${open ? `${CONTENT_CARD_CLASS} max-md:hidden ${paneExpanded ? 'md:hidden' : ''}` : ''}`}>
        {children}
      </div>
      {split && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the pane"
          tabIndex={0}
          title="Drag to resize; double-click to even out"
          className="group/gutter relative flex shrink-0 cursor-col-resize touch-none justify-center focus-visible:outline-none max-md:hidden"
          style={{ width: GUTTER }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={resetWidth}
          onKeyDown={onKeyDown}
        >
          {/* A faint grip, shown while the gutter is pointed at, dragged or focused. */}
          <span className={`my-auto h-10 w-1 rounded-full bg-kumo-line opacity-0 transition-opacity group-hover/gutter:opacity-100 group-focus-visible/gutter:opacity-100 group-focus-visible/gutter:bg-kumo-ring ${resizing ? 'opacity-100' : ''}`} />
        </div>
      )}
      {open && (
        <div
          className={`flex min-h-0 min-w-0 flex-col overflow-hidden ${CONTENT_CARD_CLASS} ${split && paneWidth !== null ? 'shrink-0 max-md:!w-full' : 'flex-1'}`}
          // Clamped in CSS too, so a narrower window never squeezes the page below its minimum.
          style={split && paneWidth !== null
            ? { width: `clamp(${MIN_PANE_WIDTH}px, ${paneWidth}px, calc(100% - ${GUTTER + MIN_PAGE_WIDTH}px))` }
            : undefined}
        >
          {pane}
        </div>
      )}
    </div>
  )
}
