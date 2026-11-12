import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform, type Variants } from 'motion/react'
import { cn } from '@cloudflare/kumo/utils'
import { ResizeHandle } from '@/components/ResizeHandle'
import { clampSize, resistSize, settleSize } from '@/components/resizing'
import { SplitLayout } from './SplitLayout'
import { CLICK_SLOP, CLOSING_DIM, EDGE_GAP, OPENING_TIMING, useEdgeHint } from './useEdgeHint'
import { SCROLLBARS_AWAY, useScrollbarsAway } from './useScrollbarsAway'

export type AppShellProps = {
  /** The sidebar, drawn as a rail one button wide while it is `collapsed`. */
  sidebar: (collapsed: boolean) => ReactNode
  children: ReactNode
  /** What is open beside the page, if anything. */
  aside?: ReactNode
  /** The aside fills the window (see `SplitLayout`). */
  asideFullScreen?: boolean
  /** Shows the aside, when none is showing (see `SplitLayout`). */
  onOpenAside?: () => void
  /** The aside was dragged shut (see `SplitLayout`). */
  onCloseAside?: () => void
}

// The sidebar's width expanded, in pixels. An arrow key moves it by a step.
const SIDEBAR = { min: 208, initial: 248, max: 400, step: 8 }
// Collapsed, it is a rail one button wide, with room for the button's ring.
const RAIL = 40
// Dragged narrower than midway between the rail and its narrowest expanded, the sidebar collapses
// to the rail, and dragged back past there it expands again.
const COLLAPSES_AT = (RAIL + SIDEBAR.min) / 2
// Dragged narrower than this share of the rail, the sidebar is hidden when let go.
const HIDES_AT = 0.6
// Pulled out of the edge by at least this many pixels, the sidebar opens when let go.
const OPENS_AT = RAIL / 2
const GAP = 12
// The frame's own padding, which is the room past the gap at the window's edge.
const INSET = 8
// Between the rail and expanded, which is a jump in width when dragged across.
const SNAP_TIMING = { type: 'spring', duration: 0.3, bounce: 0.1 } as const
// Between the rail and expanded, what was in the sidebar goes before the other comes, rather than
// the two showing through each other: out quickly, then in, coming into focus as what arrives in
// a conversation does (`Arrival.css`). `instant` with nothing to see it, such as while hidden.
const SWAP: Variants = {
  away: (instant: boolean) => instant
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, filter: 'blur(2px)', transition: { duration: 0.1, ease: 'easeIn' } },
  here: (instant: boolean) => instant
    ? { opacity: 1, filter: 'blur(0px)', transition: { duration: 0 } }
    : { opacity: 1, filter: 'blur(0px)', transition: { duration: 0.2, ease: 'easeOut' } },
}

/** One layout of what is in the sidebar, the rail or expanded, which stays for as long as going takes. */
const SidebarLayout = ({ instant, children }: { instant: boolean; children: ReactNode }) => {
  const isPresent = useIsPresent()
  const element = useRef<HTMLDivElement>(null)
  const width = useMotionValue<number | 'auto'>('auto')
  // Going, it keeps the width it had, rather than being laid out again as the sidebar changes
  // width under it. Measured before paint, from the commit that let it go.
  useLayoutEffect(() => {
    if (!isPresent) width.jump(element.current!.offsetWidth)
  }, [isPresent, width])

  return (
    <motion.div
      ref={element}
      custom={instant}
      variants={SWAP}
      initial="away"
      animate="here"
      exit="away"
      style={{ width }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {children}
    </motion.div>
  )
}

/**
 * The application frame: the sidebar, then the page and whatever is open beside it (see
 * `SplitLayout`). The gap after the sidebar is dragged to set its width (see `ResizeHandle`).
 *
 * Dragged well past its narrowest, the sidebar collapses to a rail of icons, and dragged out again
 * it expands. Dragged well past the rail, it dims, and is hidden when let go. A hidden sidebar is
 * had back from the window's near edge, as `SplitLayout`'s aside is from the far one: the pointer
 * reaching the edge moves the page in a little and brings a handle out there, as hiding the
 * sidebar does for a moment, to show where it went. Clicking the handle shows the sidebar as it
 * was, and pulling it out opens the rail, then the sidebar, as far as it is pulled.
 */
export const AppShell = ({ sidebar, children, aside, asideFullScreen = false, onOpenAside, onCloseAside }: AppShellProps) => {
  const reduceMotion = useReducedMotion() ?? false
  const [collapsed, setCollapsed] = useState(false)
  const [hidden, setHidden] = useState(false)
  // The width expanded, where it rests: for assistive technology, and to expand to from the rail.
  // Not followed while it is dragged.
  const [rest, setRest] = useState(SIDEBAR.initial)
  // Motion values, so that dragging renders nothing again: the width it is laid out at (the
  // rail's, collapsed), what is left of a jump between the rail and expanded, how much of the rail
  // is dragged under the edge, how far it is open, how far the gap is held open at the edge with
  // it hidden, and how far it has dimmed.
  const size = useMotionValue(SIDEBAR.initial)
  const snap = useMotionValue(0)
  const tuck = useMotionValue(0)
  const open = useMotionValue(1)
  const peek = useMotionValue(0)
  const dim = useMotionValue(0)
  const closes = useRef(false)
  // What is in the sidebar keeps its width as it goes, and slides out under the edge.
  const contentWidth = useTransform(() => size.get() + snap.get())
  const width = useTransform(() => (contentWidth.get() - tuck.get()) * open.get())
  // Clipped only while it is narrower than what is in it, which leaves focus rings alone otherwise.
  const overflow = useTransform(() => (open.get() < 1 || snap.get() !== 0 || tuck.get() > 0 ? 'hidden' : 'visible'))
  const contentOpacity = useTransform(() => clampSize((open.get() - 0.4) / 0.6, 0, 1) * (1 - CLOSING_DIM * dim.get()))
  // The edge's gap becomes the gap after the sidebar as it opens.
  const gap = useTransform(() => EDGE_GAP * peek.get() * (1 - open.get()) + GAP * open.get())
  // At the edge the handle is as far from the page as from the window's edge.
  const handleShift = useTransform(open, (amount) => (-(1 - amount) * INSET) / 2)
  // The sidebar's width resizes the page beside it too.
  const frame = useRef<HTMLDivElement>(null)
  const scrollbars = useScrollbarsAway(frame)
  useMotionValueEvent(width, 'change', scrollbars.moved)
  useMotionValueEvent(gap, 'change', scrollbars.moved)
  const hinting = useEdgeHint(!hidden)
  // The drag under way: the width when the handle was taken hold of, whether that was at the edge
  // with the sidebar hidden, whether it was collapsed then and is now, and the furthest the
  // pointer has been from there.
  const drag = useRef({ from: 0, opening: false, wasCollapsed: false, collapsed: false, moved: 0 })
  const openedAt = useRef(0)

  /** Lays the sidebar out as the rail or expanded, `to` wide, springing there from where it is. */
  const relayout = (toCollapsed: boolean, to: number) => {
    const from = contentWidth.get()
    setCollapsed(toCollapsed)
    size.jump(to)
    snap.jump(from - to)
    if (reduceMotion || hidden) snap.jump(0)
    else animate(snap, 0, SNAP_TIMING)
  }
  /** Brings the sidebar to rest as it is now: on the rail, or within its limits expanded. */
  const settle = (asCollapsed: boolean) => {
    if (asCollapsed) return settleSize(size, RAIL, reduceMotion)
    const to = clampSize(size.get(), SIDEBAR.min, SIDEBAR.max)
    setRest(to)
    settleSize(size, to, reduceMotion)
  }
  const setCloses = (value: boolean) => {
    if (closes.current === value) return
    closes.current = value
    if (reduceMotion) dim.jump(value ? 1 : 0)
    else animate(dim, value ? 1 : 0, { duration: 0.15 })
  }
  const setOpen = (to: 0 | 1) => {
    if (reduceMotion) open.jump(to)
    else animate(open, to, OPENING_TIMING)
  }

  // It goes as it is, dimmed if it was dragged shut, and is as wide as before the next time.
  const hide = () => {
    closes.current = false
    setHidden(true)
    setOpen(0)
  }
  const show = (asCollapsed: boolean) => {
    openedAt.current = performance.now()
    dim.jump(0)
    setHidden(false)
    relayout(asCollapsed, asCollapsed ? RAIL : rest)
    settleSize(tuck, 0, reduceMotion)
    setOpen(1)
  }

  const dragStart = () => {
    scrollbars.hold()
    open.stop()
    tuck.stop()
    const opening = hidden
    const current = contentWidth.get()
    drag.current = { from: opening ? 0 : current - tuck.get(), opening, wasCollapsed: collapsed, collapsed, moved: 0 }
    // At full strength, pulled out of the edge.
    if (opening) dim.jump(0)
    size.jump(opening ? (collapsed ? RAIL : rest) : current)
    snap.jump(0)
  }

  const dragTo = (offset: number) => {
    const { from, opening } = drag.current
    const wanted = from + offset
    drag.current.moved = Math.max(drag.current.moved, Math.abs(offset))
    // Short of the slop it is only a click, which shows the sidebar as it was. Pulled further, it
    // is the rail that comes out first.
    if (opening && drag.current.moved < CLICK_SLOP) return
    if (opening) open.set(clampSize(wanted / RAIL, 0, 1))
    const toCollapsed = wanted < COLLAPSES_AT
    // Narrower than the rail, the rail does not resist: it follows the pointer out under the edge.
    tuck.set(toCollapsed && !opening ? clampSize(RAIL - wanted, 0, RAIL) : 0)
    const to = !toCollapsed
      ? resistSize(wanted, SIDEBAR.min, SIDEBAR.max)
      : wanted < RAIL ? RAIL : resistSize(wanted, RAIL, RAIL)
    if (toCollapsed === drag.current.collapsed) size.set(to)
    else {
      drag.current.collapsed = toCollapsed
      relayout(toCollapsed, to)
    }
    setCloses(!opening && wanted < RAIL * HIDES_AT)
  }

  const dragEnd = () => {
    scrollbars.release()
    const { opening, moved, wasCollapsed, collapsed: nowCollapsed } = drag.current
    if (opening) {
      if (moved < CLICK_SLOP) return show(wasCollapsed)
      if (width.get() < OPENS_AT) return settleSize(open, 0, reduceMotion)
      // Carrying on opening from where it was let go.
      openedAt.current = performance.now()
      setHidden(false)
      setOpen(1)
      return settle(nowCollapsed)
    }
    if (closes.current) return hide()
    settleSize(tuck, 0, reduceMotion)
    settle(nowCollapsed)
  }

  const step = (direction: -1 | 1) => {
    if (hidden) {
      if (direction === 1) show(collapsed)
      return
    }
    if (collapsed) {
      if (direction === 1) relayout(false, rest)
      else hide()
      return
    }
    const to = size.get() + direction * SIDEBAR.step
    if (to < SIDEBAR.min) return relayout(true, RAIL)
    const clamped = clampSize(to, SIDEBAR.min, SIDEBAR.max)
    size.jump(clamped)
    setRest(clamped)
  }

  // Expanded as it started out. Not by the second click of two that opened it.
  const reset = () => {
    if (hidden || performance.now() - openedAt.current < 500) return
    setRest(SIDEBAR.initial)
    if (collapsed) relayout(false, SIDEBAR.initial)
    else settleSize(size, SIDEBAR.initial, reduceMotion)
  }

  return (
    <div ref={frame} className={cn('flex h-full p-2', SCROLLBARS_AWAY)}>
      <motion.aside style={{ width, overflow }} inert={asideFullScreen || hidden} className="flex shrink-0 justify-end">
        <motion.div style={{ width: contentWidth, opacity: contentOpacity }} className="flex shrink-0 flex-col">
          <AnimatePresence mode="wait" initial={false} custom={reduceMotion || hidden}>
            <SidebarLayout key={collapsed ? 'rail' : 'expanded'} instant={reduceMotion || hidden}>
              {sidebar(collapsed)}
            </SidebarLayout>
          </AnimatePresence>
        </motion.div>
      </motion.aside>
      <motion.div
        style={{ width: gap }}
        inert={asideFullScreen}
        className="relative z-20 shrink-0"
        onPointerEnter={() => scrollbars.pointerInGap(true)}
        onPointerLeave={() => scrollbars.pointerInGap(false)}
      >
        <motion.div style={{ x: handleShift }} className="absolute inset-y-0 left-1/2 w-0">
          <ResizeHandle
            aria-label="Resize sidebar"
            value={hidden ? 0 : collapsed ? RAIL : Math.round(rest)}
            min={0}
            max={SIDEBAR.max}
            edge={hidden ? 'left' : undefined}
            hint={hinting}
            // With the sidebar open, holding the edge's gap open changes nothing that is seen.
            onReach={(reached) => settleSize(peek, reached ? 1 : 0, reduceMotion || (reached && open.get() >= 1))}
            onDragStart={dragStart}
            onDrag={dragTo}
            onDragEnd={dragEnd}
            onStep={step}
            onReset={reset}
          />
        </motion.div>
      </motion.div>
      {/* The inset is this frame's own padding. */}
      <SplitLayout aside={aside} asideFullScreen={asideFullScreen} onOpenAside={onOpenAside} onCloseAside={onCloseAside} edgeInset={INSET}>
        {children}
      </SplitLayout>
    </div>
  )
}
